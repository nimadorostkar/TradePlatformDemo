import Decimal from 'decimal.js';

/**
 * Decimal-safe money/price/volume primitives.
 *
 * Rule: raw decimal STRINGS survive as long as possible. Binary floating point
 * is never used for a value that is displayed as money or sent to the gateway.
 * `number` appears only where the TradingView library's own API demands it, and
 * that conversion is explicit and localised.
 */

Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_UP, toExpNeg: -18, toExpPos: 21 });

/** A decimal value carried as a string. Nominal type prevents accidental math. */
export type DecimalString = string & { readonly __decimal: unique symbol };

export function dec(value: string | number | Decimal): Decimal {
  return value instanceof Decimal ? value : new Decimal(value);
}

/** Narrows an arbitrary string/number to a DecimalString, or null if invalid. */
export function toDecimalString(value: unknown): DecimalString | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  try {
    const d = new Decimal(value);
    if (!d.isFinite()) return null;
    return d.toFixed() as DecimalString;
  } catch {
    return null;
  }
}

/** Like `toDecimalString` but yields "0" instead of null. Use only where the
 *  gateway genuinely means zero, never to paper over a missing field. */
export function toDecimalStringOrZero(value: unknown): DecimalString {
  return toDecimalString(value) ?? ('0' as DecimalString);
}

export function decimalStringOf(value: Decimal | string | number): DecimalString {
  return dec(value).toFixed() as DecimalString;
}

export const ZERO = '0' as DecimalString;

export function isZero(value: DecimalString | null | undefined): boolean {
  if (value === null || value === undefined) return true;
  return dec(value).isZero();
}

export function add(a: DecimalString, b: DecimalString): DecimalString {
  return decimalStringOf(dec(a).plus(dec(b)));
}

export function sub(a: DecimalString, b: DecimalString): DecimalString {
  return decimalStringOf(dec(a).minus(dec(b)));
}

export function mul(a: DecimalString, b: DecimalString): DecimalString {
  return decimalStringOf(dec(a).times(dec(b)));
}

export function div(a: DecimalString, b: DecimalString): DecimalString | null {
  const divisor = dec(b);
  if (divisor.isZero()) return null;
  return decimalStringOf(dec(a).dividedBy(divisor));
}

export function cmp(a: DecimalString, b: DecimalString): -1 | 0 | 1 {
  return dec(a).comparedTo(dec(b)) as -1 | 0 | 1;
}

export function isNegative(value: DecimalString): boolean {
  return dec(value).isNegative() && !dec(value).isZero();
}

/**
 * Rounds a volume DOWN to the symbol's step, then clamps into [min, max].
 * Rounding down is deliberate: rounding a lot size up can exceed the risk the
 * trader intended or the margin they hold.
 */
export function quantizeVolume(
  value: DecimalString,
  step: DecimalString,
  min: DecimalString,
  max: DecimalString,
): DecimalString {
  const s = dec(step);
  let v = dec(value);
  if (s.isPositive() && !s.isZero()) {
    v = v.dividedBy(s).floor().times(s);
  }
  const lo = dec(min);
  const hi = dec(max);
  if (v.lessThan(lo)) v = lo;
  if (hi.isPositive() && v.greaterThan(hi)) v = hi;
  return decimalStringOf(v);
}

/** True when `value` sits exactly on the `step` grid measured from `min`. */
export function isOnVolumeStep(
  value: DecimalString,
  step: DecimalString,
  min: DecimalString,
): boolean {
  const s = dec(step);
  if (s.isZero() || s.isNegative()) return true;
  return dec(value).minus(dec(min)).dividedBy(s).mod(1).isZero();
}

/**
 * True when `value` sits exactly on the instrument's price grid.
 *
 * Unlike a volume step, a price grid is measured from ZERO — MT5 prices are
 * multiples of the tick, not offsets from some minimum. A zero or negative
 * tick means the instrument states no grid, which is treated as "any price is
 * on it" rather than as a division by zero.
 */
export function isOnPriceStep(value: DecimalString, step: DecimalString): boolean {
  const s = dec(step);
  if (s.isZero() || s.isNegative()) return true;
  return dec(value).dividedBy(s).mod(1).isZero();
}

/** Rounds a price to the symbol's digits, half-up. */
export function roundToDigits(value: DecimalString, digits: number): DecimalString {
  return dec(value).toFixed(Math.max(0, digits)) as DecimalString;
}

/**
 * Snaps a price onto the instrument's tick grid, half-up.
 *
 * A chart click lands between ticks almost every time; the trading server
 * rejects (or silently adjusts) an off-grid pending price, so the snap happens
 * here where the trader can still see the exact price being submitted. A
 * zero or negative tick disables snapping rather than dividing by zero.
 */
export function snapPriceToTick(value: DecimalString, tickSize: DecimalString): DecimalString {
  const tick = dec(tickSize);
  if (tick.isZero() || tick.isNegative()) return value;
  return decimalStringOf(
    dec(value).dividedBy(tick).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).times(tick),
  );
}

/**
 * Converts to `number` for an API that cannot accept a string (the TradingView
 * library and the gateway's JSON numeric fields). Kept explicit so every lossy
 * conversion is greppable.
 */
export function toNumber(value: DecimalString): number {
  return dec(value).toNumber();
}
