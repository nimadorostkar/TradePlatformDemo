import { describe, expect, it } from 'vitest';
import {
  tvOrderSchema,
  tvOrderHistorySchema,
  tvPositionSchema,
  mt5DealSchema,
  tvQuoteSchema,
  tvSymbolSchema,
} from '../contracts/schemas';
import { NO_SUFFIX_POLICY, SymbolSuffixPolicy } from './symbol-suffix';
import { validateOrder } from '@/domain/orders/validation';
import {
  digitsFromPricescale,
  mapAccountState,
  mapTvSymbol,
  mapDeal,
  mapTvOrder,
  mapTvOrderHistory,
  mapTvPosition,
  mapTvQuote,
  pairDealsIntoClosedPositions,
  readOnlyFromRights,
} from './to-domain';

const ecn = new SymbolSuffixPolicy('.');

function position(raw: Record<string, unknown>) {
  return tvPositionSchema.parse({
    Id: '123456789012345',
    profit: 12.5,
    qty: 10_000,
    side: 1,
    symbol: 'EURUSD.',
    type: 0,
    last: 1.0855,
    price: 1.085,
    ...raw,
  });
}

describe('mapTvQuote broker timestamps', () => {
  const quote = (raw: Record<string, unknown> = {}) =>
    tvQuoteSchema.parse({
      symbolname: 'XAUUSD',
      status: 'Ok',
      bid: 4264.78,
      ask: 4264.99,
      lastprice: 4264.78,
      volume: 1,
      ...raw,
    });

  it('refuses to build a quote out of a tick with no prices', () => {
    // MT5 sends 0 for a price it does not have. Coerced to "0", it produced a
    // quote object that every `if (!quote)` guard accepted — the ticket showed
    // a 0.00000 face with BUY and SELL still live.
    expect(mapTvQuote(quote({ bid: 0, ask: 0 }))).toBeNull();
    expect(mapTvQuote(quote({ bid: 0 }))).toBeNull();
    expect(mapTvQuote(quote({ ask: 0 }))).toBeNull();
  });

  it('still maps a tick that has both sides', () => {
    const mapped = mapTvQuote(quote());
    expect(mapped?.bid).toBe('4264.78');
    expect(mapped?.ask).toBe('4264.99');
  });

  it('converts the wire’s UTC seconds to milliseconds', () => {
    // Everything on the wire is UTC seconds; the client works in ms. This is a
    // unit conversion only — there is no timezone shift anywhere in the path.
    expect(mapTvQuote(quote({ time: 1_786_029_053 })).brokerTime).toBe(1_786_029_053_000);
  });

  it('keys the quote by the REQUESTED symbol, not the echoed one', () => {
    // MT5 may label the tick with a group-normalised variant of the name it
    // was asked for (live QA: EURUSD# subscriptions answered with ticks the
    // store filed where no reader looked — live prices on the wire, dashes in
    // every panel). The subscription key is the contract; the echo is not.
    const mapped = mapTvQuote(quote({ symbolname: 'XAUUSD' }), undefined, Date.now(), 'XAUUSD#');
    expect(mapped.symbol).toBe('XAUUSD#');
    // Without a requested symbol (unkeyed contexts), the echo still stands.
    expect(mapTvQuote(quote({ symbolname: 'XAUUSD' })).symbol).toBe('XAUUSD');
  });

  it('reports no broker time when the gateway omits it', () => {
    expect(mapTvQuote(quote()).brokerTime).toBeNull();
  });

  it('treats MT5’s unset zero as absent rather than 1970', () => {
    expect(mapTvQuote(quote({ time: 0 })).brokerTime).toBeNull();
  });

  it('keeps the client receive time separate from the broker’s', () => {
    const mapped = mapTvQuote(quote({ time: 1_786_029_053 }), undefined, 999);
    expect(mapped.receivedAt).toBe(999);
    expect(mapped.brokerTime).toBe(1_786_029_053_000);
  });
});

describe('mapTvSymbol chart metadata', () => {
  it('passes the gateway’s timezone and session through untouched', () => {
    // TradingView's contract: bar time is UTC and symbolInfo.timezone decides
    // the axis. Rewriting either of these client-side is what puts a chart
    // three hours off, so they must cross the boundary verbatim.
    const session = '0000-2400:2|0000-2400:3|0000-2400:4|0000-2400:5|0000-2400:6';
    const mapped = mapTvSymbol(
      tvSymbolSchema.parse({
        ticker: 'XAUUSD',
        name: 'XAUUSD.',
        description: 'Gold vs US Dollar',
        type: 'Metals',
        session,
        timezone: 'Etc/UTC',
        exchange: 'Broker',
        listed_exchange: 'Broker',
        format: 'price',
        pricescale: 100,
        minmov: 1,
        volume_precision: 2,
        data_status: 'streaming',
        has_intraday: true,
        has_daily: true,
        has_weekly_and_monthly: true,
        supported_resolutions: ['1'],
        intraday_multipliers: ['1'],
        has_empty_bars: false,
        visible_plots_set: 'ohlcv',
        currency_code: 'USD',
        base_name: 'XAUUSD',
        full_name: 'XAUUSD',
        pro_name: 'XAUUSD',
        sector: '',
        industry: '',
        delay: 0,
        volume: 0,
      }),
      ecn,
    );

    expect(mapped.timezone).toBe('Etc/UTC');
    expect(mapped.session).toBe(session);
  });
});

