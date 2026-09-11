import { dec, decimalStringOf, type DecimalString } from '@/domain/common/decimal';
import type { TradingSymbol } from '@/domain/common/models';

/**
 * Quick-volume buttons derived from the instrument's own limits.
 *
 * A fixed set like 0.01 / 0.10 / 0.50 / 1.00 is wrong for anything whose
 * minimum is not 0.01 — an index with a 1.0 minimum would offer three buttons
 * that cannot be submitted. Deriving from `volumeMin` and `volumeStep` keeps
 * every preset valid for the symbol on screen.
 */

/** Multiples of the minimum to offer, chosen to span a useful range. */
const MULTIPLIERS = [1, 10, 50, 100] as const;

/** Used only when the gateway did not supply the instrument's limits. */
const FALLBACK: readonly DecimalString[] = ['0.01', '0.10', '0.50', '1.00'] as DecimalString[];

export function volumePresets(symbol: TradingSymbol | undefined): readonly DecimalString[] {
  const min = symbol?.volumeMin;
  const step = symbol?.volumeStep;
  if (!min || !step) return FALLBACK;

  const minimum = dec(min);
  const increment = dec(step);
  if (!minimum.isFinite() || minimum.lessThanOrEqualTo(0)) return FALLBACK;

  const max = symbol?.volumeMax ? dec(symbol.volumeMax) : null;
  const seen = new Set<string>();
  const presets: DecimalString[] = [];

  for (const multiplier of MULTIPLIERS) {
    let candidate = minimum.times(multiplier);

    // Snap onto the step grid measured from the minimum, so every button is a
    // volume the server will actually accept.
    if (increment.greaterThan(0)) {
      const steps = candidate.minus(minimum).dividedBy(increment).floor();
      candidate = minimum.plus(steps.times(increment));
    }
    if (max && candidate.greaterThan(max)) continue;

    const value = decimalStringOf(candidate);
    if (seen.has(value)) continue;
    seen.add(value);
    presets.push(value as DecimalString);
  }

  return presets.length > 0 ? presets : FALLBACK;
}
