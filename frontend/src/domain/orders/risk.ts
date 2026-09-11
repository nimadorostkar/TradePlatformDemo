import {
  dec,
  decimalStringOf,
  snapPriceToTick,
  toDecimalString,
  type DecimalString,
} from '@/domain/common/decimal';
import { priceStepOf } from './validation';
import type { Side, TradingSymbol } from '@/domain/common/models';

/**
 * Risk sizing.
 *
 * Every output is an ESTIMATE and is labelled as such in the UI. The gateway
 * and MT5 remain authoritative for margin, commission, and swap.
 *
 * The critical rule: when an input the maths depends on is unavailable, this
 * returns `null` with a reason. It never substitutes a plausible default —
 * a lot size computed from a guessed tick value is a real position at the
 * wrong risk.
 */

export interface RiskInputs {
  symbol: TradingSymbol | undefined;
  equity: DecimalString | null;
  /** Percent of equity to risk, e.g. "1" for 1%. */
  riskPercent?: string;
  /** Absolute risk amount in account currency. Takes precedence if set. */
  riskAmount?: string;
  entryPrice: DecimalString | null;
  stopLossPrice: DecimalString | null;
  takeProfitPrice?: DecimalString | null;
  side: Side;
}

export interface RiskOutputs {
  /** Distance from entry to stop, in price units. */
  stopDistance: DecimalString | null;
  takeProfitDistance: DecimalString | null;
  /** The amount at risk in account currency. */
  riskAmount: DecimalString | null;
  /** Suggested volume in lots, or null with a reason. */
  suggestedVolume: DecimalString | null;
  potentialLoss: DecimalString | null;
  potentialProfit: DecimalString | null;
  riskRewardRatio: DecimalString | null;
  /** Populated when a value could not be calculated. */
  unavailable: readonly string[];
}

