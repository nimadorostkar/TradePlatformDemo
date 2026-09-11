import { useEffect, useRef } from 'react';
import { cn } from '@/components/ui/cn';
import { Button } from '@/components/ui/primitives';
import type { OrderKind, Side } from '@/domain/common/models';
import { SymbolLogo } from '@/features/watchlist/SymbolLogo';

/**
 * Trade confirmation.
 *
 * Deliberately a plain modal rather than a toast-style confirm: this is the
 * last checkpoint before real money moves, so it takes focus, traps it, and
 * requires a deliberate click. The confirm button is NOT autofocused — a stray
 * Enter keypress must not place a trade.
 */

export interface ConfirmTradeDialogProps {
  side: Side;
  kind: OrderKind;
  symbol: string;
  volume: string;
  price: string;
  stopLoss: string | null;
  takeProfit: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmTradeDialog({
  side,
  kind,
  symbol,
  volume,
  price,
  stopLoss,
  takeProfit,
  onConfirm,
  onCancel,
}: ConfirmTradeDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    // Focus lands on Cancel, the safe option.
    cancelRef.current?.focus();
    return () => previouslyFocused.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCancel();
        return;
      }
      if (event.key !== 'Tab') return;

      // Trap focus inside the dialog.
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
  }, [onCancel]);

  const actionLabel = kind === 'market' ? 'Place market order' : `Place ${kind} order`;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onCancel}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-trade-title"
        onClick={(event) => event.stopPropagation()}
        className="w-full max-w-xs rounded-lg border border-[var(--border-strong)] bg-[var(--surface-overlay)] p-4 shadow-[var(--shadow-panel)]"
      >
        <h2 id="confirm-trade-title" className="text-sm font-semibold">
          Confirm order
        </h2>

        <dl className="mt-3 space-y-1.5 text-xs">
          <Row label="Action">
            <span
              className={cn(
                'font-semibold',
                side === 'buy' ? 'text-[var(--positive)]' : 'text-[var(--negative)]',
              )}
            >
              {side.toUpperCase()}
            </span>
          </Row>
          <Row label="Symbol">
            <span className="flex items-center gap-1.5">
              <SymbolLogo symbol={symbol} size={14} />
              {symbol}
            </span>
          </Row>
          <Row label="Type">{kind}</Row>
          <Row label="Volume">
            <span className="tabular">{volume} lots</span>
          </Row>
          <Row label={kind === 'market' ? 'Est. price' : 'Entry price'}>
            <span className="tabular">{price}</span>
          </Row>
          <Row label="Stop loss">
            <span className="tabular">{stopLoss ?? '—'}</span>
          </Row>
          <Row label="Take profit">
            <span className="tabular">{takeProfit ?? '—'}</span>
          </Row>
        </dl>

        {kind === 'market' && (
          <p className="mt-2 text-2xs text-text-muted">
            The market price may move before this order reaches the server. The fill price is set by
            the trading server.
          </p>
        )}

        <div className="mt-4 flex gap-2">
          <Button
            ref={cancelRef}
            variant="secondary"
            size="md"
            onClick={onCancel}
            className="h-9 flex-1"
          >
            Cancel
          </Button>
          <Button
            variant={side === 'buy' ? 'buy' : 'sell'}
            size="md"
            onClick={onConfirm}
            className={cn(
              // This dialog exists to place the order, so the confirm carries
              // more width and more weight than Cancel. Focus still starts on
              // Cancel — see the mount effect above.
              'h-9 flex-[1.65] px-4 text-sm font-semibold',
              // Without this the label wrapped to two lines and burst the
              // button's fixed height.
              'whitespace-nowrap',
              // Lifted off the panel so the primary action reads as raised,
              // and pressed back down on click.
              'shadow-[0_2px_10px_-3px_rgb(0_0_0/0.6)] ring-1 ring-inset ring-white/20',
              'transition-[filter,box-shadow,transform] duration-100',
              'hover:shadow-[0_4px_14px_-3px_rgb(0_0_0/0.65)]',
              'active:translate-y-px active:brightness-95 active:shadow-none',
            )}
          >
            {actionLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <dt className="text-text-muted">{label}</dt>
      <dd className="text-text-primary">{children}</dd>
    </div>
  );
}
