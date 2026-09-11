import {
  cmp,
  dec,
  isOnPriceStep,
  isOnVolumeStep,
  toDecimalString,
  type DecimalString,
} from '@/domain/common/decimal';
import type { OrderKind, Quote, Side, TradingSymbol } from '@/domain/common/models';

/**
 * Client-side order validation.
 *
 * This catches obvious mistakes before a request is sent; the BACKEND REMAINS
 * AUTHORITATIVE. Nothing here may allow a trade the gateway would reject, and
 * nothing here may block a trade the gateway would accept just because a
 * symbol limit was unavailable — an unknown limit produces a warning, not a
 * hard failure.
 */

export type IssueSeverity = 'error' | 'warning';

export interface ValidationIssue {
  field: 'volume' | 'price' | 'stopLoss' | 'takeProfit' | 'symbol' | 'account';
  severity: IssueSeverity;
  message: string;
}

export interface OrderDraft {
  kind: OrderKind;
  side: Side;
  volume: string;
  /** Required for pending orders; ignored for market. */
  price?: string;
  stopLoss?: string;
  takeProfit?: string;
}

export interface ValidationContext {
  symbol: TradingSymbol | undefined;
  quote: Quote | undefined;
  readOnly: boolean;
  marketClosed?: boolean;
}

export interface ValidationResult {
  issues: ValidationIssue[];
  /** True when nothing at `error` severity was found. */
  canSubmit: boolean;
}

/**
 * Whether a volume is one this symbol can actually be traded in.
 *
 * Extracted from `validateOrder` because resizing a pending order has to apply
 * exactly the same rules before it cancels anything: a resize that fails the
 * broker's step or minimum would destroy a live order and then be refused when
 * placing its replacement, which is the worst outcome available.
 */
export function volumeIssues(raw: string, symbol: TradingSymbol): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const volume = toDecimalString(raw);

  if (volume === null) {
    issues.push({ field: 'volume', severity: 'error', message: 'Enter a valid volume.' });
    return issues;
  }
  if (dec(volume).lessThanOrEqualTo(0)) {
    issues.push({
      field: 'volume',
      severity: 'error',
      message: 'Volume must be greater than zero.',
    });
    return issues;
  }

  if (symbol.volumeMin !== null && cmp(volume, symbol.volumeMin) < 0) {
    issues.push({
      field: 'volume',
      severity: 'error',
      message: `Minimum volume is ${symbol.volumeMin}.`,
    });
  }
  if (symbol.volumeMax !== null && cmp(volume, symbol.volumeMax) > 0) {
    issues.push({
      field: 'volume',
      severity: 'error',
      message: `Maximum volume is ${symbol.volumeMax}.`,
    });
  }
  if (
    symbol.volumeStep !== null &&
    symbol.volumeMin !== null &&
    !isOnVolumeStep(volume, symbol.volumeStep, symbol.volumeMin)
  ) {
    issues.push({
      field: 'volume',
      severity: 'error',
      message: `Volume must be a multiple of ${symbol.volumeStep}.`,
    });
  }
  if (symbol.volumeMin === null || symbol.volumeStep === null) {
    // The TV symbol shape does not carry real volume limits; without the raw
    // MT5 record we cannot check them, and we say so rather than pretending.
    issues.push({
      field: 'volume',
      severity: 'warning',
      message: 'Volume limits for this symbol are unavailable — the server will validate them.',
    });
  }
  return issues;
}

/**
 * The smallest price increment this instrument can be traded at.
 *
 * MT5 reports TickSize as 0 to mean "not specified — use the point", and the
 * domain model maps that live zero to null on purpose (a zero reaching price
 * maths divides by zero). The tick is not UNKNOWN in that case: it is
 * 10^-digits, which is what the ladder already steps by and what the trading
 * server actually enforces. So a price step is always available, and a price
 * off it is a real error rather than a limit we could not check.
 */
export function priceStepOf(symbol: TradingSymbol): DecimalString {
  if (symbol.tickSize !== null && dec(symbol.tickSize).greaterThan(0)) return symbol.tickSize;
  return dec(10)
    .pow(-Math.max(0, symbol.digits))
    .toFixed(Math.max(0, symbol.digits)) as DecimalString;
}

/**
 * Whether a price is one this symbol can actually be traded at.
 *
 * The ticket validated volume against its step from the beginning and price
 * against nothing, so 1.1678355 on a five-digit EURUSD passed every check the
 * client made and went to the server as a valid order (found in QA, 2026-08-22).
 * A chart click was already snapped onto the grid by `snapPriceToTick`; a typed
 * price is NOT snapped, because silently rewriting a number a trader entered by
 * hand is worse than telling them it cannot be used.
 */
