import { describe, expect, it } from 'vitest';
import type { DecimalString } from '@/domain/common/decimal';
import { buildLadder, ladderOrder, tickSize, volumesByPrice, spreadPoints } from './ladder';

const d = (v: string) => v as DecimalString;

/**
 * A ladder is a PRICE ladder first. Building it out of the order book made the
 * whole trading surface vanish on this broker, whose MT5 answers every
 * `book/subscribe` with a 504 — so there were no rows to click and no way to
 * work an order from the ladder at all.
 */
describe('building the ladder', () => {
  it('draws rows around the market without any book at all', () => {
    const rows = buildLadder({ bid: d('1.16750'), ask: d('1.16760'), digits: 5, depth: 3 });

    // Asks above, bids below, high to low — the way every ladder is read.
    expect(rows.map((r) => r.price)).toEqual([
      '1.16762',
      '1.16761',
      '1.16760',
      '1.16750',
      '1.16749',
      '1.16748',
    ]);
    expect(rows.every((r) => r.bidVolume === null && r.askVolume === null)).toBe(true);
  });

  it('marks the two rows that straddle the spread', () => {
    const rows = buildLadder({ bid: d('1.16750'), ask: d('1.16760'), digits: 5, depth: 2 });
    expect(rows.filter((r) => r.isBest).map((r) => r.price)).toEqual(['1.16760', '1.16750']);
  });

  it('steps by the instrument’s own tick', () => {
    // Gold quotes to 2 digits; stepping it in 5-digit ticks would draw a ladder
    // spanning a fraction of a cent and be useless to trade on.
    const rows = buildLadder({ bid: d('4516.52'), ask: d('4516.74'), digits: 2, depth: 2 });
    expect(rows.map((r) => r.price)).toEqual(['4516.75', '4516.74', '4516.52', '4516.51']);
  });

  it('enriches rows with book volume where the venue publishes it', () => {
    const rows = buildLadder({
      bid: d('1.16750'),
      ask: d('1.16760'),
      digits: 5,
      depth: 1,
      bidVolumes: new Map([['1.16750', d('2.5')]]),
      askVolumes: new Map([['1.16760', d('1.75')]]),
    });
    expect(rows.find((r) => r.price === '1.16750')?.bidVolume).toBe('2.5');
    expect(rows.find((r) => r.price === '1.16760')?.askVolume).toBe('1.75');
  });

  it('yields nothing rather than a degenerate ladder', () => {
    expect(buildLadder({ bid: d('1.1'), ask: d('1.1'), digits: 5, depth: 0 })).toEqual([]);
  });

  it('states the tick for an instrument', () => {
    expect(tickSize(5)).toBe('0.00001');
    expect(tickSize(2)).toBe('0.01');
    expect(tickSize(3)).toBe('0.001');
  });
});

/**
 * The order a click means. The type follows from where the price sits relative
 * to the market — the convention every ladder shares — and the modifier forces
 * the stop variant, which is what the DOM test script exercises with Ctrl.
 */
describe('what a click on the ladder means', () => {
  const market = { bid: d('1.16750'), ask: d('1.16760') };

  it('buys below the market as a limit', () => {
    expect(ladderOrder({ ...market, side: 'buy', price: d('1.16700') })).toMatchObject({
      side: 'buy',
      kind: 'limit',
    });
  });

  it('buys above the market as a stop', () => {
    expect(ladderOrder({ ...market, side: 'buy', price: d('1.16800') })).toMatchObject({
      side: 'buy',
      kind: 'stop',
    });
  });

  it('sells above the market as a limit', () => {
    expect(ladderOrder({ ...market, side: 'sell', price: d('1.16800') })).toMatchObject({
      side: 'sell',
      kind: 'limit',
    });
  });

  it('sells below the market as a stop', () => {
    expect(ladderOrder({ ...market, side: 'sell', price: d('1.16700') })).toMatchObject({
      side: 'sell',
      kind: 'stop',
    });
  });

  it('forces the stop variant when the modifier is held', () => {
    // Ctrl in the Buy column, above the market: a stop, as the script expects.
    expect(
      ladderOrder({ ...market, side: 'buy', price: d('1.16800'), forceStop: true }),
    ).toMatchObject({ kind: 'stop' });
  });

  it('refuses a forced stop that would trigger the instant it is placed', () => {
    // A buy stop BELOW the market is an order the server refuses. Offering it
    // would be offering something that cannot exist.
    expect(
      ladderOrder({ ...market, side: 'buy', price: d('1.16700'), forceStop: true }),
    ).toBeNull();
    expect(
      ladderOrder({ ...market, side: 'sell', price: d('1.16800'), forceStop: true }),
    ).toBeNull();
  });

  it('offers nothing exactly at the reference price', () => {
    // Neither a limit nor a stop is meaningful at the price itself.
    expect(ladderOrder({ ...market, side: 'buy', price: d('1.16760') })).toBeNull();
    expect(ladderOrder({ ...market, side: 'sell', price: d('1.16750') })).toBeNull();
  });

  it('keeps the clicked price exactly', () => {
    // The whole point of clicking a row is the price next to it; rounding it
    // here would place an order at a level the trader never chose.
    expect(ladderOrder({ ...market, side: 'buy', price: d('1.16701') })?.price).toBe('1.16701');
  });
});

describe('indexing the book onto ladder rows', () => {
  it('keys levels by their formatted price', () => {
    const map = volumesByPrice([{ price: 1.1675, volume: 2.5 }], 5);
    expect(map.get('1.16750')).toBe('2.5');
  });

  it('ignores levels with no usable price or volume', () => {
    const map = volumesByPrice(
      [
        { price: 0, volume: 5 },
        { price: 1.1, volume: 0 },
        { price: 'x', volume: 'y' },
      ],
      5,
    );
    expect(map.size).toBe(0);
  });
});

describe('spreadPoints', () => {
  // The watchlist has always quoted the spread in 10^-digits points. The ladder
  // shows the same number beside the same market; disagreeing would be a bug a
  // trader only finds after acting on the wrong one.
  it('counts a 5-digit FX spread in fractional pips', () => {
    expect(spreadPoints('1.16782' as DecimalString, '1.16795' as DecimalString, 5)).toBeCloseTo(
      13,
      6,
    );
  });

  it("uses the instrument's own point, not a fixed one", () => {
    expect(spreadPoints('159.003' as DecimalString, '159.020' as DecimalString, 3)).toBeCloseTo(
      17,
      6,
    );
  });

  it('is null when a side is missing', () => {
    expect(spreadPoints(null, '1.16795' as DecimalString, 5)).toBeNull();
    expect(spreadPoints('1.16782' as DecimalString, undefined, 5)).toBeNull();
  });
});

describe('buildLadder bands', () => {
  // A row's half of the market is what the ladder tints, and re-deriving it in
  // the view from formatted strings is how a row ends up on the wrong side.
  it('marks every row above the market as ask and below it as bid', () => {
    const rows = buildLadder({
      bid: '1.16782' as DecimalString,
      ask: '1.16795' as DecimalString,
      digits: 5,
      depth: 3,
    });
    expect(rows.map((r) => r.band)).toEqual(['ask', 'ask', 'ask', 'bid', 'bid', 'bid']);
    // The band boundary and the best-price marks describe the same two rows.
    expect(rows.filter((r) => r.isBest).map((r) => r.price)).toEqual(['1.16795', '1.16782']);
  });
});