describe('mapTvPosition', () => {
  it('converts MT5 volume units to lots and strips the suffix', () => {
    const mapped = mapTvPosition(position({}), ecn);
    expect(mapped?.volume).toBe('1');
    expect(mapped?.displaySymbol).toBe('EURUSD');
    expect(mapped?.symbol).toBe('EURUSD.');
    expect(mapped?.side).toBe('buy');
  });

  it('keeps the ticket id as a string so 64-bit precision survives', () => {
    const mapped = mapTvPosition(position({ Id: '9007199254740993' }), ecn);
    expect(mapped?.id).toBe('9007199254740993');
  });

  it('maps MT5 zero brackets to unavailable, not to a stop at zero', () => {
    // MT5 encodes "no stop" as 0.0. Rendering it would claim a protective
    // level that does not exist.
    const absent = mapTvPosition(position({}), ecn);
    expect(absent?.stopLoss).toBeNull();
    expect(absent?.takeProfit).toBeNull();

    const withZero = mapTvPosition(position({ priceSL: 0, priceTP: 0 }), ecn);
    expect(withZero?.stopLoss).toBeNull();
    expect(withZero?.takeProfit).toBeNull();
  });

  it('prefers the gateway-supplied lot volume over converting MT5 units', () => {
    const mapped = mapTvPosition(position({ qty: 10_000, qtyLots: 1 }), ecn);
    expect(mapped?.volume).toBe('1');
  });

  it('falls back to converting units when qtyLots is absent', () => {
    // Keeps the client working against an older gateway.
    const mapped = mapTvPosition(position({ qty: 25_000 }), ecn);
    expect(mapped?.volume).toBe('2.5');
  });

  it('carries swap and commission now that the gateway supplies them', () => {
    const mapped = mapTvPosition(position({ swap: -2.5, commission: -1.05 }), ecn);
    expect(mapped?.swap).toBe('-2.5');
    expect(mapped?.commission).toBe('-1.05');
  });

  it('still reports swap as unavailable when the gateway omits it', () => {
    expect(mapTvPosition(position({}), ecn)?.swap).toBeNull();
  });

  it('keeps a real stop-loss', () => {
    const mapped = mapTvPosition(position({ priceSL: 1.08, priceTP: 1.095 }), ecn);
    expect(mapped?.stopLoss).toBe('1.08');
    expect(mapped?.takeProfit).toBe('1.095');
  });

  it('converts timeCreate seconds to milliseconds', () => {
    const mapped = mapTvPosition(position({ timeCreate: 1_700_000_000 }), ecn);
    expect(mapped?.openTime).toBe(1_700_000_000_000);
  });

  it('returns null for a row with no usable id', () => {
    expect(mapTvPosition(position({ Id: '' }), ecn)).toBeNull();
  });
});

describe('mapTvOrder', () => {
  const base = {
    id: '5001',
    symbol: 'XAUUSD.',
    side: -1,
    type: 1,
    qty: 5_000,
    limitPrice: 2400.5,
    stopPrice: 0,
    status: 6,
  };

  it('reads status with one table for both REST and WebSocket', () => {
    // The gateway now populates `status` from MT5ToTVStatus on BOTH paths.
    // While the WS path used an order-TYPE table, filled and rejected were
    // indistinguishable and everything ambiguous had to resolve to "unknown".
    const mapped = mapTvOrder(tvOrderSchema.parse(base), ecn);
    expect(mapped?.status).toBe('working');
    expect(mapped?.kind).toBe('limit');
    expect(mapped?.side).toBe('sell');
    expect(mapped?.volume).toBe('0.5');
  });

  // A gateway that cannot state a side sends 0. `side >= 0` reads that as BUY,
  // which is how a resting Sell Stop rendered as a Buy Stop in every surface
  // and then refused to cancel (cancel re-derives the MT5 type from the side).
  // The mapper stays faithful to what it is given — the WS frame carrying a 0
  // is rejected upstream in use-account-sync — so pin the reading here.
  it('reads a 0 side as buy, which is why a 0 must never reach it', () => {
    expect(mapTvOrder(tvOrderSchema.parse({ ...base, side: 0 }), ecn)?.side).toBe('buy');
    expect(mapTvOrder(tvOrderSchema.parse({ ...base, side: 1 }), ecn)?.side).toBe('buy');
    expect(mapTvOrder(tvOrderSchema.parse({ ...base, side: -1 }), ecn)?.side).toBe('sell');
  });

  it('distinguishes filled from rejected', () => {
    expect(mapTvOrder(tvOrderSchema.parse({ ...base, status: 2 }), ecn)?.status).toBe('filled');
    expect(mapTvOrder(tvOrderSchema.parse({ ...base, status: 5 }), ecn)?.status).toBe('rejected');
    expect(mapTvOrder(tvOrderSchema.parse({ ...base, status: 1 }), ecn)?.status).toBe('canceled');
  });

  it('prefers the gateway lot volumes', () => {
    const mapped = mapTvOrder(
      tvOrderSchema.parse({
        ...base,
        qty: 50_000,
        qtyLots: 5,
        filledQty: 30_000,
        filledQtyLots: 3,
      }),
      ecn,
    );
    expect(mapped?.volume).toBe('5');
    expect(mapped?.filledVolume).toBe('3');
  });

  it('maps an expiry, treating 0 as good-till-cancelled', () => {
    const gtd = mapTvOrder(tvOrderSchema.parse({ ...base, expiration: 1_800_000_000 }), ecn);
    expect(gtd?.expiration).toBe(1_800_000_000_000);

    const gtc = mapTvOrder(tvOrderSchema.parse({ ...base, expiration: 0 }), ecn);
    expect(gtc?.expiration).toBeNull();
  });

  it('picks stopPrice for a stop order and limitPrice for a limit order', () => {
    const limit = mapTvOrder(tvOrderSchema.parse(base), ecn);
    expect(limit?.price).toBe('2400.5');

    const stop = mapTvOrder(
      tvOrderSchema.parse({ ...base, type: 3, limitPrice: 0, stopPrice: 2390 }),
      ecn,
      'rest',
    );
    expect(stop?.price).toBe('2390');
  });
});

