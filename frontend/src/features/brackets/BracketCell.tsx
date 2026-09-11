import { X } from 'lucide-react';
import { Unavailable } from '@/components/ui/primitives';
import type { DecimalString } from '@/domain/common/decimal';
import { formatPrice } from '@/domain/market/price-format';
import { useBracketLegCancel, type BracketParent } from './useBracketLegCancel';

/**
 * One bracket level (S/L or T/P) with its own cancel control.
 *
 * The chart renders brackets as first-class orders with a close button, but
 * this app suppresses TradingView's Account Manager in favour of its own dock —
 * so without this the dock could show a protective level it gave you no way to
 * remove except by reopening the modify dialog and clearing the field. The ×
 * here is the dock's equivalent of the chart's bracket close button, and it
 * clears ONLY this leg: the sibling is preserved by
 * `TradingService.cancelBracketLeg`.
 */
export type { BracketParent };

export function BracketCell({
  value,
  digits,
  leg,
  parent,
  readOnly,
}: {
  value: DecimalString | null;
  digits: number;
  leg: 'sl' | 'tp';
  parent: BracketParent;
  readOnly: boolean;
}) {
  const { canceling, cancel, parentId, legName } = useBracketLegCancel(parent, leg);

  // The WS shapes omit SL/TP entirely when unset — showing 0 would claim a
  // protective level that does not exist.
  if (!value) return <Unavailable />;

  return (
    <span className="inline-flex items-center justify-end gap-1">
      <span className="tabular">{formatPrice(value, digits)}</span>
      {!readOnly && (
        // Kept visible rather than revealed on hover: a control that only
        // exists while the pointer is over the cell is one most traders never
        // find, and an invisible focusable button is worse for keyboard users.
        <button
          type="button"
          disabled={canceling}
          onClick={() => void cancel()}
          title={`Cancel the ${legName.toLowerCase()} on ${parentId}`}
          aria-label={`Cancel ${legName.toLowerCase()} on ${parentId}`}
          className="rounded p-0.5 text-text-muted hover:bg-[var(--surface-raised)] hover:text-[var(--negative)] disabled:opacity-50"
        >
          <X className="h-2.5 w-2.5" aria-hidden />
        </button>
      )}
    </span>
  );
}
