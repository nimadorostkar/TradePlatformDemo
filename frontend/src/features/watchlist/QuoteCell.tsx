import { memo, useEffect, useRef, useState } from 'react';
import { cn } from '@/components/ui/cn';
import { useQuote, useQuoteWithStaleness } from '@/stores/quote-store';
import { useSessionStore } from '@/stores/session-store';
import { formatQuoteAge } from '@/domain/market/quote-staleness';

/**
 * A single live price cell.
 *
 * Memoised AND subscribed at the leaf: `useQuote` registers this component
 * against one symbol, so a EURUSD tick re-renders only EURUSD's cells. Nothing
 * above this component re-renders on a tick — not the row, not the list, not
 * the shell.
 */

export interface QuoteCellProps {
  displaySymbol: string;
  field: 'bid' | 'ask' | 'last';
  digits?: number;
  className?: string;
}

export const QuoteCell = memo(function QuoteCell({
  displaySymbol,
  field,
  digits = 5,
  className,
}: QuoteCellProps) {
  const suffixPolicy = useSessionStore((s) => s.suffixPolicy);
  const { quote, stale, ageMs } = useQuoteWithStaleness(suffixPolicy.toGateway(displaySymbol));
  const value = quote?.[field] ?? null;

  const flash = usePriceFlash(value);

  if (value === null) {
    return (
      <span className={cn('tabular text-text-muted', className)} aria-label="No price available">
        —
      </span>
    );
  }

  return (
    <span
      className={cn(
        'tabular rounded px-1',
        // A stale price keeps its digits — the trader still needs the last known
        // number — but stops looking live. The flash is suppressed for the same
        // reason: an animation on a frozen price reads as movement.
        stale ? 'opacity-50' : flash === 'up' && 'animate-flash-up',
        !stale && flash === 'down' && 'animate-flash-down',
        className,
      )}
      title={
        stale && ageMs !== null
          ? `Last broker quote ${formatQuoteAge(ageMs)} ago — not a live price`
          : undefined
      }
      aria-label={
        stale && ageMs !== null
          ? `${formatPrice(value, digits)}, stale, last updated ${formatQuoteAge(ageMs)} ago`
          : undefined
      }
    >
      {formatPrice(value, digits)}
    </span>
  );
});

/**
 * Badge for a symbol whose quotes have stopped arriving.
 *
 * Rendered next to the symbol rather than in place of the price: hiding the
 * price would leave a trader with no number at all, which is worse than an old
 * number that is clearly labelled as old.
 */
export const StaleQuoteBadge = memo(function StaleQuoteBadge({
  displaySymbol,
}: {
  displaySymbol: string;
}) {
  const suffixPolicy = useSessionStore((s) => s.suffixPolicy);
  const { stale, ageMs } = useQuoteWithStaleness(suffixPolicy.toGateway(displaySymbol));
  if (!stale || ageMs === null) return null;

  return (
    <span
      className="rounded bg-[var(--background-tertiary)] px-1 text-2xs text-text-muted"
      title={`No quote from the broker for ${formatQuoteAge(ageMs)}. The market may be closed.`}
    >
      {formatQuoteAge(ageMs)} old
    </span>
  );
});

/**
 * Returns a one-shot flash direction when the value changes.
 *
 * The flash is decorative; the price text itself always carries the
 * information, and `prefers-reduced-motion` collapses the animation to nothing
 * via the global stylesheet.
 */
function usePriceFlash(value: string | null): 'up' | 'down' | null {
  const previous = useRef<string | null>(value);
  const [flash, setFlash] = useState<'up' | 'down' | null>(null);

  useEffect(() => {
    if (value === null || previous.current === null || value === previous.current) {
      previous.current = value;
      return;
    }
    const direction = Number(value) > Number(previous.current) ? 'up' : 'down';
    previous.current = value;
    setFlash(direction);

    const timer = setTimeout(() => setFlash(null), 500);
    return () => clearTimeout(timer);
  }, [value]);

  return flash;
}

function formatPrice(value: string, digits: number): string {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '—';
  return numeric.toFixed(digits);
}

/** Spread in points, rendered next to bid/ask. */
export const SpreadCell = memo(function SpreadCell({
  displaySymbol,
  digits = 5,
  className,
}: {
  displaySymbol: string;
  digits?: number;
  className?: string;
}) {
  const suffixPolicy = useSessionStore((s) => s.suffixPolicy);
  const quote = useQuote(suffixPolicy.toGateway(displaySymbol));

  if (!quote) return <span className={cn('tabular text-text-muted', className)}>—</span>;

  const spread = (Number(quote.ask) - Number(quote.bid)) * 10 ** digits;
  if (!Number.isFinite(spread))
    return <span className={cn('tabular text-text-muted', className)}>—</span>;

  return <span className={cn('tabular text-text-muted', className)}>{spread.toFixed(1)}</span>;
});

/** Arrow indicating the last tick direction. Never the only signal. */
export const DirectionIndicator = memo(function DirectionIndicator({
  displaySymbol,
}: {
  displaySymbol: string;
}) {
  const suffixPolicy = useSessionStore((s) => s.suffixPolicy);
  const { quote, stale } = useQuoteWithStaleness(suffixPolicy.toGateway(displaySymbol));
  // The arrow describes the last tick. On a stale quote that tick may be days
  // old, and an arrow reads as movement happening now.
  if (!quote || stale || quote.direction === 'flat') return null;

  return (
    <span
      aria-hidden
      className={cn(
        'text-2xs',
        quote.direction === 'up' ? 'text-[var(--positive)]' : 'text-[var(--negative)]',
      )}
    >
      {quote.direction === 'up' ? '▲' : '▼'}
    </span>
  );
});