function priceStepIssues(
  value: DecimalString,
  field: ValidationIssue['field'],
  label: string,
  symbol: TradingSymbol,
): ValidationIssue[] {
  const step = priceStepOf(symbol);
  if (isOnPriceStep(value, step)) return [];
  return [{ field, severity: 'error', message: `${label} must be a multiple of ${step}.` }];
}

export function validateOrder(draft: OrderDraft, context: ValidationContext): ValidationResult {
  const issues: ValidationIssue[] = [];
  const { symbol, quote } = context;

  if (context.readOnly) {
    issues.push({
      field: 'account',
      severity: 'error',
      message: 'This account is read-only and cannot place trades.',
    });
  }

  if (!symbol) {
    issues.push({ field: 'symbol', severity: 'error', message: 'Select a symbol.' });
    return { issues, canSubmit: false };
  }

  if (context.marketClosed) {
    issues.push({
      field: 'symbol',
      severity: 'error',
      message: 'The market is closed for this symbol.',
    });
  }

  // ── volume ─────────────────────────────────────────────────────────────────
  issues.push(...volumeIssues(draft.volume, symbol));

  // ── entry price ────────────────────────────────────────────────────────────
  const isPending = draft.kind !== 'market';
  let entryPrice: DecimalString | null = null;

  if (isPending) {
    entryPrice = toDecimalString(draft.price ?? '');
    if (entryPrice === null) {
      issues.push({ field: 'price', severity: 'error', message: 'Enter an entry price.' });
    } else if (dec(entryPrice).lessThanOrEqualTo(0)) {
      issues.push({
        field: 'price',
        severity: 'error',
        message: 'Price must be greater than zero.',
      });
    } else {
      issues.push(...priceStepIssues(entryPrice, 'price', 'Price', symbol));
    }

    if (entryPrice !== null && dec(entryPrice).greaterThan(0) && quote) {
      // A limit above the market (buy) or a stop below it (buy) would be
      // rejected by MT5 as an invalid price — catch it before the round trip.
      const reference = draft.side === 'buy' ? quote.ask : quote.bid;
      const wrongSide =
        draft.kind === 'limit'
          ? draft.side === 'buy'
            ? cmp(entryPrice, reference) > 0
            : cmp(entryPrice, reference) < 0
          : draft.side === 'buy'
            ? cmp(entryPrice, reference) < 0
            : cmp(entryPrice, reference) > 0;

      if (wrongSide) {
        issues.push({
          field: 'price',
          severity: 'error',
          message:
            draft.kind === 'limit'
              ? `A ${draft.side} limit must be ${draft.side === 'buy' ? 'below' : 'above'} the current price.`
              : `A ${draft.side} stop must be ${draft.side === 'buy' ? 'above' : 'below'} the current price.`,
        });
      }
    }
  } else {
    entryPrice = quote ? (draft.side === 'buy' ? quote.ask : quote.bid) : null;
    // Zero is MT5's "I have no price", and a market order submitted at zero is
    // a server rejection at best. The mapper already refuses to build a quote
    // out of a priceless tick; this is the second lock on the same door.
    if (entryPrice === null || dec(entryPrice).lessThanOrEqualTo(0)) {
      entryPrice = null;
      issues.push({
        field: 'price',
        severity: 'error',
        message: 'No live price is available for this symbol.',
      });
    }
  }

  // ── protective levels ──────────────────────────────────────────────────────
  const stopLoss = toDecimalString(draft.stopLoss ?? '');
  const takeProfit = toDecimalString(draft.takeProfit ?? '');

  if (draft.stopLoss && stopLoss === null) {
    issues.push({
      field: 'stopLoss',
      severity: 'error',
      message: 'Enter a valid stop-loss price.',
    });
  }
  if (draft.takeProfit && takeProfit === null) {
    issues.push({
      field: 'takeProfit',
      severity: 'error',
      message: 'Enter a valid take-profit price.',
    });
  }

  // The same grid binds the protective levels. MT5 rejects an off-tick stop as
  // readily as an off-tick entry, and a stop refused at submit time is worse
  // than one refused while it is being typed.
  if (stopLoss !== null) {
    issues.push(...priceStepIssues(stopLoss, 'stopLoss', 'Stop-loss', symbol));
  }
  if (takeProfit !== null) {
    issues.push(...priceStepIssues(takeProfit, 'takeProfit', 'Take-profit', symbol));
  }

  if (entryPrice !== null && stopLoss !== null) {
    // A stop on the wrong side of entry would close the trade immediately.
    const invalid =
      draft.side === 'buy' ? cmp(stopLoss, entryPrice) >= 0 : cmp(stopLoss, entryPrice) <= 0;
    if (invalid) {
      issues.push({
        field: 'stopLoss',
        severity: 'error',
        message: `Stop-loss must be ${draft.side === 'buy' ? 'below' : 'above'} the entry price.`,
      });
    }
  }

  if (entryPrice !== null && takeProfit !== null) {
    const invalid =
      draft.side === 'buy' ? cmp(takeProfit, entryPrice) <= 0 : cmp(takeProfit, entryPrice) >= 0;
    if (invalid) {
      issues.push({
        field: 'takeProfit',
        severity: 'error',
        message: `Take-profit must be ${draft.side === 'buy' ? 'above' : 'below'} the entry price.`,
      });
    }
  }

  return { issues, canSubmit: !issues.some((issue) => issue.severity === 'error') };
}

