import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useServices } from '@/app/providers/services';
import { useSessionStore } from '@/stores/session-store';
import { useQuote } from '@/stores/quote-store';
import {
  sessionSummary,
  type SessionBar,
  type SessionSummary,
} from '@/domain/market/session-summary';
import type { DecimalString } from '@/domain/common/decimal';

/**
 * The day's open, range and change for a symbol.
 *
 * Sourced from the DAILY BAR, because the gateway's quote carries no session
 * data — a panel built on quotes alone can only show 0.00 (0.00%) over a range
 * of one point. Two bars are fetched: today's, and the one before it for the
 * previous close that change is measured against.
 *
 * The live quote is folded in on every tick, so the range extends and the
 * change moves without refetching. Bars themselves are cached for a minute —
 * a daily bar's open and yesterday's close do not change intraday, and only
 * its high/low can, which the live price already covers.
 */
/**
 * What the panel should say, given the query's state and what it produced.
 *
 * Split out because the interesting case is not a fetch that succeeds or one
 * that fails — it is a fetch that STOPPED. React Query aborts an in-flight
 * request when its last observer unmounts, which leaves the query at status
 * "pending" with fetchStatus "idle": no data, no error, and nothing running.
 * `isPending` alone cannot tell that apart from a request in flight, so the
 * panel sat on "Loading today's range…" indefinitely while the endpoint it was
 * waiting on answered in 200ms (seen on production 2026-08-21). It only
 * recovered when the window regained focus and React Query refetched of its
 * own accord.
 *
 * A stalled query is reported as loading — it is about to be asked again — but
 * never as unavailable, which would blame the instrument for a request this
 * client abandoned.
 *
 * Do not lift this onto a query with `enabled`: a DISABLED query is also
 * pending and idle, and it is meant to be. Retrying that one would hammer a
 * request its own hook has switched off.
 */
export function sessionPanelState(query: {
  status: 'pending' | 'success' | 'error';
  fetchStatus: 'fetching' | 'paused' | 'idle';
  summary: SessionSummary | null;
}): { loading: boolean; unavailable: boolean; stalled: boolean } {
  const stalled = query.status === 'pending' && query.fetchStatus === 'idle';
  const loading = (query.status === 'pending' && query.fetchStatus !== 'idle') || stalled;
  return { loading, unavailable: !loading && query.summary === null, stalled };
}

export function useSessionSummary(displaySymbol: string): {
  summary: SessionSummary | null;
  loading: boolean;
  /** True once the fetch has settled without a usable session. */
  unavailable: boolean;
} {
  const services = useServices();
  const suffixPolicy = useSessionStore((s) => s.suffixPolicy);
  const gatewaySymbol = suffixPolicy.toGateway(displaySymbol);
  const quote = useQuote(gatewaySymbol);

  const query = useQuery({
    queryKey: ['session-bars', gatewaySymbol],
    staleTime: 60_000,
    retry: 1,
    queryFn: async ({ signal }): Promise<SessionBar[]> => {
      const to = Math.floor(Date.now() / 1000);
      // A week back: enough to find the previous SESSION even across a weekend
      // or a holiday, which a fixed "yesterday" would miss and then report no
      // change at all every Monday.
      const from = to - 7 * 24 * 60 * 60;
      const bars = await services.market.dailyBars(
        { symbol: gatewaySymbol, from, to, resolution: '1D' },
        signal,
      );
      return bars.map((bar) => ({
        time: Number(bar.time),
        open: String(bar.open) as DecimalString,
        high: String(bar.high) as DecimalString,
        low: String(bar.low) as DecimalString,
        close: String(bar.close) as DecimalString,
      }));
    },
  });

  const live = quote ? (quote.last ?? quote.bid) : null;
  const summary = query.data ? sessionSummary(query.data, live) : null;

  const { loading, unavailable, stalled } = sessionPanelState({
    status: query.status,
    fetchStatus: query.fetchStatus,
    summary,
  });

  // Ask again rather than wait for a window focus that may never come. Safe
  // against a loop: a refetch moves fetchStatus off "idle" immediately, and a
  // failing one lands on "error" rather than back on "pending".
  const { refetch } = query;
  useEffect(() => {
    if (stalled) void refetch();
  }, [stalled, refetch]);

  return {
    summary,
    loading,
    // Settled, and still nothing to show: the history call failed, or answered
    // with no bars for this instrument. The panel says so rather than rendering
    // an empty space where the day's numbers belong.
    unavailable,
  };
}