export function calculateRisk(inputs: RiskInputs): RiskOutputs {
  const unavailable: string[] = [];

  const { symbol, entryPrice, stopLossPrice, takeProfitPrice, equity } = inputs;

  if (!symbol) {
    return emptyOutputs(['Select a symbol.']);
  }

  // ── stop distance ──────────────────────────────────────────────────────────
  let stopDistance: DecimalString | null = null;
  if (entryPrice !== null && stopLossPrice !== null) {
    const distance = dec(entryPrice).minus(dec(stopLossPrice)).abs();
    stopDistance = distance.isZero() ? null : decimalStringOf(distance);
    if (stopDistance === null) unavailable.push('Stop-loss must differ from the entry price.');
  } else {
    unavailable.push('Enter an entry price and a stop-loss to size the position.');
  }

  let takeProfitDistance: DecimalString | null = null;
  if (entryPrice !== null && takeProfitPrice) {
    takeProfitDistance = decimalStringOf(dec(entryPrice).minus(dec(takeProfitPrice)).abs());
  }

  // ── risk amount ────────────────────────────────────────────────────────────
  let riskAmount: DecimalString | null = null;
  if (inputs.riskAmount && inputs.riskAmount.trim() !== '') {
    const parsed = dec(inputs.riskAmount);
    if (parsed.isFinite() && parsed.isPositive()) riskAmount = decimalStringOf(parsed);
  } else if (inputs.riskPercent && equity !== null) {
    const percent = dec(inputs.riskPercent);
    if (percent.isFinite() && percent.isPositive()) {
      riskAmount = decimalStringOf(dec(equity).times(percent).dividedBy(100));
    }
  } else if (equity === null) {
    unavailable.push('Account equity is unavailable.');
  }

  // ── volume ─────────────────────────────────────────────────────────────────
  //
  // Loss per lot = stopDistance / tickSize × tickValue.
  //
  // Both tickSize and tickValue come from the RAW MT5 symbol record. The
  // TradingView symbol shape does not carry them, so if the raw record was
  // unavailable we stop here rather than guessing.
  let suggestedVolume: DecimalString | null = null;
  let potentialLoss: DecimalString | null = null;

  const tickSize = symbol.tickSize;
  const tickValue = symbol.tickValue;

  if (tickSize === null || tickValue === null) {
    unavailable.push(
      'Tick size and tick value are unavailable for this symbol, so position size cannot be calculated.',
    );
  } else if (stopDistance !== null && riskAmount !== null) {
    const tickSizeDec = dec(tickSize);
    const tickValueDec = dec(tickValue);

    if (tickSizeDec.isZero() || tickValueDec.isZero()) {
      unavailable.push('This symbol reports a zero tick size or tick value.');
    } else {
      const lossPerLot = dec(stopDistance).dividedBy(tickSizeDec).times(tickValueDec);
      if (lossPerLot.isZero()) {
        unavailable.push('The stop distance is too small to size a position.');
      } else {
        const rawVolume = dec(riskAmount).dividedBy(lossPerLot);

        // Quantise DOWN to the symbol's step: rounding up would risk more than
        // the trader asked for.
        const step = symbol.volumeStep === null ? null : dec(symbol.volumeStep);
        const quantised =
          step && step.isPositive() ? rawVolume.dividedBy(step).floor().times(step) : rawVolume;

        // `isPositive()` is true for zero in decimal.js, so a strict
        // greater-than is required — otherwise a risk budget too small for one
        // step would report a volume of "0" instead of saying it cannot size.
        if (quantised.greaterThan(0)) {
          suggestedVolume = decimalStringOf(quantised);
          potentialLoss = decimalStringOf(quantised.times(lossPerLot));
        } else {
          unavailable.push('The risk amount is too small for the minimum volume on this symbol.');
        }
      }
    }
  }

  // ── reward ─────────────────────────────────────────────────────────────────
  let potentialProfit: DecimalString | null = null;
  if (
    suggestedVolume !== null &&
    takeProfitDistance !== null &&
    tickSize !== null &&
    tickValue !== null &&
    !dec(tickSize).isZero()
  ) {
    potentialProfit = decimalStringOf(
      dec(takeProfitDistance)
        .dividedBy(dec(tickSize))
        .times(dec(tickValue))
        .times(dec(suggestedVolume)),
    );
  }

  let riskRewardRatio: DecimalString | null = null;
  if (stopDistance !== null && takeProfitDistance !== null && !dec(stopDistance).isZero()) {
    riskRewardRatio = decimalStringOf(dec(takeProfitDistance).dividedBy(dec(stopDistance)));
  }

  return {
    stopDistance,
    takeProfitDistance,
    riskAmount,
    suggestedVolume,
    potentialLoss,
    potentialProfit,
    riskRewardRatio,
    unavailable,
  };
}

function emptyOutputs(unavailable: string[]): RiskOutputs {
  return {
    stopDistance: null,
    takeProfitDistance: null,
    riskAmount: null,
    suggestedVolume: null,
    potentialLoss: null,
    potentialProfit: null,
    riskRewardRatio: null,
    unavailable,
  };
}

/**
 * Converts a pip/point distance into a price offset.
 * Pip size is 10× the tick for 5-digit FX quotes and equal to it otherwise —
 * the standard broker convention.
 */
export function pipSize(symbol: TradingSymbol): DecimalString | null {
  if (symbol.tickSize === null) {
    // Fall back to the price scale, which is always present.
    if (symbol.digits <= 0) return null;
    const raw = dec(10).pow(-symbol.digits);
    const isFractional = symbol.digits === 3 || symbol.digits === 5;
    return decimalStringOf(isFractional ? raw.times(10) : raw);
  }
  const tick = dec(symbol.tickSize);
  const isFractional = symbol.digits === 3 || symbol.digits === 5;
  return decimalStringOf(isFractional ? tick.times(10) : tick);
}

/** entry ± (pips × pipSize), on the protective side for the given intent. */
export function priceFromPips(
  entry: DecimalString,
  pips: string,
  symbol: TradingSymbol,
  direction: 'above' | 'below',
): DecimalString | null {
  const size = pipSize(symbol);
  if (size === null) return null;
  const offset = dec(pips).times(dec(size));
  if (!offset.isFinite()) return null;
  const result = direction === 'above' ? dec(entry).plus(offset) : dec(entry).minus(offset);
  return snapPriceToTick(decimalStringOf(result), priceStepOf(symbol));
}

