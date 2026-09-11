import { dec, decimalStringOf, type DecimalString } from '@/domain/common/decimal';

/**
 * What changing the ACCOUNT leverage does to the margin already in use.
 *
 * MT5 margins leverage-based instruments as notional / leverage, so a move
 * from 1:A to 1:B scales the requirement by A/B. That is an ESTIMATE — some
 * instruments margin by fixed rate and ignore leverage entirely, and the
 * server remains authoritative — but it is exactly the number a trader needs
 * to see BEFORE confirming a change that re-margins every open position.
 *
 * Directory rule as ever: an unavailable input yields null, never a plausible
 * zero. `wouldExceedEquity` is the one three-state field — true/false when the
 * projection can be made, null when it cannot — because "we cannot tell" must
 * not read as "it is safe".
 */

export interface LeverageProjectionInputs {
  /** The account's current leverage, e.g. 300. */
  currentLeverage: number;
  /** The leverage being considered, e.g. 200. */
  nextLeverage: number;
  /** Margin currently in use, account currency. */
  margin: DecimalString | null;
  equity: DecimalString | null;
}

export interface LeverageProjection {
  /** Projected margin requirement after the change. */
  marginAfter: DecimalString | null;
  /** equity / margin × 100, before and after. Null when no margin is in use. */
  marginLevelBefore: DecimalString | null;
  marginLevelAfter: DecimalString | null;
  /** True when the projected requirement is more than the account's equity. */
  wouldExceedEquity: boolean | null;
}

export function projectLeverageChange(inputs: LeverageProjectionInputs): LeverageProjection {
  const { currentLeverage, nextLeverage, margin, equity } = inputs;

  const empty: LeverageProjection = {
    marginAfter: null,
    marginLevelBefore: null,
    marginLevelAfter: null,
    wouldExceedEquity: null,
  };

  if (
    !Number.isFinite(currentLeverage) ||
    !Number.isFinite(nextLeverage) ||
    currentLeverage <= 0 ||
    nextLeverage <= 0 ||
    margin === null
  ) {
    return empty;
  }

  const marginBefore = dec(margin);
  if (marginBefore.isNegative()) return empty;

  const marginAfter = marginBefore.times(currentLeverage).dividedBy(nextLeverage);

  const level = (m: typeof marginBefore): DecimalString | null => {
    if (equity === null || m.isZero()) return null;
    return decimalStringOf(dec(equity).dividedBy(m).times(100));
  };

  return {
    marginAfter: decimalStringOf(marginAfter),
    marginLevelBefore: level(marginBefore),
    marginLevelAfter: level(marginAfter),
    wouldExceedEquity: equity === null ? null : marginAfter.greaterThan(dec(equity)),
  };
}
