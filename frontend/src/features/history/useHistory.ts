import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useServices, type Services } from '@/app/providers/services';
import { useSessionStore } from '@/stores/session-store';
import {
  ledgerEntries,
  pairDealsIntoClosedPositions,
} from '@/integrations/gateway/mappers/to-domain';
import {
  closedPositionsWithBackfill,
  fetchEntryBackfill,
  missingEntryIdsOf,
} from './entry-backfill';
import type { ClosedPosition, Deal, HistoricalOrder } from '@/domain/common/models';

/**
 * Trading history.
 *
 * The gateway returns RAW MT5 deals, which mix trade deals with balance,
 * credit, commission, and tax ledger entries. Splitting them and pairing
 * opening/closing legs happens in the mapper; these hooks just choose the
 * range and cache.
 */

export type HistoryRange = '1d' | '7d' | '30d' | '90d' | '1y';

const RANGE_DAYS: Record<Exclude<HistoryRange, '1d'>, number> = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
  '1y': 365,
};

/**
 * Start of the broker's CURRENT TRADING DAY, in unix seconds.
 *
 * "Today" must mean the broker's day, not a rolling 24 hours of browser
 * time — daily totals compared against the broker's own platform never match
 * otherwise. Exported for tests.
 */
export function brokerDayStartSeconds(nowSeconds: number, brokerOffsetSeconds: number): number {
  return Math.floor((nowSeconds + brokerOffsetSeconds) / 86_400) * 86_400 - brokerOffsetSeconds;
}

/**
 * The [from, to] window for a range, in unix seconds.
 *
 * '1d' asks the gateway for the broker clock offset; a gateway too old to
 * report one degrades to the UTC day — still a trading-day boundary, merely
 * possibly a few hours off, and strictly closer to the broker's day than a
 * rolling 24h window ever was.
 */
async function rangeWindow(
  range: HistoryRange,
  services: Services,
  signal?: AbortSignal,
): Promise<{ fromSeconds: number; toSeconds: number }> {
  const toSeconds = Math.floor(Date.now() / 1000);
  if (range !== '1d') {
    return { fromSeconds: toSeconds - RANGE_DAYS[range] * 24 * 60 * 60, toSeconds };
  }
  let offset = 0;
  try {
    offset = (await services.market.brokerClock(signal)).brokerOffsetSeconds ?? 0;
  } catch {
    // The window still answers; the boundary just falls back to UTC.
  }
  return { fromSeconds: brokerDayStartSeconds(toSeconds, offset), toSeconds };
}

export interface HistoryResult {
  deals: Deal[];
  closedPositions: ClosedPosition[];
  ledger: Deal[];
  /** True when the gateway walk hit its page cap — the list is INCOMPLETE. */
  truncated: boolean;
  loading: boolean;
  error: unknown;
  refetch: () => void;
}

export function useHistory(range: HistoryRange): HistoryResult {
  const services = useServices();
  const login = useSessionStore((s) => s.activeLogin);
  const suffixPolicy = useSessionStore((s) => s.suffixPolicy);

  const query = useQuery({
    queryKey: ['history', login, range, suffixPolicy.suffix],
    enabled: login !== null,
    // History is expensive and changes only when a trade closes; the widget
    // refetches explicitly after a mutation rather than polling.
    staleTime: 60_000,
    queryFn: async ({ signal }) => {
      if (!login) return { deals: [], truncated: false, fromSeconds: 0 };
      const window = await rangeWindow(range, services, signal);
      const page = await services.trading.deals(login, window, suffixPolicy, {}, signal);
      return { ...page, fromSeconds: window.fromSeconds };
    },
  });

  const deals = useMemo(() => query.data?.deals ?? [], [query.data]);
  const windowStartMs = (query.data?.fromSeconds ?? 0) * 1000;

  // Which positions closed in this window but opened before it. Their entry
  // deal was simply never fetched — the row is not incomplete at the source.
  const missingEntryIds = useMemo(() => missingEntryIdsOf(deals), [deals]);

  const backfill = useQuery({
    queryKey: ['history-entry-backfill', login, range, suffixPolicy.suffix, missingEntryIds],
    enabled: login !== null && missingEntryIds.length > 0 && query.data !== undefined,
    staleTime: 60_000,
    queryFn: ({ signal }) =>
      fetchEntryBackfill(query.data?.fromSeconds ?? 0, missingEntryIds, (window) =>
        services.trading.deals(login!, window, suffixPolicy, {}, signal),
      ),
  });

  // Pairing over both sets restores the true open price, time and side, and —
  // because the entry deal carries its own commission — the true cost too.
  const closedPositions = useMemo(
    () => closedPositionsWithBackfill(deals, backfill.data ?? [], windowStartMs),
    [deals, backfill.data, windowStartMs],
  );

  return {
    deals,
    closedPositions,
    ledger: ledgerEntries(deals),
    truncated: query.data?.truncated ?? false,
    loading: query.isLoading,
    error: query.error,
    refetch: () => void query.refetch(),
  };
}

/**
 * How many closed positions the WIDEST range holds. Used only to stop an
 * empty narrow range from reading as data loss: "No trades in the last 30
 * days" is a different statement when 46 exist in the last year. Enabled
 * lazily — the probe fires only when the active range came back empty — and
 * it shares the ['history', …, '1y'] cache key, so switching to 1 year after
 * the probe costs nothing.
 */
export function useYearProbe(enabled: boolean): { count: number | null } {
  const services = useServices();
  const login = useSessionStore((s) => s.activeLogin);
  const suffixPolicy = useSessionStore((s) => s.suffixPolicy);

  const query = useQuery({
    queryKey: ['history', login, '1y', suffixPolicy.suffix],
    enabled: enabled && login !== null,
    staleTime: 60_000,
    queryFn: async ({ signal }) => {
      if (!login) return { deals: [], truncated: false };
      const window = await rangeWindow('1y', services, signal);
      return services.trading.deals(login, window, suffixPolicy, {}, signal);
    },
  });

  return {
    count: query.data ? pairDealsIntoClosedPositions(query.data.deals).length : null,
  };
}

export interface OrderHistoryResult {
  orders: HistoricalOrder[];
  truncated: boolean;
  loading: boolean;
  error: unknown;
  refetch: () => void;
}

/**
 * The broker's ORDER history — every order that reached a final state
 * (filled, cancelled, rejected, expired). This is what "order history" means
 * on the broker's own platform; closed positions are a different view.
 */
export function useOrderHistory(range: HistoryRange, enabled = true): OrderHistoryResult {
  const services = useServices();
  const login = useSessionStore((s) => s.activeLogin);
  const suffixPolicy = useSessionStore((s) => s.suffixPolicy);

  const query = useQuery({
    queryKey: ['order-history', login, range, suffixPolicy.suffix],
    enabled: enabled && login !== null,
    staleTime: 60_000,
    queryFn: async ({ signal }) => {
      if (!login) return { orders: [], truncated: false };
      const window = await rangeWindow(range, services, signal);
      return services.trading.orderHistory(login, window, suffixPolicy, {}, signal);
    },
  });

  return {
    orders: query.data?.orders ?? [],
    truncated: query.data?.truncated ?? false,
    loading: query.isLoading,
    error: query.error,
    refetch: () => void query.refetch(),
  };
}
