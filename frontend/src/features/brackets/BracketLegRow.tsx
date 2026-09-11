import { X } from 'lucide-react';
import { Badge, Button, Unavailable } from '@/components/ui/primitives';
import { Td } from '@/components/ui/table';
import type { DecimalString } from '@/domain/common/decimal';
import type { TradingOrder } from '@/domain/common/models';
import { useBracketLegCancel } from './useBracketLegCancel';
import { formatPrice } from '@/domain/market/price-format';

/**
 * One bracket leg as its own table row, nested under its parent order.
 *
 * The chart shows brackets as first-class objects — their own line, their own
 * close button — while the dock showed them only as numbers in the parent's
 * S/L and T/P columns. That asymmetry made brackets unverifiable as entities:
 * QA could not point at "the stop-loss order" anywhere in a grid. These rows
 * close that gap using the SAME domain data the chart's synthetic orders are
 * built from.
 *
 * The quantity column shows the parent's volume, because that is what an MT5
 * bracket IS: a protective level at implicitly the parent's full size. There is
 * no independent per-leg quantity on this backend — rendering the parent's
 * volume here is the truth, not a placeholder.
 */
export function BracketLegRow({
  order,
  leg,
  level,
  digits,
  readOnly,
}: {
  order: TradingOrder;
  leg: 'sl' | 'tp';
  level: DecimalString;
  digits: number;
  readOnly: boolean;
}) {
  const { canceling, cancel, legName } = useBracketLegCancel({ kind: 'order', order }, leg);

  // A protective leg closes the parent, so it sits on the opposite side; the
  // stop leg executes as a stop order, the target leg as a limit.
  const side = order.side === 'buy' ? 'sell' : 'buy';
  const kind = leg === 'sl' ? 'stop' : 'limit';

  return (
    <tr className="border-b border-[var(--border-default)] bg-[var(--background-secondary)]/40">
      <Td>
        <span className="pl-3 text-text-muted">└ {legName}</span>
      </Td>
      <Td>
        <span className="capitalize text-text-secondary">{kind}</span>
      </Td>
      <Td>
        <Badge tone={side === 'buy' ? 'positive' : 'negative'}>
          {side === 'buy' ? 'Buy' : 'Sell'}
        </Badge>
      </Td>
      <Td align="right">
        <span className="tabular">{order.volume}</span>
      </Td>
      <Td align="right">
        <span className="tabular">{formatPrice(level, digits)}</span>
      </Td>
      <Td align="right">
        <Unavailable />
      </Td>
      {/* Its own S/L / T/P cells stay empty: a bracket has no brackets. */}
      <Td align="right">
        <Unavailable />
      </Td>
      <Td align="right">
        <Unavailable />
      </Td>
      <Td>
        {/* This row's parent is a PENDING order, so the leg cannot trigger
            yet — it arms only if the parent fills. Calling it Working, the
            same word the live parent carries, claimed a protective stop was
            already guarding something. */}
        <span title={`Arms if order ${order.id} fills`}>
          <Badge tone="neutral">Inactive</Badge>
        </span>
      </Td>
      <Td>
        <Unavailable />
      </Td>
      <Td align="right">
        <div className="flex justify-end">
          <Button
            size="xs"
            variant="danger"
            disabled={readOnly || canceling}
            loading={canceling}
            onClick={() => void cancel()}
            aria-label={`Cancel ${legName.toLowerCase()} on order ${order.id}`}
          >
            {canceling ? '' : <X className="h-2.5 w-2.5" aria-hidden />}
            Cancel
          </Button>
        </div>
      </Td>
    </tr>
  );
}
