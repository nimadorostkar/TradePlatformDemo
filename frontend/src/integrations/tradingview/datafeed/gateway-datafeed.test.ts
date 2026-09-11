import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SymbolSuffixPolicy } from '@/integrations/gateway/mappers/symbol-suffix';
import type { GatewaySubscriptionPool } from '@/integrations/gateway/websocket/subscription-pool';
import type { MarketApi } from '@/integrations/gateway/api/market-api';
import type { LibrarySymbolInfo, ResolutionString } from '../types';
import {
  aggregateIntradayBars,
  GatewayDatafeed,
  looksLikeRawM1,
  matchesSymbolType,
} from './gateway-datafeed';

/** Records every subscription the datafeed opens against the pool. */
function fakePool() {
  const opened: Array<{ symbol: string; family: string }> = [];
  const released: string[] = [];
  const frames: Array<(frame: unknown, meta: { receivedAt: number }) => void> = [];
  const statuses: Array<((status: { state: string }) => void) | undefined> = [];

  const pool = {
    subscribe: vi.fn(
      (
        params: { family: string; symbol?: string },
        onFrame: (frame: unknown, meta: { receivedAt: number }) => void,
        onStatus?: (status: { state: string }) => void,
      ) => {
        const symbol = params.symbol ?? '';
        opened.push({ symbol, family: params.family });
        frames.push(onFrame);
        statuses.push(onStatus);
        return () => released.push(symbol);
      },
    ),
  } as unknown as GatewaySubscriptionPool;

  /** Delivers a frame the way the pool does, with receive metadata. */
  const push = (index: number, frame: unknown) =>
    frames[index]?.(frame, { receivedAt: Date.now() });

  return { pool, opened, released, frames, statuses, push };
}

/**
 * Bar-stream openings only.
 *
 * A bar subscription also opens a quote stream to drive the forming candle, so
 * counting raw openings would conflate the two.
 */
function barStreams(opened: Array<{ symbol: string; family: string }>) {
  return opened.filter((o) => o.family === 'intraday-bar' || o.family === 'daily-bar');
}

const symbolInfo = (name: string) => ({ name, ticker: name }) as LibrarySymbolInfo;

let policy = new SymbolSuffixPolicy('.');

beforeEach(() => {
  policy = new SymbolSuffixPolicy('.');
});

function createDatafeed(pool: GatewaySubscriptionPool, market = {} as MarketApi) {
  return new GatewayDatafeed({
    market,
    pool,
    getSuffixPolicy: () => policy,
  });
}