describe('deal mapping and history pairing', () => {
  const deal = (raw: Record<string, unknown>) => mt5DealSchema.parse(raw);

  it('classifies balance and credit entries as ledger, not trades', () => {
    expect(mapDeal(deal({ Deal: '1', Action: 2 }), ecn)?.kind).toBe('balance');
    expect(mapDeal(deal({ Deal: '2', Action: 3 }), ecn)?.kind).toBe('credit');
    expect(mapDeal(deal({ Deal: '3', Action: 0 }), ecn)?.kind).toBe('trade');
  });

  it('tolerates both MT5 casings at the boundary', () => {
    const upper = mapDeal(deal({ Deal: '10', Symbol: 'EURUSD.', Action: 0, Volume: 10_000 }), ecn);
    const lower = mapDeal(deal({ deal: '11', symbol: 'EURUSD.', action: 0, volume: 10_000 }), ecn);
    expect(upper?.displaySymbol).toBe('EURUSD');
    expect(lower?.displaySymbol).toBe('EURUSD');
    expect(upper?.volume).toBe('1');
    expect(lower?.volume).toBe('1');
  });

  it('pairs an opening deal with its closing deal', () => {
    const deals = [
      mapDeal(
        deal({
          Deal: '100',
          PositionID: '900',
          Action: 0,
          Entry: 0,
          Symbol: 'EURUSD.',
          Volume: 10_000,
          Price: 1.08,
          Time: 1_700_000_000,
        }),
        ecn,
      )!,
      mapDeal(
        deal({
          Deal: '101',
          PositionID: '900',
          Action: 1,
          Entry: 1,
          Symbol: 'EURUSD.',
          Volume: 10_000,
          Price: 1.09,
          Profit: 100,
          Time: 1_700_003_600,
        }),
        ecn,
      )!,
    ];

    const [closed] = pairDealsIntoClosedPositions(deals);
    expect(closed).toBeDefined();
    expect(closed?.id).toBe('900');
    expect(closed?.displaySymbol).toBe('EURUSD');
    // The position's direction comes from the OPENING deal, not the closing one.
    expect(closed?.side).toBe('buy');
    expect(closed?.openPrice).toBe('1.08');
    expect(closed?.closePrice).toBe('1.09');
    expect(closed?.profit).toBe('100');
  });

  it('excludes ledger entries from closed positions', () => {
    // A deposit rendered as a closed position with no symbol was the bug the
    // working integration had to fix.
    const deals = [
      mapDeal(deal({ Deal: '200', Action: 2, Profit: 500, Time: 1_700_000_000 }), ecn)!,
    ];
    expect(pairDealsIntoClosedPositions(deals)).toHaveLength(0);
  });

  it('inherits the symbol from the opening deal when the closing deal omits it', () => {
    const deals = [
      mapDeal(
        deal({
          Deal: '300',
          PositionID: '910',
          Action: 0,
          Entry: 0,
          Symbol: 'XAUUSD.',
          Price: 2400,
        }),
        ecn,
      )!,
      mapDeal(deal({ Deal: '301', PositionID: '910', Action: 1, Entry: 1, Price: 2410 }), ecn)!,
    ];
    const [closed] = pairDealsIntoClosedPositions(deals);
    expect(closed?.displaySymbol).toBe('XAUUSD');
  });

  it('does not crash on a deal missing most fields', () => {
    expect(() => mapDeal(deal({ Deal: '400' }), ecn)).not.toThrow();
  });
});

