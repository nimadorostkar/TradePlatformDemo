import { dec, type DecimalString } from '@/domain/common/decimal';
import type { OrderKind, Side } from '@/domain/common/models';

/**
 * The trading ladder.
 *
 * A ladder is a PRICE ladder first and a volume ladder second. Every serious
 * platform — cTrader, NinjaTrader, ATAS, Sierra Chart — renders rows stepped
 * around the live bid/ask and lets a trader work orders on them; Level 2 volume
 * enriches those rows when the venue publishes it. Building the rows out of the
 * book instead makes the whole surface disappear on a broker that publishes no
 * depth, which is exactly what happened here: MT5 answers `book/subscribe` with
 * 504 for every symbol, so the ladder had nothing to draw and no way to trade.
 *
 * Top-of-book quotes stream perfectly well, so the ladder is built from those
 * and the book is treated as the enrichment it is.
 */

/** One price level of the ladder. Volumes are present only where the book is. */
export interface LadderRow {
  price: DecimalString;
  /** Resting bid volume at this price, in lots, when the venue publishes depth. */
  bidVolume: DecimalString | null;
  askVolume: DecimalString | null;
  /** True for the two rows that straddle the spread. */
  isBest: boolean;
  /**
   * Which side of the market the row sits on.
   *
   * A trader reads a ladder by finding the market and then reading OUTWARD, so
   * the half a row belongs to is a property of the row, not a fact the view
   * should re-derive by comparing prices it was handed as strings.
   */
  band: 'ask' | 'bid';
}

/** The smallest price increment for an instrument with this many digits. */
export function tickSize(digits: number): DecimalString {
  return dec(10).pow(-digits).toFixed(digits) as DecimalString;
}

/**
 * Builds the ladder around the current market.
 *
 * Rows run high to low, the way every ladder is drawn: asks above, bids below.
 * The two rows either side of the spread are marked so the UI can anchor on
 * them — a trader reads a ladder by finding the market first.
 */
export function buildLadder(input: {
  bid: DecimalString;
  ask: DecimalString;
  digits: number;
  /** Rows to draw on EACH side of the spread. */
  depth: number;
  bidVolumes?: ReadonlyMap<string, DecimalString>;
  askVolumes?: ReadonlyMap<string, DecimalString>;
}): LadderRow[] {
  const { bid, ask, digits, depth } = input;
  const tick = dec(tickSize(digits));
  if (tick.lessThanOrEqualTo(0) || depth <= 0) return [];

  const rows: LadderRow[] = [];
  const at = (price: string, band: 'ask' | 'bid'): LadderRow => ({
    price: price as DecimalString,
    bidVolume: input.bidVolumes?.get(price) ?? null,
    askVolume: input.askVolumes?.get(price) ?? null,
    isBest: price === dec(bid).toFixed(digits) || price === dec(ask).toFixed(digits),
    band,
  });

  // Above the market, descending: the top of the ladder is the furthest ask.
  for (let step = depth; step >= 1; step--) {
    rows.push(
      at(
        dec(ask)
          .plus(tick.times(step - 1))
          .toFixed(digits),
        'ask',
      ),
    );
  }
  // Below the market, descending from the best bid.
  for (let step = 0; step < depth; step++) {
    rows.push(at(dec(bid).minus(tick.times(step)).toFixed(digits), 'bid'));
  }
  return rows;
}

/**
 * The order a click on the ladder means.
 *
 * The type follows from WHERE the price sits relative to the market, which is
 * the convention every ladder shares: buying below the market rests as a limit,
 * buying above it arms as a stop, and selling is the mirror. Holding the
 * modifier forces the stop variant, so a trader can arm a breakout entry on the
 * side of the market where a limit would otherwise be the natural reading.
 *
 * Returns null when the price is on the wrong side for a stop that was forced —
 * a Buy Stop below the market would trigger instantly, and offering it would be
 * offering an order the server refuses.
 */
export function ladderOrder(input: {
  side: Side;
  price: DecimalString;
  bid: DecimalString;
  ask: DecimalString;
  /** The trader held Ctrl/⌘, asking for the stop variant explicitly. */
  forceStop?: boolean;
}): { side: Side; kind: Exclude<OrderKind, 'market'>; price: DecimalString } | null {
  const { side, price, bid, ask, forceStop } = input;
  const reference = side === 'buy' ? ask : bid;
  const above = dec(price).greaterThan(dec(reference));
  const below = dec(price).lessThan(dec(reference));

  // A buy stop must sit ABOVE the market and a sell stop BELOW it; anything
  // else is an order the trading server will refuse, so it is not offered.
  const stopIsValid = side === 'buy' ? above : below;
  if (forceStop) {
    return stopIsValid ? { side, kind: 'stop', price } : null;
  }

  const limitIsValid = side === 'buy' ? below : above;
  if (limitIsValid) return { side, kind: 'limit', price };
  if (stopIsValid) return { side, kind: 'stop', price };
  // Exactly at the reference: neither a limit nor a stop is meaningful.
  return null;
}

/** How a ladder action reads in the order ticket's "applied from" banner. */
export function ladderIntent(order: { side: Side; kind: OrderKind }): string {
  const side = order.side === 'buy' ? 'Buy' : 'Sell';
  const kind = order.kind === 'market' ? 'Market' : order.kind === 'stop' ? 'Stop' : 'Limit';
  return `${side} ${kind}`;
}

/** Indexes a book side by its formatted price, so ladder rows can look it up. */
export function volumesByPrice(
  levels: readonly { price: unknown; volume: unknown }[],
  digits: number,
): Map<string, DecimalString> {
  const out = new Map<string, DecimalString>();
  for (const level of levels) {
    const price = Number(level.price);
    const volume = Number(level.volume);
    if (!Number.isFinite(price) || price <= 0) continue;
    if (!Number.isFinite(volume) || volume <= 0) continue;
    out.set(dec(price).toFixed(digits), String(volume) as DecimalString);
  }
  return out;
}

/**
 * The spread, in the points the rest of the terminal counts them in.
 *
 * One instrument's point is 10^-digits, so a 5-digit EURUSD quote spreads in
 * fractional pips and a 3-digit JPY pair in the same unit — which is what the
 * watchlist has always shown. The ladder has to agree with it: two surfaces
 * quoting the same market in different units is a bug a trader finds the
 * expensive way.
 *
 * Null when either side is missing or the arithmetic does not survive the
 * floats MT5 sends.
 */
export function spreadPoints(
  bid: DecimalString | null | undefined,
  ask: DecimalString | null | undefined,
  digits: number,
): number | null {
  if (bid === null || bid === undefined || ask === null || ask === undefined) return null;
  const points = (Number(ask) - Number(bid)) * 10 ** digits;
  return Number.isFinite(points) ? points : null;
}