describe('GatewayDatafeed subscriptions', () => {
  it('subscribes bars using the account suffix', () => {
    const { pool, opened } = fakePool();
    const datafeed = createDatafeed(pool);

    datafeed.subscribeBars(symbolInfo('EURUSD'), '1' as ResolutionString, vi.fn(), 'guid-1');

    expect(barStreams(opened)).toEqual([{ symbol: 'EURUSD.', family: 'intraday-bar' }]);
    // The forming candle is quote-driven, so the same suffixed symbol is also
    // subscribed for ticks.
    expect(opened).toContainEqual({ symbol: 'EURUSD.', family: 'quote' });
    datafeed.dispose();
  });

  it('uses the daily stream for daily resolutions', () => {
    const { pool, opened } = fakePool();
    const datafeed = createDatafeed(pool);

    datafeed.subscribeBars(symbolInfo('XAUUSD'), '1D' as ResolutionString, vi.fn(), 'guid-1');

    expect(opened[0]?.family).toBe('daily-bar');
    // A daily bucket boundary is a broker-timezone question, so daily charts
    // deliberately do NOT take a quote stream.
    expect(opened.some((o) => o.family === 'quote')).toBe(false);
    datafeed.dispose();
  });

  it('re-points bar streams at the new group after an account switch', () => {
    // The suffix is per account GROUP. Without this the chart would keep
    // streaming the PREVIOUS group's instrument — a different book, with a
    // different spread, under the new account's name.
    const { pool, opened, released } = fakePool();
    const datafeed = createDatafeed(pool);
    const onReset = vi.fn();

    datafeed.subscribeBars(
      symbolInfo('EURUSD'),
      '1' as ResolutionString,
      vi.fn(),
      'guid-1',
      onReset,
    );
    expect(barStreams(opened)).toHaveLength(1);
    expect(barStreams(opened)[0]?.symbol).toBe('EURUSD.');

    // ECN (".") → Standard ("!")
    policy = new SymbolSuffixPolicy('!');
    datafeed.resubscribeForAccountChange();

    expect(released).toContain('EURUSD.');
    expect(barStreams(opened)).toHaveLength(2);
    expect(barStreams(opened)[1]?.symbol).toBe('EURUSD!');

    // The cached history belongs to the old instrument and must be dropped.
    expect(onReset).toHaveBeenCalledTimes(1);

    datafeed.dispose();
  });

  it('re-points quote streams after an account switch', () => {
    const { pool, opened, released } = fakePool();
    const datafeed = createDatafeed(pool);

    datafeed.subscribeQuotes([], ['EURUSD', 'XAUUSD'], vi.fn(), 'quotes-1');
    expect(opened.map((o) => o.symbol)).toEqual(['EURUSD.', 'XAUUSD.']);

    policy = new SymbolSuffixPolicy('!');
    datafeed.resubscribeForAccountChange();

    expect(released).toEqual(expect.arrayContaining(['EURUSD.', 'XAUUSD.']));
    expect(opened.slice(2).map((o) => o.symbol)).toEqual(['EURUSD!', 'XAUUSD!']);

    datafeed.dispose();
  });

  it('handles an account whose group takes no suffix', () => {
    const { pool, opened } = fakePool();
    const datafeed = createDatafeed(pool);

    datafeed.subscribeBars(symbolInfo('EURUSD'), '1' as ResolutionString, vi.fn(), 'guid-1');

    policy = new SymbolSuffixPolicy(''); // ECNPRO
    datafeed.resubscribeForAccountChange();

    expect(barStreams(opened)[1]?.symbol).toBe('EURUSD');
    datafeed.dispose();
  });

  it('replaces rather than duplicates a subscription reusing the same GUID', () => {
    const { pool, opened, released } = fakePool();
    const datafeed = createDatafeed(pool);

    datafeed.subscribeBars(symbolInfo('EURUSD'), '1' as ResolutionString, vi.fn(), 'guid-1');
    datafeed.subscribeBars(symbolInfo('XAUUSD'), '1' as ResolutionString, vi.fn(), 'guid-1');

    expect(released).toContain('EURUSD.');
    expect(barStreams(opened)).toHaveLength(2);
    datafeed.dispose();
  });

  it('releases every stream on dispose', () => {
    const { pool, released } = fakePool();
    const datafeed = createDatafeed(pool);

    datafeed.subscribeBars(symbolInfo('EURUSD'), '1' as ResolutionString, vi.fn(), 'guid-1');
    datafeed.subscribeQuotes([], ['XAUUSD'], vi.fn(), 'quotes-1');

    datafeed.dispose();

    expect(released).toEqual(expect.arrayContaining(['EURUSD.', 'XAUUSD.']));
  });
});