describe('helpers', () => {
  it('derives price digits from the pricescale', () => {
    expect(digitsFromPricescale(100_000)).toBe(5);
    expect(digitsFromPricescale(100)).toBe(2);
    expect(digitsFromPricescale(1)).toBe(0);
  });

  describe('readOnlyFromRights', () => {
    // Values from the MT5 Manager API EnUsersRights enum, confirmed against
    // two independent implementations of the Manager protocol.
    const ENABLED = 0x01;
    const PASSWORD = 0x02;
    const TRADE_DISABLED = 0x04;
    const INVESTOR = 0x08;
    const TRAILING = 0x20;
    const EXPERT = 0x40;
    const REPORTS = 0x100;
    const READONLY = 0x200;
    const DEFAULT_RIGHTS = 0x163; // ENABLED|PASSWORD|TRAILING|EXPERT|REPORTS

    it('treats an account with MT5 DEFAULT rights as tradable', () => {
      // The regression that mattered: USER_RIGHT_PASSWORD (0x02) is part of
      // MT5's default mask, so reading bit 1 as "trade disabled" marked
      // essentially every real account read-only and blocked all trading.
      expect(DEFAULT_RIGHTS & PASSWORD).toBeTruthy();
      expect(readOnlyFromRights(DEFAULT_RIGHTS)).toBe(false);
    });

    it('does not treat the password right as a trading restriction', () => {
      expect(readOnlyFromRights(ENABLED | PASSWORD)).toBe(false);
    });

    it('detects the trade-disabled flag', () => {
      expect(readOnlyFromRights(DEFAULT_RIGHTS | TRADE_DISABLED)).toBe(true);
    });

    it('treats an investor login as read-only', () => {
      expect(readOnlyFromRights(ENABLED | INVESTOR)).toBe(true);
    });

    it('treats the explicit readonly flag as read-only', () => {
      expect(readOnlyFromRights(ENABLED | READONLY)).toBe(true);
    });

    it('ignores rights unrelated to trading', () => {
      expect(readOnlyFromRights(ENABLED | TRAILING | EXPERT | REPORTS)).toBe(false);
    });

    it('returns null when the field is absent — unknown is not tradable-or-not', () => {
      expect(readOnlyFromRights(null)).toBeNull();
      expect(readOnlyFromRights(undefined)).toBeNull();
    });
  });
});

describe('symbol volume limits', () => {
  const tvSymbol = {
    ticker: 'XAUUSD',
    name: 'XAUUSD.',
    description: 'Gold vs US Dollar',
    type: 'Metals',
    session: '24x5',
    timezone: 'Etc/UTC',
    exchange: 'Broker',
    listed_exchange: 'Broker',
    format: 'price',
    pricescale: 100,
    minmov: 1,
    volume_precision: 2,
    data_status: 'streaming',
    has_intraday: true,
    has_daily: true,
    has_weekly_and_monthly: true,
    supported_resolutions: ['1'],
    intraday_multipliers: ['1'],
    has_empty_bars: false,
    visible_plots_set: 'ohlcv',
    currency_code: 'USD',
    base_name: 'XAUUSD',
    full_name: 'XAUUSD',
    pro_name: 'XAUUSD',
    sector: '',
    industry: '',
    delay: 0,
    volume: 0,
  };

  it('converts MT5 volume UNITS to lots', () => {
    // MT5 reports VolumeMin in units where 1 lot = 10000, so 100 means 0.01
    // lots. Passing the raw value through made the order ticket reject every
    // realistic order with "Minimum volume is 100".
    const mapped = mapTvSymbol(tvSymbolSchema.parse(tvSymbol), ecn, {
      VolumeMin: '100',
      VolumeMax: '10000000',
      VolumeStep: '100',
    });

    expect(mapped.volumeMin).toBe('0.01');
    expect(mapped.volumeMax).toBe('1000');
    expect(mapped.volumeStep).toBe('0.01');
  });

  it('uses the EXTENDED scale for *Ext fields', () => {
    // VolumeMinExt is 1/100000000 lot — a different scale entirely. Reading it
    // with the standard divisor would overstate the limit 10000-fold.
    const mapped = mapTvSymbol(tvSymbolSchema.parse(tvSymbol), ecn, {
      VolumeMinExt: '1000000',
      VolumeStepExt: '1000000',
    });

    expect(mapped.volumeMin).toBe('0.01');
    expect(mapped.volumeStep).toBe('0.01');
  });

  it('prefers the standard field when both are present', () => {
    const mapped = mapTvSymbol(tvSymbolSchema.parse(tvSymbol), ecn, {
      VolumeMin: '500',
      VolumeMinExt: '1000000',
    });
    expect(mapped.volumeMin).toBe('0.05');
  });

  it('reports limits as unavailable when the raw record is missing', () => {
    const mapped = mapTvSymbol(tvSymbolSchema.parse(tvSymbol), ecn);
    expect(mapped.volumeMin).toBeNull();
    expect(mapped.volumeMax).toBeNull();
    expect(mapped.volumeStep).toBeNull();
  });

  it('maps MT5 zero TickSize/TickValue to ABSENT, never to a live zero', () => {
    // MT5 reports 0 to mean "not specified — use the point (10^-digits)".
    // A zero kept as a value becomes a DIVISOR in TradingView's price math:
    // "[big.js] Division by zero", a dead Order Ticket, and no chart trading
    // actions — the production failure this pins down.
    const mapped = mapTvSymbol(tvSymbolSchema.parse(tvSymbol), ecn, {
      TickSize: '0',
      TickValue: '0',
    });
    expect(mapped.tickSize).toBeNull();
    expect(mapped.tickValue).toBeNull();
  });

  it('keeps a real tick size', () => {
    const mapped = mapTvSymbol(tvSymbolSchema.parse(tvSymbol), ecn, {
      TickSize: '0.00001',
      TickValue: '1',
    });
    expect(mapped.tickSize).toBe('0.00001');
    expect(mapped.tickValue).toBe('1');
  });

  it('accepts a realistic 0.01 lot order against the mapped minimum', () => {
    const mapped = mapTvSymbol(tvSymbolSchema.parse(tvSymbol), ecn, {
      VolumeMin: '100',
      VolumeMax: '10000000',
      VolumeStep: '100',
    });

    const result = validateOrder(
      { kind: 'market', side: 'buy', volume: '0.01' },
      {
        symbol: mapped,
        quote: {
          symbol: 'XAUUSD.',
          bid: '4096.40' as never,
          ask: '4096.62' as never,
          last: '4096.50' as never,
          volume: null,
          receivedAt: Date.now(),
          direction: 'flat',
        },
        readOnly: false,
      },
    );

    expect(result.canSubmit).toBe(true);
  });
});

