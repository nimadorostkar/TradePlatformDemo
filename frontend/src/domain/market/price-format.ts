import type { DecimalString } from '@/domain/common/decimal';

/**
 * A price at the instrument's own precision.
 *
 * MT5 sends prices as floats, so 1.16720 arrives as 1.1657-style values with
 * their trailing zeros already gone — the digit was never in the number. Only
 * the instrument can say how many decimals it prices to, so every surface that
 * shows a price has to be told, and any that is not silently shows a different
 * price from the one beside it.
 *
 * Returns null for an absent price so callers keep rendering "unavailable"
 * rather than a fabricated zero.
 */
export function formatPrice(
  value: DecimalString | number | null | undefined,
  digits: number,
): string | null {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  const places = Number.isFinite(digits) && digits >= 0 ? Math.min(Math.trunc(digits), 20) : 0;
  return numeric.toFixed(places);
}

/**
 * A price split into the three parts a trader actually reads.
 *
 * Nobody reads 1.16783 left to right. The big figure barely moves within a
 * session, the pip is what is being watched, and the fractional pip — the last
 * digit of a 5- or 3-digit MT5 quote — is precision, not information. Every
 * serious ladder sizes them accordingly, which is what makes a column of prices
 * scannable at a glance instead of a wall of identical digits.
 *
 * MT5 prices instruments to 5 or 3 digits when it prices in fractional pips,
 * and to 2, 4 or 0 when it does not; only the first case has a fraction to
 * split off. Returns null for a price that cannot be shown at all, so callers
 * keep their "unavailable" rendering rather than splitting a fabricated zero.
 */
export function splitPrice(
  value: DecimalString | number | null | undefined,
  digits: number,
): { lead: string; pip: string; fraction: string } | null {
  const text = formatPrice(value, digits);
  if (text === null) return null;

  const hasFractionalPip = digits === 3 || digits === 5;
  const fraction = hasFractionalPip ? text.slice(-1) : '';
  const rest = hasFractionalPip ? text.slice(0, -1) : text;
  // A price too short to have two pip digits is all pip: better to show it
  // whole than to promote its only digit and leave the lead empty of meaning.
  if (rest.length <= 2) return { lead: '', pip: rest, fraction };
  return { lead: rest.slice(0, -2), pip: rest.slice(-2), fraction };
}