describe('forming candle', () => {
  const minute = 60;
  const quote = (price: number, timeSeconds: number | null) => [
    {
      symbolname: 'EURUSD.',
      status: 'Ok',
      bid: price,
      ask: price + 0.2,
      lastprice: price,
      volume: 1,
      ...(timeSeconds === null ? {} : { time: timeSeconds }),
    },
  ];

  /** Subscribes and seeds the current bar from the bar stream. */
  function subscribedAt5m() {
    const fake = fakePool();
    const datafeed = createDatafeed(fake.pool);
    const onTick = vi.fn();
    datafeed.subscribeBars(symbolInfo('EURUSD'), '5' as ResolutionString, onTick, 'guid-5m');
    fake.push(0, [{ time: 0, open: '10', high: '12', low: '9', close: '11', volume: '2' }]);
    onTick.mockClear();
    return { ...fake, datafeed, onTick };
  }

  it('extends the current candle from a quote inside the same bucket', () => {
    const { push, datafeed, onTick } = subscribedAt5m();

    push(1, quote(13, 2 * minute));

    expect(onTick).toHaveBeenLastCalledWith(
      expect.objectContaining({ time: 0, open: 10, high: 13, low: 9, close: 13 }),
    );
    datafeed.dispose();
  });

  it('opens the next candle when the broker time crosses the bucket', () => {
    const { push, datafeed, onTick } = subscribedAt5m();

    push(1, quote(14, 6 * minute));

    expect(onTick).toHaveBeenLastCalledWith(
      expect.objectContaining({ time: 5 * minute * 1000, open: 14, high: 14, low: 14, close: 14 }),
    );
    datafeed.dispose();
  });

  it('buckets on broker time, not the local clock', () => {
    // The trader's machine sits in the NEXT bucket; the broker's stamp does not.
    // Bucketing on Date.now() here would open a candle the server disagrees with.
    const { push, datafeed, onTick } = subscribedAt5m();
    vi.spyOn(Date, 'now').mockReturnValue(90 * minute * 1000);

    push(1, quote(13, 2 * minute));

    expect(onTick).toHaveBeenLastCalledWith(expect.objectContaining({ time: 0 }));
    vi.restoreAllMocks();
    datafeed.dispose();
  });

  it('ignores a quote carrying no broker timestamp', () => {
    const { push, datafeed, onTick } = subscribedAt5m();

    push(1, quote(13, null));

    expect(onTick).not.toHaveBeenCalled();
    datafeed.dispose();
  });

  it('never lets an authoritative bar shrink a wick the ticks already drew', () => {
    const { push, datafeed, onTick } = subscribedAt5m();

    push(1, quote(20, 2 * minute)); // tick pushes the high to 20
    // The server's rolled M1 bar knows nothing about ticks between polls.
    push(0, [{ time: 0, open: '10', high: '12', low: '9', close: '11', volume: '4' }]);

    expect(onTick).toHaveBeenLastCalledWith(expect.objectContaining({ time: 0, high: 20 }));
    datafeed.dispose();
  });
});

describe('backfill after an interruption', () => {
  it('refetches from the newest held bar when the stream reconnects', async () => {
    const { pool, push, statuses } = fakePool();
    const intradayBars = vi.fn().mockResolvedValue([]);
    const datafeed = createDatafeed(pool, { intradayBars } as unknown as MarketApi);

    datafeed.subscribeBars(symbolInfo('EURUSD'), '1' as ResolutionString, vi.fn(), 'guid-1');
    push(0, [{ time: 600, open: '1', high: '1', low: '1', close: '1', volume: '1' }]);

    statuses[0]?.({ state: 'reconnecting' });
    statuses[0]?.({ state: 'connected' });
    await vi.waitFor(() => expect(intradayBars).toHaveBeenCalled());

    // `from` is the newest bar we hold, in seconds — not 0, which would return
    // only the short live window and leave the gap open forever.
    expect(intradayBars).toHaveBeenCalledWith(expect.objectContaining({ from: 600 }));
    datafeed.dispose();
  });

  it('does not backfill on a first connect', async () => {
    const { pool, statuses } = fakePool();
    const intradayBars = vi.fn().mockResolvedValue([]);
    const datafeed = createDatafeed(pool, { intradayBars } as unknown as MarketApi);

    datafeed.subscribeBars(symbolInfo('EURUSD'), '1' as ResolutionString, vi.fn(), 'guid-1');
    statuses[0]?.({ state: 'connected' });

    expect(intradayBars).not.toHaveBeenCalled();
    datafeed.dispose();
  });

  it('replays the healed bars into the chart in chronological order', async () => {
    const { pool, push, statuses } = fakePool();
    const intradayBars = vi.fn().mockResolvedValue([
      { time: 600, open: '1', high: '1', low: '1', close: '1', volume: '1' },
      { time: 660, open: '2', high: '2', low: '2', close: '2', volume: '1' },
      { time: 720, open: '3', high: '3', low: '3', close: '3', volume: '1' },
    ]);
    const onTick = vi.fn();
    const datafeed = createDatafeed(pool, { intradayBars } as unknown as MarketApi);

    datafeed.subscribeBars(symbolInfo('EURUSD'), '1' as ResolutionString, onTick, 'guid-1');
    push(0, [{ time: 600, open: '1', high: '1', low: '1', close: '1', volume: '1' }]);
    onTick.mockClear();

    statuses[0]?.({ state: 'disconnected' });
    statuses[0]?.({ state: 'connected' });
    await vi.waitFor(() => expect(onTick).toHaveBeenCalledTimes(3));

    expect(onTick.mock.calls.map(([bar]) => bar.time)).toEqual([600_000, 660_000, 720_000]);
    datafeed.dispose();
  });
});

