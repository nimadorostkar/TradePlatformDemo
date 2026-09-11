import { useMemo } from 'react';
import { Star } from 'lucide-react';
import { cn } from '@/components/ui/cn';
import { EmptyState } from '@/components/ui/primitives';
import { useWorkspace } from '@/workspace/layout/workspace-store';
import { DirectionIndicator, QuoteCell } from './QuoteCell';
import { SymbolLogo } from './SymbolLogo';
import { useSymbolSubscription } from './useSymbolSubscription';
import { FALLBACK_DIGITS, useSymbolDigits } from './useSymbolDigits';

/**
 * Favorites and recently viewed symbols.
 *
 * Favorites are usually a short list, so it is not virtualised; the quote cells
 * still subscribe individually, so a tick updates one cell.
 */
export default function FavoritesWidget() {
  const favorites = useWorkspace((s) => s.workspace.favorites);
  const recents = useWorkspace((s) => s.workspace.recentSymbols);
  const activeSymbol = useWorkspace((s) => s.workspace.activeSymbol);
  const setActiveSymbol = useWorkspace((s) => s.setActiveSymbol);
  const toggleFavorite = useWorkspace((s) => s.toggleFavorite);

  const subscribed = useMemo(
    () => [...new Set([...favorites, ...recents.slice(0, 10)])],
    [favorites, recents],
  );
  useSymbolSubscription(subscribed);
  const digitsBySymbol = useSymbolDigits(subscribed);

  return (
    // favorites-root: the container the .watchlist-flag rule measures against,
    // so a narrow dock drops the flags here exactly as it does in the watchlist.
    <div className="favorites-root widget-scroll h-full">
      <Section title="Favorites">
        {favorites.length === 0 ? (
          <EmptyState
            title="No favorites yet"
            description="Star a symbol in the watchlist to pin it here."
            icon={Star}
          />
        ) : (
          favorites.map((symbol) => (
            <SymbolRow
              key={symbol}
              symbol={symbol}
              digits={digitsBySymbol.get(symbol) ?? FALLBACK_DIGITS}
              isActive={symbol === activeSymbol}
              onSelect={setActiveSymbol}
              onUnfavorite={toggleFavorite}
            />
          ))
        )}
      </Section>

      {recents.length > 0 && (
        <Section title="Recently viewed">
          {recents.slice(0, 10).map((symbol) => (
            <SymbolRow
              key={symbol}
              symbol={symbol}
              digits={digitsBySymbol.get(symbol) ?? FALLBACK_DIGITS}
              isActive={symbol === activeSymbol}
              onSelect={setActiveSymbol}
            />
          ))}
        </Section>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  // h2, not h3: the document outline is h1 (platform name) → h2 (panel
  // sections) with no skipped level (MED-12). The grid role plus a visually
  // hidden header row give the rows below real table semantics — a screen
  // reader can announce "Symbol, Bid, Ask" and walk them as a grid (MED-06).
  return (
    <section>
      <h2 className="sticky top-0 bg-[var(--background-tertiary)] px-2 py-1 text-2xs font-medium text-text-muted">
        {title}
      </h2>
      <div role="grid" aria-label={title} aria-readonly="true">
        <div role="row" className="sr-only">
          <span role="columnheader">Symbol</span>
          <span role="columnheader">Bid</span>
          <span role="columnheader">Ask</span>
        </div>
        {children}
      </div>
    </section>
  );
}

function SymbolRow({
  symbol,
  digits,
  isActive,
  onSelect,
  onUnfavorite,
}: {
  symbol: string;
  digits: number;
  isActive: boolean;
  onSelect: (symbol: string) => void;
  onUnfavorite?: (symbol: string) => void;
}) {
  return (
    <div
      role="row"
      aria-selected={isActive}
      className={cn(
        'group grid grid-cols-[minmax(6ch,1fr)_auto_auto] items-center gap-2 px-2 py-0.5 text-2xs hover:bg-[var(--surface-raised)]',
        isActive && 'bg-[var(--surface-raised)]',
      )}
    >
      <button
        role="gridcell"
        onClick={() => onSelect(symbol)}
        className="flex min-h-6 min-w-0 items-center gap-1 text-left"
      >
        {/* Same degradation contract as the watchlist (BLK-01): the flag
            yields before the name, and the name truncates with a tooltip
            rather than pushing the prices out of the panel. */}
        <SymbolLogo symbol={symbol} size={14} className="watchlist-flag" />
        <span className="truncate font-medium" title={symbol}>
          {symbol}
        </span>
        <DirectionIndicator displaySymbol={symbol} />
      </button>
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
      {onUnfavorite && (
        <button
          aria-label={`Remove ${symbol} from favorites`}
          onClick={() => onUnfavorite(symbol)}
          className="hit-target col-start-3 row-start-1 hidden justify-center justify-self-end group-hover:!inline-flex"
        >
          <Star className="h-2.5 w-2.5 fill-[var(--warning)] text-[var(--warning)]" />
        </button>
      )}
    </div>
  );
}
