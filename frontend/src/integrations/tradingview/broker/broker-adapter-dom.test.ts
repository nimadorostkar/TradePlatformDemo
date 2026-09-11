import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DecimalString } from '@/domain/common/decimal';
import type { TradingSymbol } from '@/domain/common/models';
import type { TradingService } from '@/domain/orders/trading-service';
import type { MarketDepthDto } from '@/integrations/gateway/contracts/schemas';
import { NO_SUFFIX_POLICY, SymbolSuffixPolicy } from '@/integrations/gateway/mappers/symbol-suffix';
import { useSessionStore } from '@/stores/session-store';
import { GatewayBrokerAdapter } from './broker-adapter';
import type { IBrokerConnectionAdapterHost } from '../types';

/**
 * TradingView DOM subscription behaviour.
 *
 * These are the properties that keep the built-in DOM safe against a
 * real-money gateway: polls that cannot overlap, teardown that cannot leak a
 * late update, and depth snapshots that are filtered and sorted before the
 * library may offer them as clickable prices.
 */

const d = (v: string) => v as DecimalString;

function symbol(): TradingSymbol {
  return {
    name: 'EURUSD.',
    displayName: 'EURUSD',
    description: 'Euro vs US Dollar',
    type: 'FX',
    exchange: 'Broker',
    digits: 5,
    pricescale: 100000,
    minMove: 1,
    volumeMin: d('0.01'),
    volumeMax: d('100'),
    volumeStep: d('0.01'),
    contractSize: d('100000'),
    tickSize: d('0.00001'),
    tickValue: d('1'),
    currencyCode: 'USD',
    session: '24x5',
    timezone: 'Etc/UTC',
    supportedResolutions: ['1'],
    sector: null,
    industry: null,
  };
}

function fakeHost() {
  return {
    getSymbolMinTick: vi.fn().mockResolvedValue(0.00001),
    equityUpdate: vi.fn(),
    orderUpdate: vi.fn(),
    positionUpdate: vi.fn(),
    showNotification: vi.fn(),
    domUpdate: vi.fn(),
  } as unknown as IBrokerConnectionAdapterHost & { domUpdate: ReturnType<typeof vi.fn> };
}

function depthDto(overrides: Partial<MarketDepthDto> = {}): MarketDepthDto {
  return {
    symbol: 'EURUSD',
    volumeUnit: 'lots',
    // The gateway sends bids BEST-FIRST, i.e. descending.
    bids: [
      { price: d('1.1000'), volume: d('10'), market: false },
      { price: d('1.0999'), volume: d('25'), market: false },
    ],
    asks: [
      { price: d('1.1002'), volume: d('18'), market: false },
      { price: d('1.1003'), volume: d('40'), market: false },
    ],
    crossed: false,
    unclassified: 0,
    ...overrides,
  } as MarketDepthDto;
}