describe('intraday aggregation', () => {
  it('rolls M1 history into aligned OHLCV candles for the selected timeframe', () => {
    const minute = 60_000;
    const bars = aggregateIntradayBars(
      [
        { time: 0, open: 10, high: 12, low: 9, close: 11, volume: 2 },
        { time: minute, open: 11, high: 14, low: 10, close: 13, volume: 3 },
        { time: 2 * minute, open: 13, high: 15, low: 8, close: 9, volume: 5 },
        { time: 5 * minute, open: 20, high: 21, low: 19, close: 20, volume: 7 },
      ],
      '5' as ResolutionString,
    );

    expect(bars).toEqual([
      { time: 0, open: 10, high: 15, low: 8, close: 9, volume: 10 },
      { time: 5 * minute, open: 20, high: 21, low: 19, close: 20, volume: 7 },
    ]);
  });

  it('detects raw M1 by bar spacing so an old gateway still gets folded client-side', () => {
    const minute = 60_000;
    const m1 = [
      { time: 0, open: 1, high: 1, low: 1, close: 1 },
      { time: minute, open: 1, high: 1, low: 1, close: 1 },
    ];
    const aggregated = [
      { time: 0, open: 1, high: 1, low: 1, close: 1 },
      { time: 5 * minute, open: 1, high: 1, low: 1, close: 1 },
    ];
    expect(looksLikeRawM1(m1, '5' as ResolutionString)).toBe(true);
    expect(looksLikeRawM1(aggregated, '5' as ResolutionString)).toBe(false);
    // M1 charts never fold, whatever the spacing.
    expect(looksLikeRawM1(m1, '1' as ResolutionString)).toBe(false);
  });

  it('keeps the forming candle on the SERVER bar grid, not the UTC-floored one', async () => {
    // A UTC+3 broker cuts 2h buckets at odd UTC hours; the server bar time IS
    // the grid. Flooring against UTC would put the forming candle one hour off
    // the history under it.
    const { pool, frames } = fakePool();
    const hourMs = 3_600_000;
    const market = {
      intradayBars: vi
        .fn()
        // First call: the history window, already aggregated, anchored at 01:00.
        .mockResolvedValueOnce([{ time: 3_600, open: '1', high: '2', low: '1', close: '2' }])
        // Second call: the active-bucket M1 constituent fetch.
        .mockResolvedValueOnce([]),
    } as unknown as MarketApi;
    const datafeed = createDatafeed(pool, market);

    await new Promise<void>((resolve, reject) => {
      void datafeed.getBars(
        symbolInfo('EURUSD'),
        '120' as ResolutionString,
        { from: 0, to: 10_800, countBack: 10, firstDataRequest: true },
        () => resolve(),
        (error) => reject(new Error(String(error))),
      );
    });

    const onTick = vi.fn();
    datafeed.subscribeBars(symbolInfo('EURUSD'), '120' as ResolutionString, onTick, 'guid-2h');
    // A live M1 bar 40 minutes into the bucket that started at 01:00.
    frames[0]?.([{ time: 6_000, open: '3', high: '4', low: '3', close: '4', volume: '1' }]);

    expect(onTick).toHaveBeenCalledTimes(1);
    const [bar] = onTick.mock.calls[0]!;
    expect(bar.time).toBe(hourMs); // 01:00 grid — not 00:00, which UTC flooring gives
    expect(bar).toMatchObject({ open: 1, high: 4, close: 4 });
    datafeed.dispose();
  });

  it('merges the live M1 window into history-seeded higher-timeframe candles', async () => {
    const { pool, frames } = fakePool();
    const minute = 60;
    const market = {
      intradayBars: vi.fn().mockResolvedValue([
        { time: 0, open: '10', high: '12', low: '9', close: '11', volume: '2' },
        { time: minute, open: '11', high: '14', low: '10', close: '13', volume: '3' },
        { time: 2 * minute, open: '13', high: '15', low: '8', close: '9', volume: '5' },
      ]),
    } as unknown as MarketApi;
    const datafeed = createDatafeed(pool, market);

    await new Promise<void>((resolve, reject) => {
      void datafeed.getBars(
        symbolInfo('EURUSD'),
        '5' as ResolutionString,
        { from: 0, to: 300, countBack: 100, firstDataRequest: true },
        () => resolve(),
        (error) => reject(new Error(String(error))),
      );
    });

    const onTick = vi.fn();
    datafeed.subscribeBars(symbolInfo('EURUSD'), '5' as ResolutionString, onTick, 'guid-5m');
    frames[0]?.([
      // Repeating minute 2 must replace it, not double-count its volume.
      { time: 2 * minute, open: '13', high: '16', low: '8', close: '14', volume: '6' },
      { time: 3 * minute, open: '14', high: '17', low: '13', close: '16', volume: '7' },
    ]);

    expect(onTick).toHaveBeenCalledWith({
      time: 0,
      open: 10,
      high: 17,
      low: 8,
      close: 16,
      volume: 18,
    });
    datafeed.dispose();
  });
});

