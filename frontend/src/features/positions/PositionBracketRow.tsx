import { X } from 'lucide-react';
import { Badge, Button, Unavailable } from '@/components/ui/primitives';
import { Td } from '@/components/ui/table';
import { useBracketLegCancel } from '@/features/brackets/useBracketLegCancel';
import { formatPrice } from '@/domain/market/price-format';
import type { DecimalString } from '@/domain/common/decimal';
import type { Position } from '@/domain/common/models';

/**
 * One bracket leg of an OPEN POSITION, as its own row beneath it.
 *
 * Orders already showed their legs this way; positions showed theirs only as
 * numbers in the S/L and T/P columns, so the one bracket state that is
 * genuinely live — a stop that can trigger right now — was the one with no row
 * to point at. These legs are Working, not Inactive: their parent is already in
 * the market.
 *
 * The quantity is the parent\'s, because that is what an MT5 bracket is — a
 * protective level at the position\'s full size, with no independent quantity
 * of its own.
 */
export function PositionBracketRow({
  position,
  leg,
  level,
  digits,
  readOnly,
  isVisible,
}: {
  position: Position;
  leg: 'sl' | 'tp';
  level: DecimalString;
  digits: number;
  readOnly: boolean;
  isVisible: (id: string) => boolean;
}) {
  const { canceling, cancel, legName } = useBracketLegCancel({ kind: 'position', position }, leg);

  // A protective leg closes the position, so it sits on the opposite side.
  const side = position.side === 'buy' ? 'sell' : 'buy';
  const kind = leg === 'sl' ? 'stop' : 'limit';

  return (
    <tr className="border-b border-[var(--border-default)] bg-[var(--background-secondary)]/40">
      <Td>
        <span className="pl-3 text-text-muted">
          └ {legName} <span className="capitalize">({kind})</span>
        </span>
      </Td>
      <Td>
        <Badge tone={side === 'buy' ? 'positive' : 'negative'}>
          {side === 'buy' ? 'Buy' : 'Sell'}
        </Badge>
      </Td>
      <Td align="right">
        <span className="tabular">{position.volume}</span>
      </Td>
      {isVisible('open') && (
        <Td align="right">
          <span className="tabular">{formatPrice(level, digits)}</span>
        </Td>
      )}
      {isVisible('current') && (
        <Td align="right">
          <Unavailable />
        </Td>
      )}
      {/* Its own S/L and T/P cells stay empty: a bracket has no brackets. */}
      {isVisible('sl') && (
        <Td align="right">
          <Unavailable />
        </Td>
      )}
      {isVisible('tp') && (
        <Td align="right">
          <Unavailable />
        </Td>
      )}
      {isVisible('swap') && (
        <Td align="right">
          <Unavailable />
        </Td>
      )}
      <Td align="right">
        <Unavailable />
      </Td>
      {isVisible('opened') && (
        <Td>
          <Unavailable />
        </Td>
      )}
      <Td align="right">
        <div className="flex items-center justify-end gap-1">
          <Badge tone="info">Working</Badge>
          <Button
            size="xs"
            variant="danger"
            disabled={readOnly || canceling}
            loading={canceling}
            onClick={() => void cancel()}
            aria-label={`Cancel ${legName.toLowerCase()} on position ${position.id}`}
          >
            {canceling ? '' : <X className="h-2.5 w-2.5" aria-hidden />}
            Cancel
          </Button>
        </div>
      </Td>
    </tr>
  );
}
