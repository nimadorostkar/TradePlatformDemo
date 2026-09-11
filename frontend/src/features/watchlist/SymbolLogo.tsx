import { memo } from 'react';
import { cn } from '@/components/ui/cn';
import { symbolLogoUrls } from '@/domain/market/symbol-logos';

/**
 * TradingView-style symbol logo: a currency pair renders as two partially
 * overlapping circular flags (base on top-left, quote behind), a single-logo
 * instrument as one circle, and an unrecognised symbol as a letter monogram —
 * never a broken image.
 *
 * Sized in em so it follows the row's text size; `size` is the circle
 * diameter. Purely decorative (`alt=""`, `aria-hidden`): the symbol name is
 * always rendered next to it by the caller.
 */

interface SymbolLogoProps {
  symbol: string;
  /** Circle diameter. Defaults to 16px. */
  size?: number;
  className?: string;
}

export const SymbolLogo = memo(function SymbolLogo({
  symbol,
  size = 16,
  className,
}: SymbolLogoProps) {
  const urls = symbolLogoUrls(symbol);

  // Two circles overlap by a third, so the pair is 5/3 of a diameter wide.
  // Single logos and monograms occupy the same box, keeping rows aligned.
  const width = Math.round((size * 5) / 3);
  const overlap = width - size;

  if (!urls) {
    return (
      <span
        aria-hidden
        className={cn('inline-flex shrink-0 select-none items-center justify-start', className)}
        style={{ width, height: size }}
      >
        <span
          className="inline-flex items-center justify-center rounded-full bg-[var(--surface-raised)] font-semibold text-text-muted ring-1 ring-inset ring-[var(--border-default)]"
          style={{ width: size, height: size, fontSize: size * 0.55 }}
        >
          {symbol.trim().charAt(0).toUpperCase() || '?'}
        </span>
      </span>
    );
  }

  return (
    <span
      aria-hidden
      className={cn('relative inline-block shrink-0 select-none', className)}
      style={{ width, height: size }}
    >
      {urls.length === 2 && (
        <img
          src={urls[1]}
          alt=""
          loading="lazy"
          draggable={false}
          className="absolute top-0 rounded-full"
          style={{ left: overlap, width: size, height: size }}
        />
      )}
      <img
        src={urls[0]}
        alt=""
        loading="lazy"
        draggable={false}
        // The ring paints a hairline of the row background between the two
        // circles, which is what makes the overlap read as two coins.
        className={cn(
          'absolute left-0 top-0 rounded-full',
          urls.length === 2 && 'ring-2 ring-[var(--background-secondary)]',
        )}
        style={{ width: size, height: size }}
      />
    </span>
  );
});
