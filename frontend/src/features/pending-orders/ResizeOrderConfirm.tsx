import { useEffect, useRef } from 'react';
import { Button } from '@/components/ui/primitives';
import { SymbolLogo } from '@/features/watchlist/SymbolLogo';
import { useResizeConfirm } from '@/stores/resize-confirm-store';

/**
 * The checkpoint before a pending order is resized.
 *
 * A resize is not a modify: this server cannot change a pending order's size in
 * place, so the order is cancelled and replaced. It therefore leaves the book
 * for a moment and comes back under a NEW ticket. Both facts are stated here,
 * because a trader who typed a new number into a Qty field has asked for
 * neither, and would otherwise learn about the new id afterwards — from an
 * order that no longer matches the one in their notes.
 *
 * Mounted once at the app root: the request originates in the charting
 * library's own dialog, which calls into the broker adapter, which has nowhere
 * of its own to render.
 */
export function ResizeOrderConfirm() {
  const pending = useResizeConfirm((s) => s.pending);
  const answer = useResizeConfirm((s) => s.answer);

  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!pending) return;
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    // Focus lands on the safe option, and the confirm button is never
    // autofocused: a stray Enter must not cancel a live order.
    cancelRef.current?.focus();
    return () => previouslyFocused.current?.focus();
  }, [pending]);

  useEffect(() => {
    if (!pending) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        answer(false);
        return;
      }
      if (event.key !== 'Tab') return;

      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable || focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [pending, answer]);

  if (!pending) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={() => answer(false)}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="resize-order-title"
        onClick={(event) => event.stopPropagation()}
        className="w-full max-w-sm rounded-lg border border-[var(--border-strong)] bg-[var(--surface-overlay)] p-4 shadow-[var(--shadow-panel)]"
      >
        <h2 id="resize-order-title" className="text-sm font-semibold">
          Change order size?
        </h2>

        <dl className="mt-3 space-y-1.5 text-xs">
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-text-secondary">Symbol</dt>
            <dd className="flex items-center gap-1.5">
              <SymbolLogo symbol={pending.displaySymbol} size={14} />
              {pending.displaySymbol}
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-text-secondary">Size</dt>
            <dd className="tabular">
              {pending.from} → <span className="font-semibold">{pending.to}</span> lots
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-text-secondary">Order</dt>
            <dd className="tabular">{pending.orderId}</dd>
          </div>
        </dl>

        {/* The part the trader has not asked for and must not discover later. */}
        <p className="mt-3 rounded border border-[var(--warning)] bg-warning/10 p-2 text-2xs text-[var(--warning)]">
          This server cannot change the size of an order that is already placed. Order{' '}
          <span className="tabular">{pending.orderId}</span> will be cancelled and replaced with a
          new one at {pending.to} lots, keeping the same price, stop loss and take profit.{' '}
          <strong>The order will get a new ID</strong>, and will briefly not be on the market.
        </p>

        <div className="mt-4 flex justify-end gap-2">
          <Button ref={cancelRef} variant="ghost" size="sm" onClick={() => answer(false)}>
            Keep {pending.from} lots
          </Button>
          <Button variant="primary" size="sm" onClick={() => answer(true)}>
            Cancel &amp; replace
          </Button>
        </div>
      </div>
    </div>
  );
}
