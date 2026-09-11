import { useBrand } from '@/app/providers/brand-provider';
import { cn } from './cn';

/**
 * Full-screen loading state carrying the broker's identity.
 *
 * Used for the moments where the terminal has nothing to show yet — startup and
 * the account fetch straight after sign-in. Those are exactly the moments a
 * blank screen or a premature error reads as "something is broken", so the mark
 * stays on screen and the label says what is actually happening.
 *
 * The animation is decorative: `prefers-reduced-motion` collapses it via the
 * global stylesheet, and the label alone still communicates the state.
 */
export function BrandedLoader({ label, className }: { label?: string; className?: string }) {
  const brand = useBrand();
  const mark = brand.compactLogoUrl ?? brand.logoUrl;

  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      className={cn(
        'flex h-full w-full flex-col items-center justify-center gap-5 bg-[var(--background-primary)]',
        className,
      )}
    >
      <div className="relative flex h-16 w-16 items-center justify-center">
        {/* Track plus rotating arc, drawn from brand tokens so it re-themes
            with the rest of the terminal. */}
        <span
          aria-hidden
          className="absolute inset-0 rounded-full border-2 border-[var(--border-default)]"
        />
        <span
          aria-hidden
          className="absolute inset-0 animate-spin rounded-full border-2 border-transparent border-t-[var(--brand-primary)]"
          style={{ animationDuration: '900ms' }}
        />
        {mark ? (
          <img
            src={mark}
            alt=""
            aria-hidden
            className="h-8 w-8 animate-pulse object-contain"
            onError={(event) => {
              // A missing brand asset must not leave a broken-image glyph
              // sitting in the middle of the loading screen.
              event.currentTarget.style.display = 'none';
            }}
          />
        ) : null}
      </div>

      <p className="text-xs text-text-secondary">{label ?? `Loading ${brand.platformName}…`}</p>
    </div>
  );
}
