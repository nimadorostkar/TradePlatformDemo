import { dec, type DecimalString } from '@/domain/common/decimal';

/**
 * The day's numbers: open, range, and change against the previous close.
 *
 * None of this is in the quote. The gateway's quote payload is
 * `{bid, ask, lastprice, volume, time}` and carries no session data at all, so
 * a details panel built on quotes alone can only ever show 0.00 (0.00%) over a
 * day range of one point — which is exactly what the charting library's own
 * Details widget renders here.
 *
 * The daily BAR does carry it, and is already served. Deriving the summary from
 * the bar is the difference between reporting the session and inventing it.
 */

export interface SessionBar {
  time: number;
  open: DecimalString;
  high: DecimalString;
  low: DecimalString;
  close: DecimalString;
}

export interface SessionSummary {
  /** Today's opening price. */
  open: DecimalString;
  /** Session low and high, extended by the live price when it exceeds them. */
  low: DecimalString;
  high: DecimalString;
  /** Absolute and percentage move against the PREVIOUS close. */
  change: DecimalString | null;
  changePercent: DecimalString | null;
  /** Where the live price sits in the day's range, 0–100. Null if no range. */
  position: number | null;
}

/**
 * Builds the session summary from the day's bar and the live price.
 *
 * `bars` is expected newest-last, as the history endpoints return. The last bar
 * is today; the one before it supplies the previous close that change is
 * measured against — the convention every quote board uses. With only one bar
 * there is no previous close, so change is reported as absent rather than
 * silently measured from today's open, which would be a different statistic
 * wearing the same label.
 *
 * The live price EXTENDS the range. A bar fetched a minute ago does not know
 * about the tick that just set a new high, and a range that excludes the price
 * printed above it is visibly wrong.
 */
export function sessionSummary(
  bars: readonly SessionBar[],
  livePrice: DecimalString | null,
): SessionSummary | null {
  const today = bars[bars.length - 1];
  if (!today) return null;

  const live =
    livePrice !== null && dec(livePrice).isFinite() && dec(livePrice).greaterThan(0)
      ? dec(livePrice)
      : null;

  let low = dec(today.low);
  let high = dec(today.high);
  if (live) {
    if (live.lessThan(low)) low = live;
    if (live.greaterThan(high)) high = live;
  }

  const previous = bars.length >= 2 ? bars[bars.length - 2] : undefined;
  const reference = previous ? dec(previous.close) : null;
  const current = live ?? dec(today.close);

  let change: DecimalString | null = null;
  let changePercent: DecimalString | null = null;
  if (reference && reference.greaterThan(0)) {
    change = current.minus(reference).toString() as DecimalString;
    changePercent = current
      .minus(reference)
      .dividedBy(reference)
      .times(100)
      .toString() as DecimalString;
  }

  // Where the price sits in the range, for the marker under the bar.
  const span = high.minus(low);
  const position = span.greaterThan(0)
    ? Math.min(100, Math.max(0, current.minus(low).dividedBy(span).times(100).toNumber()))
    : null;

  return {
    open: today.open,
    low: low.toString() as DecimalString,
    high: high.toString() as DecimalString,
    change,
    changePercent,
    position,
  };
}
