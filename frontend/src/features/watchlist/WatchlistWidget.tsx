import { memo, useCallback, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Star, X } from 'lucide-react';
import { cn } from '@/components/ui/cn';
import { EmptyState, Input } from '@/components/ui/primitives';
import { useWorkspace } from '@/workspace/layout/workspace-store';
import { DirectionIndicator, QuoteCell, SpreadCell, StaleQuoteBadge } from './QuoteCell';
import { SymbolLogo } from './SymbolLogo';
import { useSymbolSubscription } from './useSymbolSubscription';
import { FALLBACK_DIGITS, useSymbolDigits } from './useSymbolDigits';

/**
 * Watchlist.
 *
 * Virtualised, and subscribed only to the symbols currently RENDERED. The
 * quote cells subscribe individually, so a tick updates one cell rather than
 * re-rendering the list.
 */

const ROW_HEIGHT = 26;

export default function WatchlistWidget() {
  const watchlists = useWorkspace((s) => s.workspace.watchlists);
  const activeWatchlistId = useWorkspace((s) => s.workspace.activeWatchlistId);
  const favorites = useWorkspace((s) => s.workspace.favorites);
  const activeSymbol = useWorkspace((s) => s.workspace.activeSymbol);

  const setActiveSymbol = useWorkspace((s) => s.setActiveSymbol);
  const setActiveWatchlist = useWorkspace((s) => s.setActiveWatchlist);
  const removeSymbol = useWorkspace((s) => s.removeSymbolFromWatchlist);
  const toggleFavorite = useWorkspace((s) => s.toggleFavorite);
  const activateWidget = useWorkspace((s) => s.activateWidget);

  const [filter, setFilter] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  const watchlist = watchlists.find((w) => w.id === activeWatchlistId) ?? watchlists[0];

  const symbols = useMemo(() => {
    const all = watchlist?.symbols ?? [];
    if (filter.trim() === '') return all;
    const needle = filter.trim().toUpperCase();
    return all.filter((symbol) => symbol.toUpperCase().includes(needle));
  }, [watchlist, filter]);

  const virtualizer = useVirtualizer({
    count: symbols.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
  });

  const virtualRows = virtualizer.getVirtualItems();

  // Subscribe only to what is on screen. A 500-symbol list would otherwise
  // open 500 sockets for rows nobody can see.
  const visibleSymbols = useMemo(
    () => virtualRows.map((row) => symbols[row.index]).filter((s): s is string => s !== undefined),
    [virtualRows, symbols],
  );
  useSymbolSubscription(visibleSymbols);

  // Each instrument prices to its own precision; rendering them all at five
  // decimals shows 4096.40000 for gold and inflates its spread hugely.
  const digitsBySymbol = useSymbolDigits(visibleSymbols);

  const handleOpenTicket = useCallback(
    (symbol: string) => {
      setActiveSymbol(symbol);
      activateWidget('order-ticket');
    },
    [setActiveSymbol, activateWidget],
  );

  if (!watchlist) {
    return <EmptyState title="No watchlist" description="Create a watchlist to track symbols." />;
  }

  return (
    // role="grid": the row/gridcell roles below are only valid inside a grid
    // ancestor — a bare role="row" was the single ARIA error the audit found
    // in these tables (MED-06). The intermediate scroll/positioning divs are
    // marked rowgroup/presentation so the accessibility tree stays legal.
    <div role="grid" aria-label="Watchlist" className="watchlist-root flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-[var(--border-default)] p-1">
        <select
          aria-label="Select watchlist"
          value={watchlist.id}
          onChange={(event) => setActiveWatchlist(event.target.value)}
          className="h-6 rounded border border-[var(--border-default)] bg-[var(--background-tertiary)] px-1 text-2xs text-text-primary"
        >
          {watchlists.map((list) => (
            <option key={list.id} value={list.id}>
              {list.name}
            </option>
          ))}
        </select>
        <Input
          aria-label="Filter symbols"
          placeholder="Filter…"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          className="h-6 flex-1 text-2xs"
        />
      </div>

      {/* minmax(6ch,1fr): the Symbol column is the INFORMATION in this table,
          so it holds a readable floor and Bid/Ask/Spread absorb the squeeze
          instead — a flag next to a price with no name is useless (BLK-01).
          In a narrow dock the .watchlist-grid container rules drop the flag
          and the Spread column (both derivable) before a single letter of a
          symbol name is given up. */}
      <div
        role="row"
        className="watchlist-grid grid shrink-0 grid-cols-[minmax(6ch,1fr)_auto_auto_auto] gap-2 border-b border-[var(--border-default)] px-2 py-1 text-2xs font-medium text-text-muted"
      >
        <span role="columnheader">Symbol</span>
        <span role="columnheader" className="text-right">
          Bid
        </span>
        <span role="columnheader" className="text-right">
          Ask
        </span>
        <span role="columnheader" className="watchlist-spread w-8 text-right">
          Spr
        </span>
      </div>

      {symbols.length === 0 ? (
        <EmptyState
          title={filter ? 'No matches' : 'Watchlist is empty'}
          description={
            filter ? 'Try a different filter.' : 'Add symbols from the Symbol Search panel.'
          }
        />
      ) : (
        <div ref={scrollRef} role="rowgroup" className="widget-scroll min-h-0 flex-1">
          <div
            role="presentation"
            style={{ height: virtualizer.getTotalSize(), position: 'relative' }}
          >
            {virtualRows.map((row) => {
              const symbol = symbols[row.index];
              if (symbol === undefined) return null;
              return (
                <div
                  key={symbol}
                  role="presentation"
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    height: ROW_HEIGHT,
                    transform: `translateY(${row.start}px)`,
                  }}
                >
                  <WatchlistRow
                    symbol={symbol}
                    digits={digitsBySymbol.get(symbol) ?? FALLBACK_DIGITS}
                    isActive={symbol === activeSymbol}
                    isFavorite={favorites.includes(symbol)}
                    onSelect={setActiveSymbol}
                    onOpenTicket={handleOpenTicket}
                    onToggleFavorite={toggleFavorite}
                    onRemove={removeSymbol}
                  />
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

interface WatchlistRowProps {
  symbol: string;
  digits: number;
  isActive: boolean;
  isFavorite: boolean;
  onSelect: (symbol: string) => void;
  onOpenTicket: (symbol: string) => void;
  onToggleFavorite: (symbol: string) => void;
  onRemove: (symbol: string) => void;
}

/**
 * Memoised so a tick in ANOTHER symbol cannot re-render this row. The price
 * cells inside subscribe individually.
 */
const WatchlistRow = memo(function WatchlistRow({
  symbol,
  digits,
  isActive,
  isFavorite,
  onSelect,
  onOpenTicket,
  onToggleFavorite,
  onRemove,
}: WatchlistRowProps) {
  return (
    <div
      role="row"
      tabIndex={0}
      aria-selected={isActive}
      onClick={() => onSelect(symbol)}
      onDoubleClick={() => onOpenTicket(symbol)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') onSelect(symbol);
        if (event.key === ' ') {
          event.preventDefault();
          onOpenTicket(symbol);
        }
      }}
      className={cn(
        'watchlist-grid group grid h-full cursor-pointer grid-cols-[minmax(6ch,1fr)_auto_auto_auto] items-center gap-2 px-2 text-2xs',
        'hover:bg-[var(--surface-raised)] focus-visible:bg-[var(--surface-raised)]',
        isActive && 'bg-[var(--surface-raised)] text-text-primary',
      )}
    >
      <span role="gridcell" className="flex min-w-0 items-center gap-1">
        <button
          aria-label={isFavorite ? `Remove ${symbol} from favorites` : `Add ${symbol} to favorites`}
          aria-pressed={isFavorite}
          onClick={(event) => {
            event.stopPropagation();
            onToggleFavorite(symbol);
          }}
          className="hit-target -mx-1.5 shrink-0 justify-center"
        >
          <Star
            className={cn(
              'h-2.5 w-2.5',
              isFavorite ? 'fill-[var(--warning)] text-[var(--warning)]' : 'text-text-muted',
            )}
          />
        </button>
        {/* The flag is decoration and the name is data: in a narrow dock the
            flag yields its space first (see .watchlist-flag in global.css). */}
        <SymbolLogo symbol={symbol} size={14} className="watchlist-flag" />
        {/* title: the tooltip survives even if a future layout truncates the
            name — the row must never be reduced to a flag and a price. */}
        <span className="truncate font-medium" title={symbol}>
          {symbol}
        </span>
        <DirectionIndicator displaySymbol={symbol} />
        <StaleQuoteBadge displaySymbol={symbol} />
      </span>

      <span role="gridcell" className="text-right">
        <QuoteCell
          displaySymbol={symbol}
          field="bid"
          digits={digits}
          className="text-[var(--negative)]"
        />
      </span>
      <span role="gridcell" className="text-right">
        <QuoteCell
          displaySymbol={symbol}
          field="ask"
          digits={digits}
          className="text-[var(--positive)]"
        />
      </span>

      <span role="gridcell" className="watchlist-spread flex w-8 items-center justify-end gap-1">
        <SpreadCell displaySymbol={symbol} digits={digits} className="group-hover:hidden" />
        <button
          aria-label={`Remove ${symbol} from watchlist`}
          onClick={(event) => {
            event.stopPropagation();
            onRemove(symbol);
          }}
          className="hit-target hidden justify-center text-text-muted hover:text-[var(--negative)] group-hover:!inline-flex"
        >
          <X className="h-2.5 w-2.5" />
        </button>
      </span>
    </div>
  );
});
