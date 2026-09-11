import { useEffect, useState } from 'react';
import {
  formatDuration,
  marketState,
  minutesUntilOpen,
  type MarketState,
} from '@/domain/market/session';
import type { TradingSymbol } from '@/domain/common/models';

/**
 * Live market-open state for a symbol.
 *
 * Re-evaluated on a timer because the answer changes with the clock, not with
 * any data we receive. A minute is fine — the boundary is minute-resolution.
 */
export function useMarketState(symbol: TradingSymbol | undefined): {
  state: MarketState;
  reopensIn: string | null;
} {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, []);

  if (!symbol) return { state: 'unknown', reopensIn: null };

  const state = marketState(symbol.session, symbol.timezone, now);
  if (state !== 'closed') return { state, reopensIn: null };

  const minutes = minutesUntilOpen(symbol.session, symbol.timezone, now);
  return { state, reopensIn: minutes === null ? null : formatDuration(minutes) };
}
