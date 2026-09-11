import { dec, decimalStringOf, type DecimalString } from '@/domain/common/decimal';
import type { TradingSymbol } from '@/domain/common/models';
import { pipSize } from './risk';

/**
 * The economics of one order or position, in the ACCOUNT currency: pip value,
 * trade value, margin used, margin available, leverage. Rendered as the
 * "Order info" block under the ticket's brackets and as "Position info" in the
 * modify dialog — the same maths from the same inputs, so a position opened at
 * the order's price shows exactly what the ticket promised.
 *
 * Same rule as the rest of this directory: an input that is unavailable makes
 * the OUTPUT unavailable (null → rendered "—"), never a plausible zero. These
 * are estimates; MT5 stays authoritative for the margin actually charged.
 */

export interface OrderInfoInputs {
  symbol: TradingSymbol | undefined;
  /** Lots. */
  volumeLots: DecimalString | null;
  /**
   * The reference price: current ask/bid for a market order, the typed entry
   * for a pending order, the OPEN price for a position.
   */
  price: DecimalString | null;
  /**
   * Cross rate from the symbol's QUOTE (profit) currency to the account
   * currency. "1" when they are the same; null when no conversion could be
   * resolved from the quotes feed.
   */
  quoteToAccountRate: DecimalString | null;
  /** Account leverage, e.g. "300" for 1:300. */
  leverage: DecimalString | null;
  /** The account's current free margin, already in account currency. */
  marginFree: DecimalString | null;
}

export interface OrderInfoValues {
  /** Value of one pip for this volume, in account currency. */
  pipValue: DecimalString | null;
  /** Notional value of the trade, in account currency. */
  tradeValue: DecimalString | null;
  /** Margin this trade requires, in account currency. */
  marginUsed: DecimalString | null;
  /** The account's free margin as it stands NOW (before this order). */
  marginAvailable: DecimalString | null;
  /** Account leverage, e.g. "300". */
  leverage: DecimalString | null;
}

export function computeOrderInfo(inputs: OrderInfoInputs): OrderInfoValues {
  const { symbol, volumeLots, price, quoteToAccountRate, leverage, marginFree } = inputs;

  const empty: OrderInfoValues = {
    pipValue: null,
    tradeValue: null,
    marginUsed: null,
    marginAvailable: marginFree,
    leverage: positiveOrNull(leverage),
  };
  if (!symbol || volumeLots === null || !dec(volumeLots).greaterThan(0)) return empty;

  const volume = dec(volumeLots);
  const contractSize = symbol.contractSize === null ? null : dec(symbol.contractSize);
  const rate = quoteToAccountRate === null ? null : dec(quoteToAccountRate);

  // ── trade value ────────────────────────────────────────────────────────────
  // volume × contractSize × price, quote currency → account currency.
  let tradeValue: DecimalString | null = null;
  if (
    price !== null &&
    dec(price).greaterThan(0) &&
    contractSize !== null &&
    contractSize.greaterThan(0) &&
    rate !== null &&
    rate.greaterThan(0)
  ) {
    tradeValue = decimalStringOf(volume.times(contractSize).times(dec(price)).times(rate));
  }

  // ── margin used ────────────────────────────────────────────────────────────
  // tradeValue / leverage. MT5 knows per-group margin rates this client does
  // not; where the server later disagrees, the Account Summary is the truth.
  let marginUsed: DecimalString | null = null;
  const lev = positiveOrNull(leverage);
  if (tradeValue !== null && lev !== null) {
    marginUsed = decimalStringOf(dec(tradeValue).dividedBy(dec(lev)));
  }

  // ── pip value ──────────────────────────────────────────────────────────────
  // Preferred: (pipSize / tickSize) × tickValue × volume — tickValue is already
  // in the account currency. This server does NOT report a tick value for at
  // least EURUSD, so the FX-conversion fallback is a first-class path, not an
  // edge case: volume × contractSize × pipSize × rate.
  let pipValue: DecimalString | null = null;
  const pip = pipSize(symbol);
  if (pip !== null) {
    const { tickSize, tickValue } = symbol;
    if (tickSize !== null && tickValue !== null && !dec(tickSize).isZero()) {
      pipValue = decimalStringOf(
        dec(pip).dividedBy(dec(tickSize)).times(dec(tickValue)).times(volume),
      );
    } else if (contractSize !== null && rate !== null && rate.greaterThan(0)) {
      pipValue = decimalStringOf(volume.times(contractSize).times(dec(pip)).times(rate));
    }
  }

  return {
    pipValue,
    tradeValue,
    marginUsed,
    marginAvailable: marginFree,
    leverage: lev,
  };
}

function positiveOrNull(value: DecimalString | null): DecimalString | null {
  if (value === null) return null;
  return dec(value).greaterThan(0) ? value : null;
}

/**
 * The conversion-pair candidates for quoteCcy → accountCcy, in preference
 * order. `direct` means the pair's price IS the rate; `inverse` means the
 * rate is 1/price (e.g. account USD, quote JPY → USDJPY, inverted).
 */
export function conversionCandidates(
  quoteCurrency: string,
  accountCurrency: string,
): readonly { pair: string; invert: boolean }[] {
  if (quoteCurrency === accountCurrency) return [];
  return [
    { pair: `${quoteCurrency}${accountCurrency}`, invert: false },
    { pair: `${accountCurrency}${quoteCurrency}`, invert: true },
  ];
}

/**
 * The quote→account rate from a conversion pair's bid/ask, as the mid price.
 * Null when the quote is unusable — a zero bid/ask must not become an
 * Infinity rate.
 */
export function rateFromQuote(
  bid: DecimalString,
  ask: DecimalString,
  invert: boolean,
): DecimalString | null {
  const mid = dec(bid).plus(dec(ask)).dividedBy(2);
  if (!mid.isFinite() || !mid.greaterThan(0)) return null;
  return decimalStringOf(invert ? dec(1).dividedBy(mid) : mid);
}