describe('history pagination across market closures', () => {
  const period = (from: number, to: number) =>
    ({ from, to, countBack: 300, firstDataRequest: true }) as never;

  it('points the library at the previous bar instead of claiming no data', async () => {
    const { pool } = fakePool();
    // The weekend shape: the requested window holds only closed-market hours
    // (empty), while Friday's bars sit just before it. Answering noData here
    // would freeze every intraday chart onto "No data here" until Monday.
    // The lookback is answered from DAILY bars — a handful of rows — never a
    // multi-day M1 window the gateway would have to fan into many MT5 calls.
    const intradayBars = vi.fn().mockResolvedValue([]);
    const dailyBars = vi
      .fn()
      .mockResolvedValue([{ time: 900, open: 1, high: 1, low: 1, close: 1, volume: 1 }]);
    const datafeed = createDatafeed(pool, { intradayBars, dailyBars } as unknown as MarketApi);
    const onHistory = vi.fn();

    await datafeed.getBars(
      symbolInfo('EURUSD'),
      '1' as ResolutionString,
      period(1_000, 2_000),
      onHistory,
      vi.fn(),
    );

    // dayEnd (900 + 86_399) is past `before`, so the raw bar time is the hint.
    expect(onHistory).toHaveBeenCalledWith([], { noData: false, nextTime: 900_000 });
    expect(intradayBars).toHaveBeenCalledTimes(1);
    expect(dailyBars).toHaveBeenCalledTimes(1);
    expect(dailyBars).toHaveBeenCalledWith(
      expect.objectContaining({ to: 1_000, resolution: '1D' }),
    );
    datafeed.dispose();
  });

  it("projects a day-start daily bar to its day END so the day's intraday bars are covered", async () => {
    const { pool } = fakePool();
    const intradayBars = vi.fn().mockResolvedValue([]);
    // Real daily bars are stamped at day START; a window ending there would
    // miss the whole day's intraday bars.
    const dailyBars = vi
      .fn()
      .mockResolvedValue([{ time: 100, open: 1, high: 1, low: 1, close: 1, volume: 1 }]);
    const datafeed = createDatafeed(pool, { intradayBars, dailyBars } as unknown as MarketApi);
    const onHistory = vi.fn();

    await datafeed.getBars(
      symbolInfo('EURUSD'),
      '1' as ResolutionString,
      period(1_000_000, 1_010_000),
      onHistory,
      vi.fn(),
    );

    expect(onHistory).toHaveBeenCalledWith([], { noData: false, nextTime: 86_499_000 });
    datafeed.dispose();
  });

  it('performs ONE lookback per walk, serving later empty pages from the cache', async () => {
    const { pool } = fakePool();
    const intradayBars = vi.fn().mockResolvedValue([]);
    const dailyBars = vi
      .fn()
      .mockResolvedValue([{ time: 900, open: 1, high: 1, low: 1, close: 1, volume: 1 }]);
    const datafeed = createDatafeed(pool, { intradayBars, dailyBars } as unknown as MarketApi);
    const onHistory = vi.fn();

    await datafeed.getBars(
      symbolInfo('EURUSD'),
      '1' as ResolutionString,
      period(10_000, 12_000),
      onHistory,
      vi.fn(),
    );
    await datafeed.getBars(
      symbolInfo('EURUSD'),
      '1' as ResolutionString,
      period(8_000, 10_000),
      onHistory,
      vi.fn(),
    );

    // Two empty pages, one daily request: a slow gateway must not be asked
    // once per page while the library walks toward the data.
    expect(dailyBars).toHaveBeenCalledTimes(1);
    expect(onHistory).toHaveBeenNthCalledWith(2, [], { noData: false, nextTime: 900_000 });
    datafeed.dispose();
  });

  it('ends pagination only when the lookback is empty too', async () => {
    const { pool } = fakePool();
    const intradayBars = vi.fn().mockResolvedValue([]);
    const dailyBars = vi.fn().mockResolvedValue([]);
    const datafeed = createDatafeed(pool, { intradayBars, dailyBars } as unknown as MarketApi);
    const onHistory = vi.fn();

    await datafeed.getBars(
      symbolInfo('EURUSD'),
      '1' as ResolutionString,
      period(1_000, 2_000),
      onHistory,
      vi.fn(),
    );

    // Genuinely no data (or a dead symbol dialect): the honest give-up.
    expect(onHistory).toHaveBeenCalledWith([], { noData: true });
    datafeed.dispose();
  });

  it('does not look back when the window has bars', async () => {
    const { pool } = fakePool();
    const intradayBars = vi
      .fn()
      .mockResolvedValue([{ time: 1_500, open: 1, high: 1, low: 1, close: 1, volume: 1 }]);
    const dailyBars = vi.fn();
    const datafeed = createDatafeed(pool, { intradayBars, dailyBars } as unknown as MarketApi);
    const onHistory = vi.fn();

    await datafeed.getBars(
      symbolInfo('EURUSD'),
      '1' as ResolutionString,
      period(1_000, 2_000),
      onHistory,
      vi.fn(),
    );

    expect(dailyBars).not.toHaveBeenCalled();
    expect(onHistory).toHaveBeenCalledWith([expect.objectContaining({ time: 1_500_000 })], {
      noData: false,
    });
    datafeed.dispose();
  });

  it('a failed lookback ends pagination without erroring the healthy window', async () => {
    const { pool } = fakePool();
    const intradayBars = vi.fn().mockResolvedValue([]);
    const dailyBars = vi.fn().mockRejectedValue(new Error('gateway down'));
    const datafeed = createDatafeed(pool, { intradayBars, dailyBars } as unknown as MarketApi);
    const onHistory = vi.fn();
    const onError = vi.fn();

    await datafeed.getBars(
      symbolInfo('EURUSD'),
      '1' as ResolutionString,
      period(1_000, 2_000),
      onHistory,
      onError,
    );

    expect(onError).not.toHaveBeenCalled();
    expect(onHistory).toHaveBeenCalledWith([], { noData: true });
    datafeed.dispose();
  });
});