export interface PositionBracketDraft {
  side: Side;
  /** Raw field text; empty means "remove this level". */
  stopLoss: string;
  takeProfit: string;
}

export interface PositionBracketContext {
  /**
   * The price that would CLOSE the position right now — the bid for a long,
   * the ask for a short. Null when no live quote is available, in which case
   * direction cannot be judged and only the format and grid are checked.
   */
  referencePrice: DecimalString | null;
  symbol?: TradingSymbol;
}

/**
 * Validates the protective levels on an OPEN position.
 *
 * Judged against the CURRENT price, not the open price. A stop is invalid
 * because it would fire the moment it is accepted, and that is decided by
 * where the market is now — a long that has run 40 pips into profit can
 * perfectly well carry a stop above its entry, which is precisely what the
 * break-even button does. The old rule called that wrong and let the genuinely
 * wrong case — a stop the far side of the market — straight through.
 */
export function validatePositionBrackets(
  draft: PositionBracketDraft,
  context: PositionBracketContext,
): ValidationResult {
  const issues: ValidationIssue[] = [];
  const { referencePrice, symbol } = context;

  const wants = (raw: string) => raw.trim() !== '';
  const stopLoss = wants(draft.stopLoss) ? toDecimalString(draft.stopLoss) : null;
  const takeProfit = wants(draft.takeProfit) ? toDecimalString(draft.takeProfit) : null;

  if (wants(draft.stopLoss) && stopLoss === null) {
    issues.push({
      field: 'stopLoss',
      severity: 'error',
      message: 'Enter a valid stop-loss price.',
    });
  }
  if (wants(draft.takeProfit) && takeProfit === null) {
    issues.push({
      field: 'takeProfit',
      severity: 'error',
      message: 'Enter a valid take-profit price.',
    });
  }

  if (stopLoss !== null && dec(stopLoss).lessThanOrEqualTo(0)) {
    issues.push({
      field: 'stopLoss',
      severity: 'error',
      message: 'Stop-loss must be greater than zero.',
    });
  }
  if (takeProfit !== null && dec(takeProfit).lessThanOrEqualTo(0)) {
    issues.push({
      field: 'takeProfit',
      severity: 'error',
      message: 'Take-profit must be greater than zero.',
    });
  }

  if (symbol) {
    if (stopLoss !== null)
      issues.push(...priceStepIssues(stopLoss, 'stopLoss', 'Stop-loss', symbol));
    if (takeProfit !== null) {
      issues.push(...priceStepIssues(takeProfit, 'takeProfit', 'Take-profit', symbol));
    }
  }

  if (referencePrice === null) {
    // Without a price there is no direction to check, and refusing to save
    // would strand a trader who wants a stop on a quiet symbol.
    if (stopLoss !== null || takeProfit !== null) {
      issues.push({
        field: 'price',
        severity: 'warning',
        message: 'No live price — the trading server will have the final say on these levels.',
      });
    }
    return { issues, canSubmit: !issues.some((issue) => issue.severity === 'error') };
  }

  const long = draft.side === 'buy';

  if (stopLoss !== null && dec(stopLoss).greaterThan(0)) {
    const wrongSide = long
      ? cmp(stopLoss, referencePrice) >= 0
      : cmp(stopLoss, referencePrice) <= 0;
    if (wrongSide) {
      issues.push({
        field: 'stopLoss',
        severity: 'error',
        message: `A stop-loss must be ${long ? 'below' : 'above'} the current price (${referencePrice}).`,
      });
    }
  }

  if (takeProfit !== null && dec(takeProfit).greaterThan(0)) {
    const wrongSide = long
      ? cmp(takeProfit, referencePrice) <= 0
      : cmp(takeProfit, referencePrice) >= 0;
    if (wrongSide) {
      issues.push({
        field: 'takeProfit',
        severity: 'error',
        message: `A take-profit must be ${long ? 'above' : 'below'} the current price (${referencePrice}).`,
      });
    }
  }

  return { issues, canSubmit: !issues.some((issue) => issue.severity === 'error') };
}

/** Convenience accessor for rendering an inline error under a field. */
export function issueFor(
  result: ValidationResult,
  field: ValidationIssue['field'],
): ValidationIssue | undefined {
  return (
    result.issues.find((i) => i.field === field && i.severity === 'error') ??
    result.issues.find((i) => i.field === field)
  );
}
