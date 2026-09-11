import { useQuery } from '@tanstack/react-query';
import { useServices } from '@/app/providers/services';
import { useSessionStore } from '@/stores/session-store';
import type { TradingSymbol } from '@/domain/common/models';

/**
 * Symbol metadata, cached by TanStack Query and mirrored into the service-level
 * cache so the trading service can resolve digits synchronously when building
 * a trade payload.
 *
 * Keyed by the SUFFIX so a symbol re-resolves after an account switch: the same
 * display name maps to a different gateway symbol per account group.
 */
export function useSymbolMetadata(displaySymbol: string | null): {
  symbol: TradingSymbol | undefined;
  loading: boolean;
  error: unknown;
} {
  const services = useServices();
  const suffixPolicy = useSessionStore((s) => s.suffixPolicy);

  const query = useQuery({
    queryKey: ['symbol', displaySymbol, suffixPolicy.suffix],
    enabled: displaySymbol !== null && displaySymbol !== '',
    // Symbol definitions change rarely; refetching them on every focus would
    // add load for no benefit.
    staleTime: 10 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
    retry: 1,
    queryFn: async ({ signal }) => {
      if (!displaySymbol) return null;
      const gatewaySymbol = suffixPolicy.toGateway(displaySymbol);
      const symbol = await services.market.symbolInfo(gatewaySymbol, suffixPolicy, signal);
      if (symbol) services.symbolCache.set(displaySymbol, symbol);
      return symbol;
    },
  });

  return {
    symbol: query.data ?? undefined,
    loading: query.isLoading,
    error: query.error,
  };
}
