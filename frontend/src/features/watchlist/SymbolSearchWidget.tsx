import { useDeferredValue, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Plus, Search } from 'lucide-react';
import { EmptyState, ErrorState, Input, LoadingState } from '@/components/ui/primitives';
import { useServices } from '@/app/providers/services';
import { useSessionStore } from '@/stores/session-store';
import { useWorkspace } from '@/workspace/layout/workspace-store';
import { SymbolLogo } from './SymbolLogo';

/**
 * Symbol search.
 *
 * The query is deferred so typing stays responsive, and TanStack Query cancels
 * the in-flight request through its `signal` when a newer keystroke supersedes
 * it — an older response can never overwrite newer results.
 */
export default function SymbolSearchWidget() {
  const services = useServices();
  const suffixPolicy = useSessionStore((s) => s.suffixPolicy);
  const addSymbol = useWorkspace((s) => s.addSymbolToWatchlist);
  const setActiveSymbol = useWorkspace((s) => s.setActiveSymbol);
  const watchlist = useWorkspace((s) =>
    s.workspace.watchlists.find((w) => w.id === s.workspace.activeWatchlistId),
  );

  const [input, setInput] = useState('');
  const deferred = useDeferredValue(input);

  const query = useQuery({
    queryKey: ['symbol-search', deferred, suffixPolicy.suffix],
    // An empty mask makes the gateway return its default symbol list, which is
    // a useful starting view rather than an empty panel.
    staleTime: 60_000,
    queryFn: ({ signal }) => services.market.searchSymbols(deferred, suffixPolicy, signal),
  });

  const inWatchlist = useMemo(() => new Set(watchlist?.symbols ?? []), [watchlist]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-[var(--border-default)] p-1">
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-1.5 top-1/2 h-3 w-3 -translate-y-1/2 text-text-muted"
            aria-hidden
          />
          <Input
            aria-label="Search symbols"
            placeholder="Search symbols…"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            className="pl-6"
          />
        </div>
      </div>

      {query.isLoading ? (
        <LoadingState label="Searching…" />
      ) : query.isError ? (
        <ErrorState
          title="Search failed"
          description="The symbol list could not be loaded."
          onRetry={() => void query.refetch()}
        />
      ) : (query.data?.length ?? 0) === 0 ? (
        <EmptyState title="No symbols found" description="Try a different search term." />
      ) : (
        <ul className="widget-scroll min-h-0 flex-1">
          {query.data?.map((symbol) => (
            <li
              key={symbol.name}
              className="group flex items-center gap-2 border-b border-[var(--border-default)] px-2 py-1 text-2xs hover:bg-[var(--surface-raised)]"
            >
              <button
                onClick={() => setActiveSymbol(symbol.displayName)}
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
              >
                <SymbolLogo symbol={symbol.displayName} size={18} />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate font-medium" title={symbol.displayName}>
                    {symbol.displayName}
                  </span>
                  <span className="truncate text-text-muted">{symbol.description}</span>
                </span>
              </button>
              <span className="shrink-0 text-text-muted">{symbol.type}</span>
              <button
                aria-label={
                  inWatchlist.has(symbol.displayName)
                    ? `${symbol.displayName} is already in the watchlist`
                    : `Add ${symbol.displayName} to the watchlist`
                }
                disabled={inWatchlist.has(symbol.displayName)}
                onClick={() => addSymbol(symbol.displayName)}
                className="hit-target shrink-0 justify-center rounded text-text-muted hover:text-[var(--brand-primary)] disabled:opacity-30"
              >
                <Plus className="h-3 w-3" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