function createAdapter(
  host: ReturnType<typeof fakeHost>,
  loadMarketDepth: (gatewaySymbol: string, signal: AbortSignal) => Promise<MarketDepthDto>,
  onDepthError?: (error: unknown) => void,
) {
  return new GatewayBrokerAdapter({
    host,
    trading: {} as TradingService,
    resolveSymbol: async () => symbol(),
    loadMarketDepth,
    onDepthError,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  useSessionStore.setState({
    activeLogin: '1001',
    suffixPolicy: NO_SUFFIX_POLICY,
    readOnly: false,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('subscribeDOM', () => {
  it('emits a full, ascending-sorted snapshot immediately', async () => {
    const host = fakeHost();
    const load = vi.fn().mockResolvedValue(depthDto());
    const adapter = createAdapter(host, load);

    adapter.subscribeDOM('EURUSD');
    await vi.advanceTimersByTimeAsync(0);

    expect(host.domUpdate).toHaveBeenCalledTimes(1);
    const [reportedSymbol, dom] = host.domUpdate.mock.calls[0]!;
    expect(reportedSymbol).toBe('EURUSD');
    expect(dom).toEqual({
      snapshot: true,
      // Both sides ascending, per the vendored DOMData contract — the gateway's
      // best-first bid order must have been reversed.
      bids: [
        { price: 1.0999, volume: 25 },
        { price: 1.1, volume: 10 },
      ],
      asks: [
        { price: 1.1002, volume: 18 },
        { price: 1.1003, volume: 40 },
      ],
    });
    adapter.dispose();
  });

  it('requests the GATEWAY symbol for the active account suffix at request time', async () => {
    useSessionStore.setState({ suffixPolicy: new SymbolSuffixPolicy('.') });
    const host = fakeHost();
    const load = vi.fn().mockResolvedValue(depthDto());
    const adapter = createAdapter(host, load);

    adapter.subscribeDOM('EURUSD');
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenLastCalledWith('EURUSD.', expect.any(AbortSignal));

    // The account (and its suffix) changes while the subscription lives; the
    // NEXT poll must speak the new account's symbol dialect.
    useSessionStore.setState({ activeLogin: '1002', suffixPolicy: NO_SUFFIX_POLICY });
    await vi.advanceTimersByTimeAsync(1500);
    expect(load).toHaveBeenLastCalledWith('EURUSD', expect.any(AbortSignal));
    adapter.dispose();
  });

  it('filters market-only, non-finite, and non-positive levels', async () => {
    const host = fakeHost();
    const load = vi.fn().mockResolvedValue(
      depthDto({
        bids: [
          { price: d('1.1000'), volume: d('10'), market: false },
          // Market-only liquidity has no real price; it must never become a
          // clickable limit/stop level.
          { price: d('0'), volume: d('99'), market: true },
          { price: 'garbage' as never, volume: d('5'), market: false },
          { price: d('-1'), volume: d('5'), market: false },
          { price: d('1.0999'), volume: d('0'), market: false },
        ],
      } as Partial<MarketDepthDto>),
    );
    const adapter = createAdapter(host, load);

    adapter.subscribeDOM('EURUSD');
    await vi.advanceTimersByTimeAsync(0);

    const [, dom] = host.domUpdate.mock.calls[0]!;
    expect(dom.bids).toEqual([{ price: 1.1, volume: 10 }]);
    adapter.dispose();
  });

  it('offers an EMPTY ladder for a crossed book', async () => {
    const host = fakeHost();
    const load = vi.fn().mockResolvedValue(depthDto({ crossed: true }));
    const adapter = createAdapter(host, load);

    adapter.subscribeDOM('EURUSD');
    await vi.advanceTimersByTimeAsync(0);

    // Empty rather than stale: a ladder with no levels offers nothing to
    // click, while yesterday's levels invite an order at a dead price.
    expect(host.domUpdate).toHaveBeenCalledWith('EURUSD', {
      snapshot: true,
      asks: [],
      bids: [],
    });
    adapter.dispose();
  });

  it('rejects an unknown volume unit and reports it once, not per poll', async () => {
    const host = fakeHost();
    const onDepthError = vi.fn();
    const load = vi.fn().mockResolvedValue(depthDto({ volumeUnit: 'contracts' }));
    const adapter = createAdapter(host, load, onDepthError);

    adapter.subscribeDOM('EURUSD');
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1500);

    // Guessing a scale factor would make every DOM volume a wrong size.
    for (const call of host.domUpdate.mock.calls) {
      expect(call[1]).toEqual({ snapshot: true, asks: [], bids: [] });
    }
    expect(onDepthError).toHaveBeenCalledTimes(1);
    adapter.dispose();
  });

  it('deduplicates repeat subscriptions for the same symbol', async () => {
    const host = fakeHost();
    const load = vi.fn().mockResolvedValue(depthDto());
    const adapter = createAdapter(host, load);

    adapter.subscribeDOM('EURUSD');
    adapter.subscribeDOM('EURUSD');
    adapter.subscribeDOM('EURUSD');
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1500);
    // One poller: one more request per interval, not three.
    expect(load).toHaveBeenCalledTimes(2);
    adapter.dispose();
  });

  it('never lets polls overlap while a request is in flight', async () => {
    const host = fakeHost();
    let resolveLoad: (v: MarketDepthDto) => void = () => {};
    const load = vi.fn().mockImplementation(
      () =>
        new Promise<MarketDepthDto>((resolve) => {
          resolveLoad = resolve;
        }),
    );
    const adapter = createAdapter(host, load);

    adapter.subscribeDOM('EURUSD');
    await vi.advanceTimersByTimeAsync(0);
    // The next poll is scheduled only AFTER the previous request settles, so a
    // slow gateway holds one request open, not a growing pile.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(load).toHaveBeenCalledTimes(1);

    resolveLoad(depthDto());
    await vi.advanceTimersByTimeAsync(1500);
    expect(load).toHaveBeenCalledTimes(2);
    adapter.dispose();
  });
});

describe('DOM teardown and staleness', () => {
  it('unsubscribeDOM stops polling, aborts in flight, and blocks a late domUpdate', async () => {
    const host = fakeHost();
    let resolveLoad: (v: MarketDepthDto) => void = () => {};
    let seenSignal: AbortSignal | null = null;
    const load = vi.fn().mockImplementation(
      (_symbol: string, signal: AbortSignal) =>
        new Promise<MarketDepthDto>((resolve) => {
          seenSignal = signal;
          resolveLoad = resolve;
        }),
    );
    const adapter = createAdapter(host, load);

    adapter.subscribeDOM('EURUSD');
    await vi.advanceTimersByTimeAsync(0);
    adapter.unsubscribeDOM('EURUSD');
    expect(seenSignal!.aborted).toBe(true);

    // The response lands AFTER the unsubscribe: it must be discarded.
    resolveLoad(depthDto());
    await vi.advanceTimersByTimeAsync(10_000);
    expect(host.domUpdate).not.toHaveBeenCalled();
    expect(load).toHaveBeenCalledTimes(1);
    adapter.dispose();
  });

  it('dispose (the disconnect path) stops every subscription', async () => {
    const host = fakeHost();
    const load = vi.fn().mockResolvedValue(depthDto());
    const adapter = createAdapter(host, load);

    adapter.subscribeDOM('EURUSD');
    adapter.subscribeDOM('XAUUSD');
    await vi.advanceTimersByTimeAsync(0);
    const callsBefore = load.mock.calls.length;

    adapter.disconnect();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(load.mock.calls.length).toBe(callsBefore);
  });

  it('sign-out stops polling entirely', async () => {
    const host = fakeHost();
    const load = vi.fn().mockResolvedValue(depthDto());
    const adapter = createAdapter(host, load);

    adapter.subscribeDOM('EURUSD');
    await vi.advanceTimersByTimeAsync(0);
    const callsBefore = load.mock.calls.length;

    useSessionStore.setState({ activeLogin: null, suffixPolicy: NO_SUFFIX_POLICY });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(load.mock.calls.length).toBe(callsBefore);
    adapter.dispose();
  });

  it('discards a depth response that raced an account switch', async () => {
    const host = fakeHost();
    let resolveLoad: (v: MarketDepthDto) => void = () => {};
    const load = vi.fn().mockImplementationOnce(
      () =>
        new Promise<MarketDepthDto>((resolve) => {
          resolveLoad = resolve;
        }),
    );
    load.mockResolvedValue(depthDto());
    const adapter = createAdapter(host, load);

    adapter.subscribeDOM('EURUSD');
    await vi.advanceTimersByTimeAsync(0);

    // The switch happens while the old account's request is in flight.
    useSessionStore.setState({ activeLogin: '1002', suffixPolicy: NO_SUFFIX_POLICY });
    resolveLoad(depthDto());
    await vi.advanceTimersByTimeAsync(0);

    // The old account's book never reaches the library…
    expect(host.domUpdate).not.toHaveBeenCalled();

    // …but polling continues, and the NEW account's next response does.
    await vi.advanceTimersByTimeAsync(1500);
    expect(load).toHaveBeenCalledTimes(2);
    expect(host.domUpdate).toHaveBeenCalledTimes(1);
    adapter.dispose();
  });

  it('reports polling failures through the diagnostic sink and keeps the loop alive', async () => {
    const host = fakeHost();
    const onDepthError = vi.fn();
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error('gateway unavailable'))
      .mockResolvedValue(depthDto());
    const adapter = createAdapter(host, load, onDepthError);

    adapter.subscribeDOM('EURUSD');
    await vi.advanceTimersByTimeAsync(0);
    expect(onDepthError).toHaveBeenCalledTimes(1);
    expect(host.domUpdate).not.toHaveBeenCalled();

    // A failed poll backs off like an empty one — hammering a broken endpoint
    // every 1.5s helps nobody — so the retry is due at 3s, not 1.5s.
    await vi.advanceTimersByTimeAsync(1500);
    expect(host.domUpdate).not.toHaveBeenCalled();

    // A transient depth failure must not kill the DOM for the session.
    await vi.advanceTimersByTimeAsync(1500);
    expect(host.domUpdate).toHaveBeenCalledTimes(1);
    adapter.dispose();
  });

  it('backs off while the book is empty and recovers the moment depth appears', async () => {
    const host = fakeHost();
    // An empty book is the normal case on a broker with no Level 2 at all.
    const load = vi.fn().mockResolvedValue(depthDto({ bids: [], asks: [] }));
    const adapter = createAdapter(host, load);

    adapter.subscribeDOM('EURUSD');
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(1);

    // Base cadence has passed but the loop is now waiting 3s.
    await vi.advanceTimersByTimeAsync(1500);
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1500);
    expect(load).toHaveBeenCalledTimes(2);

    // …and 6s for the one after that. Under the old fixed cadence these 9
    // seconds would have cost 6 requests; they cost 2.
    await vi.advanceTimersByTimeAsync(3000);
    expect(load).toHaveBeenCalledTimes(2);
    load.mockResolvedValue(depthDto());
    await vi.advanceTimersByTimeAsync(3000);
    expect(load).toHaveBeenCalledTimes(3);

    // Depth arrived — straight back to the base cadence.
    await vi.advanceTimersByTimeAsync(1500);
    expect(load).toHaveBeenCalledTimes(4);
    adapter.dispose();
  });

  it('stays inert when the gateway does not serve market depth', async () => {
    const host = fakeHost();
    const adapter = new GatewayBrokerAdapter({
      host,
      trading: {} as TradingService,
      resolveSymbol: async () => symbol(),
      // No loadMarketDepth: the capability is off for this deployment.
    });

    adapter.subscribeDOM('EURUSD');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(host.domUpdate).not.toHaveBeenCalled();
    adapter.dispose();
  });
});
