import type { ExecutionDto } from '@/integrations/gateway/api/features-api';
import type { SymbolSuffixPolicy } from '@/integrations/gateway/mappers/symbol-suffix';
import type { Execution } from '../types';
import { TV_SIDE } from '../types';

/**
 * Gateway fills → TradingView execution arrows.
 *
 * The library plots these at an exact price and time, so anything it cannot be
 * told truthfully is left off the chart entirely rather than approximated. A
 * misplaced arrow is worse than a missing one: a trader reads it as evidence of
 * where they were actually filled.
 */

/** How far back fills are fetched for the chart. */
export const EXECUTIONS_LOOKBACK_DAYS = 30;

/**
 * Maps one fill, or null when it cannot be plotted honestly.
 *
 * Dropped when the price or quantity is not a finite positive number, or when
 * the side code is not one the gateway documents — an arrow drawn on the wrong
 * side of the market misrepresents the trade outright.
 */
export function toLibraryExecution(
  dto: ExecutionDto,
  suffix: SymbolSuffixPolicy,
): Execution | null {
  const price = Number(dto.price);
  const qty = Number(dto.qty);
  if (!Number.isFinite(price) || price <= 0) return null;
  if (!Number.isFinite(qty) || qty <= 0) return null;

  // MT5 deal actions: 0 buy, 1 sell. Anything else (balance, credit, charge)
  // is an account entry, not a trade, and has no place on a price chart.
  const side = dto.side === 0 ? TV_SIDE.Buy : dto.side === 1 ? TV_SIDE.Sell : null;
  if (side === null) return null;

  // `time` is milliseconds and `timeSeconds` the same instant in seconds; the
  // library wants milliseconds. Prefer the explicit seconds field when the
  // millisecond one is missing or implausible.
  const time = Number.isFinite(dto.time) && dto.time > 0 ? dto.time : (dto.timeSeconds ?? 0) * 1000;
  if (!Number.isFinite(time) || time <= 0) return null;

  const commission =
    dto.commission === null || dto.commission === undefined ? undefined : Number(dto.commission);

  return {
    symbol: suffix.toDisplay(dto.symbol),
    price,
    qty,
    side,
    time,
    ...(commission !== undefined && Number.isFinite(commission) ? { commission } : {}),
  };
}

export function toLibraryExecutions(
  dtos: readonly ExecutionDto[],
  suffix: SymbolSuffixPolicy,
): Execution[] {
  const mapped: Execution[] = [];
  for (const dto of dtos) {
    const execution = toLibraryExecution(dto, suffix);
    if (execution !== null) mapped.push(execution);
  }
  return mapped;
}

/** The cursor for the executions request: `lookback` days ago, in seconds. */
export function executionsCursorSeconds(now = Date.now(), lookbackDays = EXECUTIONS_LOOKBACK_DAYS) {
  return Math.floor((now - lookbackDays * 24 * 60 * 60 * 1000) / 1000);
}
