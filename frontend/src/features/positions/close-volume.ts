import {
  cmp,
  dec,
  isOnVolumeStep,
  quantizeVolume,
  toDecimalString,
  type DecimalString,
} from '@/domain/common/decimal';
import type { Position, TradingSymbol } from '@/domain/common/models';

export interface CloseVolumeValidation {
  volume: DecimalString | null;
  error: string | null;
}

/**
 * Validates a close volume against the position and the symbol's step grid.
 * Kept apart from the dialog: this is the arithmetic that decides how much of
 * a real position gets closed, and it is tested on its own.
 */
export function validateCloseVolume(
  raw: string,
  position: Position,
  symbol: TradingSymbol | undefined,
): CloseVolumeValidation {
  const parsed = toDecimalString(raw);
  if (parsed === null) return { volume: null, error: 'Enter a valid volume.' };
  if (dec(parsed).lessThanOrEqualTo(0)) {
    return { volume: null, error: 'Volume must be greater than zero.' };
  }
  if (cmp(parsed, position.volume) > 0) {
    return { volume: null, error: `Cannot close more than ${position.volume} lots.` };
  }

  const isFull = cmp(parsed, position.volume) === 0;

  // A FULL close is always allowed: the position's own size is by definition a
  // size the server accepted. Step and minimum only constrain a partial.
  if (!isFull && symbol?.volumeStep && symbol?.volumeMin) {
    if (cmp(parsed, symbol.volumeMin) < 0) {
      return { volume: null, error: `Minimum volume is ${symbol.volumeMin}.` };
    }
    if (!isOnVolumeStep(parsed, symbol.volumeStep, symbol.volumeMin)) {
      return { volume: null, error: `Volume must be a multiple of ${symbol.volumeStep}.` };
    }
    // Leaving a remainder below the minimum would strand an uncloseable scrap.
    const remainder = dec(position.volume).minus(dec(parsed));
    if (remainder.greaterThan(0) && remainder.lessThan(dec(symbol.volumeMin))) {
      return {
        volume: null,
        error: `That would leave ${remainder.toFixed()} lots, below the ${symbol.volumeMin} minimum.`,
      };
    }
  }

  return { volume: parsed, error: null };
}

/** A fraction of the open volume, snapped down onto the symbol's step grid. */
export function partialVolume(
  total: DecimalString,
  fraction: number,
  symbol: TradingSymbol | undefined,
): DecimalString | null {
  if (fraction >= 1) return total;

  const raw = dec(total).times(fraction);
  if (!symbol?.volumeStep || !symbol?.volumeMin) return raw.toFixed() as DecimalString;

  const snapped = quantizeVolume(
    raw.toFixed() as DecimalString,
    symbol.volumeStep,
    symbol.volumeMin,
    total,
  );
  return cmp(snapped, total) >= 0 ? null : snapped;
}