// ── Bracket unit conversion ──────────────────────────────────────────────────

/** How a trader expressed a stop-loss or take-profit level. */
export type BracketUnit = 'price' | 'pips' | 'percent' | 'money';

export interface BracketConversionInput {
  unit: BracketUnit;
  /** The number the trader typed, in whatever unit they chose. */
  value: string;
  entryPrice: DecimalString;
  symbol: TradingSymbol;
  side: Side;
  /** Which side of entry the level sits on. */
  kind: 'stopLoss' | 'takeProfit';
  /** Lots — required for the `money` unit. */
  volumeLots?: DecimalString | null;
}

export interface BracketConversion {
  price: DecimalString | null;
  /** Populated when the value could not be converted, and why. */
  unavailable: string | null;
}

/**
 * Converts a bracket expressed in pips / percent / money into an absolute price.
 *
 * A stop sits BELOW entry for a buy and above for a sell; a target is the
 * mirror. Getting that backwards would place a protective level that closes the
 * trade the moment it opens, so direction is derived here rather than left to
 * each caller.
 *
 * Returns an explicit reason instead of a number whenever the inputs required
 * for the conversion are unavailable.
 */
export function bracketToPrice(input: BracketConversionInput): BracketConversion {
  const { unit, value, entryPrice, symbol, side, kind } = input;

  if (value.trim() === '') return { price: null, unavailable: null };

  const amount = toDecimalString(value);
  if (amount === null || !dec(amount).isFinite()) {
    return { price: null, unavailable: 'Enter a number.' };
  }
  if (dec(amount).isNegative()) {
    return { price: null, unavailable: 'Enter a positive value.' };
  }

  if (unit === 'price') {
    // Handed back exactly as typed. It used to be rounded to the symbol's
    // digits here, which quietly turned an unplaceable 1.1650055 into a
    // placeable 1.16501 — the trader was never told the price they chose is
    // not one this instrument has. Validation says so instead; the value the
    // ticket shows and the value it sends are the same number.
    return { price: amount, unavailable: null };
  }

  // A stop is below entry for a buy, above for a sell. A target is the mirror.
  const below = kind === 'stopLoss' ? side === 'buy' : side === 'sell';
  const direction = below ? 'below' : 'above';

  if (unit === 'pips') {
    const price = priceFromPips(entryPrice, amount, symbol, direction);
    return price === null
      ? { price: null, unavailable: 'Pip size is unavailable for this symbol.' }
      : { price, unavailable: null };
  }

  if (unit === 'percent') {
    // Percent of the ENTRY PRICE, which is the common broker convention.
    const offset = dec(entryPrice).times(dec(amount)).dividedBy(100);
    const result = below ? dec(entryPrice).minus(offset) : dec(entryPrice).plus(offset);
    return {
      price: snapPriceToTick(decimalStringOf(result), priceStepOf(symbol)),
      unavailable: null,
    };
  }

  // money: distance = amount / (volume x tickValue / tickSize)
  const { tickSize, tickValue } = symbol;
  if (tickSize === null || tickValue === null) {
    return {
      price: null,
      unavailable: 'Tick size and value are unavailable, so a cash amount cannot be converted.',
    };
  }
  const volume = input.volumeLots;
  if (volume === null || volume === undefined || dec(volume).lessThanOrEqualTo(0)) {
    return { price: null, unavailable: 'Enter a volume before using a cash amount.' };
  }
  const valuePerPrice = dec(volume).times(dec(tickValue)).dividedBy(dec(tickSize));
  if (valuePerPrice.isZero()) {
    return { price: null, unavailable: 'This symbol reports a zero tick value.' };
  }

  const distance = dec(amount).dividedBy(valuePerPrice);
  const result = below ? dec(entryPrice).minus(distance) : dec(entryPrice).plus(distance);
  if (result.lessThanOrEqualTo(0)) {
    return { price: null, unavailable: 'That amount is larger than the instrument price allows.' };
  }

  return {
    price: snapPriceToTick(decimalStringOf(result), priceStepOf(symbol)),
    unavailable: null,
  };
}