describe('pairDealsIntoClosedPositions — MT5 entry types and window edges', () => {
  const deal = (raw: Record<string, unknown>) => mt5DealSchema.parse(raw);
  const trade = (overrides: Record<string, unknown>) =>
    mapDeal(deal({ Action: 0, Symbol: 'EURUSD.', Volume: 10_000, ...overrides }), ecn)!;

  it('gives a balance entry no volume and no price, rather than zeros', () => {
    // A deposit was rendered as dealt at a price of 0 in a volume of 0, while
    // Symbol and Side on the same row correctly showed a dash.
    const balance = mapDeal(
      deal({ Deal: '5', Action: 2, Symbol: '', Volume: 0, Price: 0, Profit: 1000 }),
      ecn,
    )!;

    expect(balance.kind).toBe('balance');
    expect(balance.volume).toBeNull();
    expect(balance.price).toBeNull();
    expect(balance.profit).toBe('1000');
  });

  it('marks a position whose entry lies before the window as "opened before range"', () => {
    // Only the closing deal is inside the fetched window. Blank open cells
    // read as corrupt data; the row must SAY the entry predates the range.
    const closedRows = pairDealsIntoClosedPositions([
      trade({
        Deal: '1',
        PositionID: '900',
        Action: 1,
        Entry: 1,
        Price: 1.09,
        Time: 1_700_000_000,
      }),
    ]);

    expect(closedRows).toHaveLength(1);
    expect(closedRows[0]?.openedBeforeRange).toBe(true);
    expect(closedRows[0]?.openPrice).toBeNull();
    // The closing deal is a sell, so the position was a buy.
    expect(closedRows[0]?.side).toBe('buy');
  });

  it('treats a reversal (DEAL_ENTRY_INOUT) as both an exit and the next leg entry', () => {
    const rows = pairDealsIntoClosedPositions([
      trade({ Deal: '1', PositionID: '900', Entry: 0, Price: 1.08, Time: 1_700_000_000 }),
      // Reversal: closes the buy leg AND opens a sell leg on the same id.
      trade({
        Deal: '2',
        PositionID: '900',
        Action: 1,
        Entry: 2,
        Price: 1.09,
        Profit: 100,
        Time: 1_700_003_600,
      }),
      // Final close of the reversed (sell) leg.
      trade({
        Deal: '3',
        PositionID: '900',
        Action: 0,
        Entry: 1,
        Price: 1.085,
        Profit: 50,
        Time: 1_700_007_200,
      }),
    ]);

    expect(rows).toHaveLength(2);
    // Rows are newest-first. The second leg's entry is the REVERSAL deal.
    expect(rows[0]?.openPrice).toBe('1.09');
    expect(rows[0]?.side).toBe('sell');
    expect(rows[0]?.closePrice).toBe('1.085');
    // The first leg pairs with the original entry, not the reversal.
    expect(rows[1]?.openPrice).toBe('1.08');
    expect(rows[1]?.side).toBe('buy');
    expect(rows[1]?.openedBeforeRange).toBeUndefined();
  });

  it('pairs a close-by (DEAL_ENTRY_OUT_BY) as an ordinary exit', () => {
    const rows = pairDealsIntoClosedPositions([
      trade({ Deal: '1', PositionID: '900', Entry: 0, Price: 1.08, Time: 1_700_000_000 }),
      trade({
        Deal: '2',
        PositionID: '900',
        Action: 1,
        Entry: 3,
        Price: 1.081,
        Profit: 10,
        Time: 1_700_003_600,
      }),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.openPrice).toBe('1.08');
    expect(rows[0]?.profit).toBe('10');
  });

  it('pairs exits with the entry that was current AT THE TIME, whatever the input order', () => {
    // The wire is not guaranteed chronological. Delivered exit-first, the old
    // by-id map paired the first leg's exit with the SECOND leg's entry.
    const rows = pairDealsIntoClosedPositions([
      trade({
        Deal: '3',
        PositionID: '900',
        Action: 1,
        Entry: 2,
        Price: 1.09,
        Time: 1_700_003_600,
      }),
      trade({ Deal: '1', PositionID: '900', Entry: 0, Price: 1.08, Time: 1_700_000_000 }),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.openPrice).toBe('1.08');
  });

  it('keeps the entry across partial closes', () => {
    const rows = pairDealsIntoClosedPositions([
      trade({
        Deal: '1',
        PositionID: '900',
        Entry: 0,
        Price: 1.08,
        Volume: 20_000,
        Time: 1_700_000_000,
      }),
      trade({
        Deal: '2',
        PositionID: '900',
        Action: 1,
        Entry: 1,
        Price: 1.085,
        Volume: 10_000,
        Time: 1_700_003_600,
      }),
      trade({
        Deal: '3',
        PositionID: '900',
        Action: 1,
        Entry: 1,
        Price: 1.09,
        Volume: 10_000,
        Time: 1_700_007_200,
      }),
    ]);

    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.openPrice === '1.08')).toBe(true);
  });

  it('charges commission from BOTH deals, reconciling against the balance delta', () => {
    // The launch-readiness case, where the true ledger is known independently:
    //   open  BUY  0.01 @ 1.16614   1,000.00 → 999.96    commission -0.04
    //   close SELL 0.01 @ 1.16627     999.96 → 1,000.09  profit     +0.13
    //   true net result                                             +0.09
    // Reading commission off the closing deal alone reported +0.13.
    const rows = pairDealsIntoClosedPositions([
      trade({
        Deal: '1',
        PositionID: '900',
        Entry: 0,
        Price: 1.16614,
        Volume: 100,
        Commission: -0.04,
        Time: 1_700_000_000,
      }),
      trade({
        Deal: '2',
        PositionID: '900',
        Action: 1,
        Entry: 1,
        Price: 1.16627,
        Volume: 100,
        Profit: 0.13,
        Time: 1_700_003_600,
      }),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.commission).toBe('-0.04');
    expect(rows[0]?.profit).toBe('0.13');
    const balanceDelta = Number(rows[0]!.profit) + Number(rows[0]!.commission);
    expect(balanceDelta).toBeCloseTo(0.09, 10);
  });

  it('apportions the entry commission across partial closes instead of repeating it', () => {
    // The entry deal stays registered so later exits can pair with it, so a
    // naive sum bills its commission again on every close.
    const rows = pairDealsIntoClosedPositions([
      trade({
        Deal: '1',
        PositionID: '900',
        Entry: 0,
        Price: 1.08,
        Volume: 30_000,
        Commission: -0.12,
        Time: 1_700_000_000,
      }),
      trade({
        Deal: '2',
        PositionID: '900',
        Action: 1,
        Entry: 1,
        Price: 1.085,
        Volume: 10_000,
        Commission: -0.04,
        Time: 1_700_003_600,
      }),
      trade({
        Deal: '3',
        PositionID: '900',
        Action: 1,
        Entry: 1,
        Price: 1.09,
        Volume: 20_000,
        Commission: -0.08,
        Time: 1_700_007_200,
      }),
    ]);

    expect(rows).toHaveLength(2);
    const total = rows.reduce((sum, row) => sum + Number(row.commission), 0);
    // -0.12 entry charged exactly once, plus -0.12 across the two exits.
    expect(total).toBeCloseTo(-0.24, 10);
    // Split by the volume each exit closed: a third, then the remaining two.
    const byNewest = rows.map((row) => Number(row.commission));
    expect(byNewest).toEqual([-0.16, -0.08]);
  });

  it('charges an entry of unknown volume once rather than on every exit', () => {
    const rows = pairDealsIntoClosedPositions([
      trade({
        Deal: '1',
        PositionID: '900',
        Entry: 0,
        Price: 1.08,
        Volume: 0,
        Commission: -0.05,
        Time: 1_700_000_000,
      }),
      trade({
        Deal: '2',
        PositionID: '900',
        Action: 1,
        Entry: 1,
        Price: 1.085,
        Volume: 10_000,
        Time: 1_700_003_600,
      }),
      trade({
        Deal: '3',
        PositionID: '900',
        Action: 1,
        Entry: 1,
        Price: 1.09,
        Volume: 10_000,
        Time: 1_700_007_200,
      }),
    ]);

    const total = rows.reduce((sum, row) => sum + Number(row.commission ?? 0), 0);
    expect(total).toBeCloseTo(-0.05, 10);
  });

  it('sums swap across both deals as well', () => {
    const rows = pairDealsIntoClosedPositions([
      trade({
        Deal: '1',
        PositionID: '900',
        Entry: 0,
        Price: 1.08,
        Volume: 10_000,
        Storage: -0.5,
        Time: 1_700_000_000,
      }),
      trade({
        Deal: '2',
        PositionID: '900',
        Action: 1,
        Entry: 1,
        Price: 1.085,
        Volume: 10_000,
        Storage: -1.25,
        Time: 1_700_003_600,
      }),
    ]);

    expect(rows[0]?.swap).toBe('-1.75');
  });

  it('reports no commission as null, not as a charge of zero', () => {
    const rows = pairDealsIntoClosedPositions([
      trade({ Deal: '1', PositionID: '900', Entry: 0, Price: 1.08, Time: 1_700_000_000 }),
      trade({
        Deal: '2',
        PositionID: '900',
        Action: 1,
        Entry: 1,
        Price: 1.085,
        Time: 1_700_003_600,
      }),
    ]);

    expect(rows[0]?.commission).toBeNull();
  });

  it('leaves a before-range row with the only charges it can see', () => {
    // No entry deal was fetched, so there is nothing to add. The row must not
    // invent a zero entry commission and claim to be complete.
    const rows = pairDealsIntoClosedPositions([
      trade({
        Deal: '1',
        PositionID: '900',
        Action: 1,
        Entry: 1,
        Price: 1.09,
        Commission: -0.04,
        Time: 1_700_000_000,
      }),
    ]);

    expect(rows[0]?.openedBeforeRange).toBe(true);
    expect(rows[0]?.commission).toBe('-0.04');
  });
});

describe('mapTvOrderHistory', () => {
  const dto = (raw: Record<string, unknown>) => tvOrderHistorySchema.parse(raw);

  it('maps a cancelled pending order with lots, prices and times', () => {
    const order = mapTvOrderHistory(
      dto({
        id: '105640841',
        symbol: 'XAUUSD.',
        side: 1,
        type: 1,
        qty: 100,
        qtyLots: 0.01,
        filledQty: 0,
        limitPrice: 2400.5,
        stopLoss: 2390,
        takeProfit: 2450,
        status: 1,
        updateTime: 1_700_003_600,
        timeSetup: 1_700_000_000,
        message: ' tp hit ',
      }),
      ecn,
    );

    expect(order).toMatchObject({
      id: '105640841',
      displaySymbol: 'XAUUSD',
      side: 'buy',
      kind: 'limit',
      volumeLots: '0.01',
      price: '2400.5',
      stopLoss: '2390',
      takeProfit: '2450',
      status: 'canceled',
      updateTime: 1_700_003_600_000,
      setupTime: 1_700_000_000_000,
      comment: 'tp hit',
    });
  });

  it('derives lots from the raw 1/10000 unit when qtyLots is absent (older gateway)', () => {
    const order = mapTvOrderHistory(
      dto({ id: '1', symbol: 'EURUSD.', side: -1, type: 2, qty: 100, status: 2 }),
      ecn,
    );
    expect(order?.volumeLots).toBe('0.01');
    expect(order?.side).toBe('sell');
    expect(order?.kind).toBe('market');
    expect(order?.status).toBe('filled');
    // A market order has no own price; zero must not become a price of 0.
    expect(order?.price).toBeNull();
  });

  it('maps every final status the gateway can report', () => {
    const statusOf = (status: number) =>
      mapTvOrderHistory(dto({ id: '1', symbol: 'EURUSD.', side: 1, type: 1, status }), ecn)?.status;
    expect(statusOf(1)).toBe('canceled');
    expect(statusOf(2)).toBe('filled');
    expect(statusOf(3)).toBe('expired');
    expect(statusOf(5)).toBe('rejected');
    expect(statusOf(99)).toBe('unknown');
  });
});

/**
 * BUG-F, 2026-08-20 retest: a filled stop showed `Placed` and `Final` as the
 * same instant — 7:08:50 PM in both columns for an order that filled at
 * 7:23:10. The gateway published the setup time as `updateTime`, so the order
 * history could not say when anything had actually executed.
 */
describe('historical order — when it finished', () => {
  const row = (extra: Record<string, unknown>) =>
    tvOrderHistorySchema.parse({
      id: '77',
      symbol: 'EURUSD',
      side: 1,
      type: 3,
      status: 2,
      qtyLots: 0.01,
      timeSetup: 1_755_710_930,
      ...extra,
    });

  it('reports the final state at timeDone, not at the time it was placed', () => {
    const order = mapTvOrderHistory(row({ timeDone: 1_755_711_790 }), ecn);
    expect(order?.setupTime).toBe(1_755_710_930_000);
    expect(order?.updateTime).toBe(1_755_711_790_000);
  });

  it('leaves the final time empty for an order that has not finished', () => {
    // Null, not the setup time echoed back: "still working" and "completed the
    // instant it was placed" are different facts about a trader's order.
    const order = mapTvOrderHistory(row({ status: 6, timeDone: null }), ecn);
    expect(order?.updateTime).toBeNull();
    expect(order?.setupTime).toBe(1_755_710_930_000);
  });

  it('still reads updateTime from a gateway too old to send timeDone', () => {
    const order = mapTvOrderHistory(row({ updateTime: 1_755_711_790 }), ecn);
    expect(order?.updateTime).toBe(1_755_711_790_000);
  });
});

/**
 * A deal names the ORDER it executed. Without that, the only record of what a
 * trade actually cost cannot be attributed to the order that asked for it —
 * which is why the order history showed the price a stop was placed at rather
 * than the price it filled at.
 */
describe('deal — the order it executed', () => {
  it('carries the order ticket', () => {
    const deal = mapDeal(
      mt5DealSchema.parse({
        Deal: '5',
        Order: '77',
        PositionID: '77',
        Action: 0,
        Symbol: 'EURUSD',
        Price: 1.16758,
      }),
      ecn,
    );
    expect(deal?.orderId).toBe('77');
  });

  it('treats MT5s zero ticket as no order at all', () => {
    // Balance and credit entries carry Order 0; attributing a fill price to
    // order "0" would collide every ledger row onto one imaginary order.
    const deal = mapDeal(mt5DealSchema.parse({ Deal: '5', Order: '0', Action: 2 }), ecn);
    expect(deal?.orderId).toBeNull();
  });
});

/**
 * A record with no symbol must not reach the charting library.
 *
 * The library subscribes QUOTES for every Account Manager row it is given, so
 * a symbol-less row asks its quote machinery to look up nothing. That is the
 * shape of the errors QA reported on every Account Manager tab switch — "Got
 * undefined in quoteAddSymbols", plus index reads on undefined in
 * quoteAddSymbols / quoteRemoveSymbols / quoteFastSymbols.
 *
 * `mapTvOrderHistory` has always refused these. Live orders and positions —
 * the records that actually become rows — did not, which is the inconsistency
 * pinned here. Whether it is the cause of that report is unproven: it could not
 * be reproduced without live orders in the table.
 */
describe('records with no symbol', () => {
  const order = (symbol: string) =>
    tvOrderSchema.parse({
      id: '5001',
      symbol,
      side: -1,
      type: 1,
      qty: 5_000,
      limitPrice: 2400.5,
      stopPrice: 0,
      status: 6,
    });
  // The suite's own position builder, so this pins the real DTO shape.
  const positionWith = (symbol: string) => position({ symbol });

  it('drops a live order that carries no symbol', () => {
    expect(mapTvOrder(order(''), ecn)).toBeNull();
  });

  it('drops a live order whose symbol is only whitespace', () => {
    expect(mapTvOrder(order('   '), ecn)).toBeNull();
  });

  it('drops a position that carries no symbol', () => {
    expect(mapTvPosition(positionWith(''), ecn)).toBeNull();
  });

  it('still maps a normal order and position', () => {
    expect(mapTvOrder(order('XAUUSD.'), ecn)?.displaySymbol).toBe('XAUUSD');
    expect(mapTvPosition(positionWith('EURUSD.'), ecn)?.displaySymbol).toBe('EURUSD');
  });
});

/**
 * MT5 derives an instrument's type from its symbol PATH, which on a suffixed
 * deployment carries the account GROUP's marker. GBPUSD! on a Standard account
 * reported its type as "Forex!" in the symbol details panel — the suffix
 * identifies the group, never the asset class.
 */
describe('symbol type across suffixed deployments', () => {
  const symbolDto = (raw: Record<string, unknown>) =>
    tvSymbolSchema.parse({
      ticker: 'GBPUSD!',
      name: 'GBPUSD!',
      description: 'Great Britain Pound vs US Dollar',
      type: 'Forex!',
      session: '24x7',
      timezone: 'Etc/UTC',
      exchange: 'TradePlatform',
      listed_exchange: 'TradePlatform',
      format: 'price',
      pricescale: 100000,
      minmov: 1,
      volume_precision: 2,
      data_status: 'streaming',
      has_intraday: true,
      has_daily: true,
      has_weekly_and_monthly: true,
      supported_resolutions: ['1'],
      intraday_multipliers: ['1'],
      has_empty_bars: false,
      visible_plots_set: 'ohlcv',
      currency_code: 'USD',
      base_name: 'GBPUSD',
      full_name: 'GBPUSD',
      pro_name: 'GBPUSD',
      sector: '',
      industry: '',
      delay: 0,
      volume: 0,
      ...raw,
    });

  it('strips the account group suffix from the type', () => {
    const std = new SymbolSuffixPolicy('!');
    expect(mapTvSymbol(symbolDto({}), std).type).toBe('Forex');
    // And the name it belongs to is stripped by the same policy, as always.
    expect(mapTvSymbol(symbolDto({}), std).displayName).toBe('GBPUSD');
  });

  it('leaves a type alone on a deployment with no suffix', () => {
    expect(mapTvSymbol(symbolDto({ type: 'Forex' }), NO_SUFFIX_POLICY).type).toBe('Forex');
  });

  it('does not invent a type where the gateway sent none', () => {
    const std = new SymbolSuffixPolicy('!');
    expect(mapTvSymbol(symbolDto({ type: '' }), std).type).toBe('');
  });

  it('takes the profit currency from the raw MT5 record only', () => {
    // The TV shape's currency_code is CurrencyBase (by-name) or even the
    // symbol NAME (by-mask) — trusting it ran EURUSD's USD figures through an
    // EUR→USD conversion they did not need (2026-08-24).
    const dto = symbolDto({ currency_code: 'EUR' });
    expect(mapTvSymbol(dto, NO_SUFFIX_POLICY, { CurrencyProfit: 'USD' }).currencyCode).toBe('USD');
    expect(mapTvSymbol(dto, NO_SUFFIX_POLICY).currencyCode).toBeNull();
  });
});

describe('mapAccountState currency', () => {
  it('falls back to the CRM list currency when MT5 sends none — and MT5 wins when it answers', () => {
    // This trading server's get_trade_state carries no Currency; the null was
    // taking the whole Order info block down to "—" (2026-08-24).
    const silent = mapAccountState('123', { Balance: 100 }, { currency: 'USD' });
    expect(silent.currency).toBe('USD');

    const spoken = mapAccountState('123', { Currency: 'EUR' }, { currency: 'USD' });
    expect(spoken.currency).toBe('EUR');

    const nobody = mapAccountState('123', { Balance: 100 });
    expect(nobody.currency).toBeNull();
  });
});
