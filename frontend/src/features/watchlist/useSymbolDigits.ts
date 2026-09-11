import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useServices } from '@/app/providers/services';
import { digitsFromPricescale } from '@/integrations/gateway/mappers/to-domain';
import { useSessionStore } from '@/stores/session-store';

/**
 * Price precision for a set of symbols.
 *
 * Every instrument prices to its own number of decimals — gold to 2, most FX
 * pairs to 5. Rendering them all at a fixed precision shows `4096.40000` for
 * gold and inflates its spread by three orders of magnitude, which is worse
 * than useless on a trading screen.
 *
 * The gateway's mask endpoint accepts a comma-separated list, so the whole
 * visible watchlist resolves in ONE request rather than one per row.
 */
export function useSymbolDigits(displaySymbols: readonly string[]): Map<string, number> {
  const services = useServices();
  const suffixPolicy = useSessionStore((s) => s.suffixPolicy);

  // Sorted + joined so a re-render with the same set reuses the cached result
  // and scrolling does not refetch.
  const key = useMemo(() => [...displaySymbols].sort().join(','), [displaySymbols]);

  const query = useQuery({
    queryKey: ['symbol-digits', key, suffixPolicy.suffix],
    enabled: key.length > 0,
    // Contract precision effectively never changes within a session.
    staleTime: 30 * 60 * 1000,
    gcTime: 60 * 60 * 1000,
    retry: 1,
    queryFn: async ({ signal }) => {
      const mask = [...displaySymbols].map((s) => suffixPolicy.toGateway(s)).join(',');
      const symbols = await services.market.searchSymbols(mask, suffixPolicy, signal);

      const digits = new Map<string, number>();
      for (const symbol of symbols) {
        digits.set(symbol.displayName, symbol.digits || digitsFromPricescale(symbol.pricescale));
        // Cache the full record too — the order ticket and Broker API need its
        // contract limits, and this call has already paid for them.
        if (!services.symbolCache.has(symbol.displayName)) {
          services.symbolCache.set(symbol.displayName, symbol);
        }
      }
      return digits;
    },
  });

  return query.data ?? EMPTY;
}

const EMPTY: Map<string, number> = new Map();

/**
 * Precision to render with before the lookup resolves.
 *
 * 5 is the common FX case, so most rows are right immediately and the rest
 * settle within one request rather than flashing an obviously wrong value.
 */
export const FALLBACK_DIGITS = 5;