describe('resolveSymbol never leaves the chart waiting', () => {
  /**
   * Nothing is drawn until resolveSymbol answers, and the library asks for
   * bars only after it does — so an answer that never comes is a permanently
   * blank pane with no loading state and no error, and every later setSymbol
   * queues behind it. That is how a chart came to render one instrument while
   * the header, ticket and Details all named another.
   */
  it('errors out when the symbol record never arrives, instead of hanging', async () => {
    vi.useFakeTimers();
    try {
      const { pool } = fakePool();
      const market = {
        // A request that never settles — a wedged gateway, not a failing one.
        symbolInfo: vi.fn(() => new Promise(() => {})),
      } as unknown as MarketApi;

      const loading: number[] = [];
      const datafeed = new GatewayDatafeed({
        market,
        pool,
        getSuffixPolicy: () => policy,
        onHistoryLoading: (pending) => loading.push(pending),
      });

      const onResolve = vi.fn();
      const onError = vi.fn();
      void datafeed.resolveSymbol('EURUSD', onResolve, onError);

      // The pane reports itself busy immediately — before any bar request.
      expect(loading[0]).toBe(1);
      expect(onError).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(30_000);

      expect(onResolve).not.toHaveBeenCalled();
      expect(onError).toHaveBeenCalledTimes(1);
      // And the spinner is cleared, so the pane does not claim to be loading
      // something it has given up on.
      expect(loading[loading.length - 1]).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('answers exactly once when the record arrives before the deadline', async () => {
    vi.useFakeTimers();
    try {
      const { pool } = fakePool();
      const market = {
        symbolInfo: vi.fn().mockResolvedValue({
          name: 'EURUSD.',
          displayName: 'EURUSD',
          description: 'Euro vs US Dollar',
          type: 'FX',
          exchange: 'Broker',
          digits: 5,
          pricescale: 100_000,
          minMove: 1,
          session: '24x5',
          timezone: 'Etc/UTC',
          supportedResolutions: ['1'],
          currencyCode: 'USD',
          sector: null,
          industry: null,
        }),
      } as unknown as MarketApi;

      const loading: number[] = [];
      const datafeed = new GatewayDatafeed({
        market,
        pool,
        getSuffixPolicy: () => policy,
        onHistoryLoading: (pending) => loading.push(pending),
      });

      const onResolve = vi.fn();
      const onError = vi.fn();
      await datafeed.resolveSymbol('EURUSD', onResolve, onError);

      expect(onResolve).toHaveBeenCalledTimes(1);
      expect(onError).not.toHaveBeenCalled();
      expect(loading[loading.length - 1]).toBe(0);

      // The watchdog must not fire behind a symbol that already resolved.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(onError).not.toHaveBeenCalled();
      expect(onResolve).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('matchesSymbolType', () => {
  it('accepts everything when no filter is chosen', () => {
    expect(matchesSymbolType('Forex', '')).toBe(true);
  });

  it('matches the gateway vocabulary the filter word represents', () => {
    expect(matchesSymbolType('Forex', 'Forex')).toBe(true);
    expect(matchesSymbolType('Spot Metals', 'Metals')).toBe(true);
    expect(matchesSymbolType('Indices', 'Indices')).toBe(true);
    expect(matchesSymbolType('Cryptocurrencies', 'Crypto')).toBe(true);
  });

  it("still matches a type carrying another group's suffix marker", () => {
    expect(matchesSymbolType('Spot Metals#', 'Metals')).toBe(true);
    expect(matchesSymbolType('Indices.', 'Indices')).toBe(true);
  });

  it('rejects types outside the filter', () => {
    expect(matchesSymbolType('Forex', 'Metals')).toBe(false);
    expect(matchesSymbolType('Shares', 'Indices')).toBe(false);
  });
});

describe('getBars during a gateway outage', () => {
  const period = (firstDataRequest: boolean) =>
    ({ from: 1_000, to: 2_000, firstDataRequest, countBack: 300 }) as never;

  it('degrades a failed OLDER-history page to noData so the drawn series survives', async () => {
    const { pool } = fakePool();
    const dailyBars = vi.fn().mockRejectedValue(new Error('gateway 400'));
    const datafeed = createDatafeed(pool, { dailyBars } as unknown as MarketApi);

    const onHistory = vi.fn();
    const onError = vi.fn();
    await datafeed.getBars(
      symbolInfo('EURUSD'),
      '1W' as ResolutionString,
      period(false),
      onHistory,
      onError,
    );

    // The library discards an already-drawn series when any page errors
    // (2026-08-24 outage: first page served candles, the pre-coverage page
    // failed, chart went to "No data here"). "Ends here for now" keeps it.
    expect(onError).not.toHaveBeenCalled();
    expect(onHistory).toHaveBeenCalledWith([], { noData: true });
    datafeed.dispose();
  });

  it('still fails the FIRST page honestly — noData there would cache an empty chart', async () => {
    const { pool } = fakePool();
    const dailyBars = vi.fn().mockRejectedValue(new Error('gateway 400'));
    const datafeed = createDatafeed(pool, { dailyBars } as unknown as MarketApi);

    const onHistory = vi.fn();
    const onError = vi.fn();
    await datafeed.getBars(
      symbolInfo('EURUSD'),
      '1W' as ResolutionString,
      period(true),
      onHistory,
      onError,
    );

    expect(onError).toHaveBeenCalled();
    expect(onHistory).not.toHaveBeenCalled();
    datafeed.dispose();
  });
});

describe('backfill anchor follows delivered history', () => {
  // History goes straight to the library, bypassing newestBar — the backfill
  // anchor. An anchor stuck behind the library's own cache tail replays bars
  // the library rejects with a "time violation" on every reconnect
  // (2026-08-24 outage cycles, weekly chart).
  it('anchors the reconnect backfill at the last HISTORY bar, not before it', async () => {
    const { pool, statuses } = fakePool();
    const dailyBars = vi
      .fn()
      .mockResolvedValueOnce([
        { time: 600, open: '1', high: '1', low: '1', close: '1', volume: null },
        { time: 1200, open: '2', high: '2', low: '2', close: '2', volume: null },
      ])
      .mockResolvedValue([]);
    const datafeed = createDatafeed(pool, { dailyBars } as unknown as MarketApi);

    datafeed.subscribeBars(symbolInfo('EURUSD'), '1W' as ResolutionString, vi.fn(), 'guid-w');

    // The library then loads history; the datafeed must lift the anchor.
    await datafeed.getBars(
      symbolInfo('EURUSD'),
      '1W' as ResolutionString,
      { from: 0, to: 2000, firstDataRequest: true, countBack: 10 } as never,
      vi.fn(),
      vi.fn(),
    );

    statuses[0]?.({ state: 'reconnecting' });
    statuses[0]?.({ state: 'connected' });
    await vi.waitFor(() => expect(dailyBars).toHaveBeenCalledTimes(2));

    // The heal must start at the newest bar the library already holds.
    expect(dailyBars).toHaveBeenLastCalledWith(expect.objectContaining({ from: 1200 }));
    datafeed.dispose();
  });
});

describe('daily stream bars on weekly/monthly series', () => {
  const weekMs = 7 * 86_400_000;

  function weeklySub() {
    const { pool, push } = fakePool();
    const dailyBars = vi
      .fn()
      .mockResolvedValue([
        { time: 1_000_000, open: '1', high: '1.2', low: '0.9', close: '1.1', volume: null },
      ]);
    const datafeed = createDatafeed(pool, { dailyBars } as unknown as MarketApi);
    const onTick = vi.fn();
    datafeed.subscribeBars(symbolInfo('EURUSD'), '1W' as ResolutionString, onTick, 'guid-w');
    return { datafeed, push, onTick };
  }

  it('holds the stream until history has seeded the floor', () => {
    const { datafeed, push, onTick } = weeklySub();
    // A day-stamped frame lands BEFORE any history — the residual
    // once-per-boot "time violation" of Issue 2.
    push(0, [{ time: 999_000, open: '1', high: '1', low: '1', close: '1', volume: null }]);
    expect(onTick).not.toHaveBeenCalled();
    datafeed.dispose();
  });

  it('folds a mid-week day bar into the current weekly candle', async () => {
    const { datafeed, push, onTick } = weeklySub();
    await datafeed.getBars(
      symbolInfo('EURUSD'),
      '1W' as ResolutionString,
      { from: 0, to: 2_000_000, firstDataRequest: true, countBack: 10 } as never,
      vi.fn(),
      vi.fn(),
    );
    // Tuesday's day bar: one day into the week bucket that starts at 1e9 ms.
    push(0, [
      {
        time: (1_000_000_000 + 86_400_000) / 1000,
        open: '2',
        high: '3',
        low: '0.5',
        close: '2.5',
        volume: null,
      },
    ]);
    expect(onTick).toHaveBeenLastCalledWith(
      expect.objectContaining({ time: 1_000_000_000, open: 1, high: 3, low: 0.5, close: 2.5 }),
    );
    datafeed.dispose();
  });

  it('opens the next weekly bucket on the grid when the week rolls over', async () => {
    const { datafeed, push, onTick } = weeklySub();
    await datafeed.getBars(
      symbolInfo('EURUSD'),
      '1W' as ResolutionString,
      { from: 0, to: 2_000_000, firstDataRequest: true, countBack: 10 } as never,
      vi.fn(),
      vi.fn(),
    );
    // Next Monday's day bar: exactly one week past the held bucket.
    push(0, [
      {
        time: (1_000_000_000 + weekMs) / 1000,
        open: '2',
        high: '2.2',
        low: '1.9',
        close: '2.1',
        volume: null,
      },
    ]);
    expect(onTick).toHaveBeenLastCalledWith(
      expect.objectContaining({ time: 1_000_000_000 + weekMs, open: 2 }),
    );
    datafeed.dispose();
  });
});
