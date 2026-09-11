import { Fragment, memo, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { Badge, Button, EmptyState, Unavailable } from '@/components/ui/primitives';
import { formatBrokerTime, withZone } from '@/domain/common/broker-time';
import { useBrokerOffsetSeconds } from '@/app/providers/use-broker-clock';
import { Td, Th } from '@/components/ui/table';
import { sortRows, useTableSort, type SortValue } from '@/components/ui/table-sort';
import { useServices } from '@/app/providers/services';
import type { TradingOrder } from '@/domain/common/models';
import { selectOrders, useTradingStore } from '@/stores/trading-store';
import { useSessionStore } from '@/stores/session-store';
import { useWorkspace } from '@/workspace/layout/workspace-store';
import { StalenessBadge } from '@/features/system-messages/StalenessBadge';
import { BracketCell } from '@/features/brackets/BracketCell';
import { BracketLegRow } from '@/features/brackets/BracketLegRow';
import { ModifyOrderDialog } from './ModifyOrderDialog';
import { BulkActionDialog, type BulkTarget } from '@/features/positions/BulkActionDialog';
import { SymbolLogo } from '@/features/watchlist/SymbolLogo';
import { FALLBACK_DIGITS, useSymbolDigits } from '@/features/watchlist/useSymbolDigits';
import { formatPrice } from '@/domain/market/price-format';
import { dec, decimalStringOf } from '@/domain/common/decimal';
import { useQuote } from '@/stores/quote-store';
import { useSymbolSubscription } from '@/features/watchlist/useSymbolSubscription';

/**
 * Pending orders.
 *
 * Only orders that are actually WORKING are listed. Filled and canceled orders
 * belong in Order History; showing them here would suggest they can still be
 * modified.
 *
 * Note the `status` caveat: over the WebSocket the gateway puts
 * MT5ToTVType(State) into the status field rather than a real status, so some
 * states are genuinely ambiguous and map to `unknown`. We show "Unknown" rather
 * than guessing — and specifically never guess "Filled".
 */

const ACTIVE_STATUSES = new Set<TradingOrder['status']>(['working', 'placing', 'unknown']);

export default function PendingOrdersWidget() {
  const brokerOffsetSeconds = useBrokerOffsetSeconds();
  const allOrders = useTradingStore(selectOrders);
  const freshness = useTradingStore((s) => s.ordersFreshness);
  const readOnly = useSessionStore((s) => s.readOnly);
  const setActiveSymbol = useWorkspace((s) => s.setActiveSymbol);

  const active = useMemo(
    () => allOrders.filter((order) => ACTIVE_STATUSES.has(order.status)),
    [allOrders],
  );
  const { sort, toggle } = useTableSort();
  const orders = useMemo(
    () => sortRows(active, sort, orderSortValue, (order) => order.id),
    [active, sort],
  );

  const [modifying, setModifying] = useState<TradingOrder | null>(null);
  const [cancelAll, setCancelAll] = useState(false);
  // A single cancel goes through the SAME dialog as "Cancel all", with one
  // target in it: one click used to delete a working order outright, with no
  // confirmation and no undo, while closing a position — the less final act of
  // the two — asked first.
  const [cancelling, setCancelling] = useState<TradingOrder | null>(null);
  const services = useServices();

  // MT5 sends prices as floats, so 1.16570 arrives as 1.1657 and rendering the
  // raw value drops the trailing digit. Every instrument has its own precision,
  // so the entry price is formatted to the symbol's digits.
  const visibleSymbols = useMemo(() => [...new Set(orders.map((o) => o.displaySymbol))], [orders]);
  const digitsBySymbol = useSymbolDigits(visibleSymbols);
  // A working order needs a live price to be worth anything: without one the
  // Current column is a dash and the order gives no sense of how far the
  // market sits from its trigger. Only the watchlist, favorites and the ticket
  // subscribed, so an order on a symbol shown in none of them had no quote at
  // all in the store.
  useSymbolSubscription(visibleSymbols);

  const bulkTargets = useMemo(
    () =>
      orders.map<BulkTarget>((o) => ({
        id: o.id,
        label: `${o.displaySymbol} ${o.kind} ${o.side} ${o.volume}${
          o.price
            ? ` @ ${formatPrice(o.price, digitsBySymbol.get(o.displaySymbol) ?? FALLBACK_DIGITS)}`
            : ''
        }`,
      })),
    [orders, digitsBySymbol],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border-default)] px-2 py-1">
        <span className="text-2xs font-medium text-text-secondary">
          {orders.length} pending order{orders.length === 1 ? '' : 's'}
        </span>
        <div className="ml-auto flex items-center gap-1">
          {orders.length > 0 && !readOnly && (
            <Button
              size="xs"
              variant="danger"
              onClick={() => setCancelAll(true)}
              // Named with what it will actually affect: a screen reader
              // otherwise hears "Cancel all" with no object and no count.
              aria-label={`Cancel all ${orders.length} pending order${orders.length === 1 ? '' : 's'}`}
            >
              Cancel all
            </Button>
          )}
          <StalenessBadge freshness={freshness} />
        </div>
      </div>

      {orders.length === 0 ? (
        <EmptyState
          title="No pending orders"
          description="Limit and stop orders appear here until they trigger."
        />
      ) : (
        <div className="widget-scroll min-h-0 flex-1">
          <table className="w-full border-collapse text-2xs">
            <thead className="sticky top-0 z-10 bg-[var(--background-tertiary)]">
              <tr className="text-text-muted">
                <Th sortKey="symbol" sort={sort} onSort={toggle}>
                  Symbol
                </Th>
                <Th sortKey="type" sort={sort} onSort={toggle}>
                  Type
                </Th>
                <Th sortKey="side" sort={sort} onSort={toggle}>
                  Side
                </Th>
                <Th align="right" sortKey="volume" sort={sort} onSort={toggle}>
                  Volume
                </Th>
                <Th align="right" sortKey="price" sort={sort} onSort={toggle}>
                  Entry
                </Th>
                <Th align="right" sortKey="current" sort={sort} onSort={toggle}>
                  Current
                </Th>
                <Th align="right">S/L</Th>
                <Th align="right">T/P</Th>
                <Th sortKey="status" sort={sort} onSort={toggle}>
                  Status
                </Th>
                <Th sortKey="created" sort={sort} onSort={toggle}>
                  {withZone('Created', brokerOffsetSeconds)}
                </Th>
                <Th align="right">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {orders.map((order) => (
                <Fragment key={order.id}>
                  <OrderRow
                    order={order}
                    digits={digitsBySymbol.get(order.displaySymbol) ?? FALLBACK_DIGITS}
                    readOnly={readOnly}
                    onSelect={setActiveSymbol}
                    onModify={setModifying}
                    onCancel={setCancelling}
                  />
                  {/* Bracket legs as their own rows, mirroring the chart's
                      first-class bracket objects so a leg is something a
                      tester can point at — and cancel — in the grid. */}
                  {order.stopLoss !== null && (
                    <BracketLegRow
                      order={order}
                      digits={digitsBySymbol.get(order.displaySymbol) ?? FALLBACK_DIGITS}
                      leg="sl"
                      level={order.stopLoss}
                      readOnly={readOnly}
                    />
                  )}
                  {order.takeProfit !== null && (
                    <BracketLegRow
                      order={order}
                      digits={digitsBySymbol.get(order.displaySymbol) ?? FALLBACK_DIGITS}
                      leg="tp"
                      level={order.takeProfit}
                      readOnly={readOnly}
                    />
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {modifying && <ModifyOrderDialog order={modifying} onClose={() => setModifying(null)} />}

      {cancelling && (
        <BulkActionDialog
          title={`Cancel order ${cancelling.id}`}
          actionLabel="Cancel order"
          targets={[
            {
              id: cancelling.id,
              label: `${cancelling.displaySymbol} ${cancelling.kind} ${cancelling.side} ${cancelling.volume}${
                cancelling.price
                  ? ` @ ${formatPrice(cancelling.price, digitsBySymbol.get(cancelling.displaySymbol) ?? FALLBACK_DIGITS)}`
                  : ''
              }`,
            },
          ]}
          netProfit={null}
          currency={null}
          warning="Canceling removes this order from the market. If it has already triggered it cannot be canceled and will be rejected."
          run={async (target) => {
            const order = useTradingStore.getState().ordersById.get(target.id);
            if (!order) return;
            return services.tradingService.cancelOrder(order);
          }}
          onClose={() => setCancelling(null)}
        />
      )}

      {cancelAll && (
        <BulkActionDialog
          title="Cancel all pending orders"
          actionLabel="Cancel all"
          targets={bulkTargets}
          netProfit={null}
          currency={null}
          warning="Canceling removes these orders from the market. Any that have already triggered cannot be canceled and will be rejected."
          run={async (target) => {
            const order = useTradingStore.getState().ordersById.get(target.id);
            if (!order) return;
            return services.tradingService.cancelOrder(order);
          }}
          onClose={() => setCancelAll(false)}
        />
      )}
    </div>
  );
}

function orderSortValue(order: TradingOrder, key: string): SortValue {
  switch (key) {
    case 'symbol':
      return order.displaySymbol;
    case 'type':
      return order.kind;
    case 'side':
      return order.side;
    case 'volume':
      return order.volume;
    case 'price':
      return order.price;
    case 'current':
      return order.currentPrice;
    case 'status':
      return order.status;
    case 'created':
      return order.createdAt;
    default:
      return null;
  }
}

const OrderRow = memo(function OrderRow({
  order,
  digits,
  readOnly,
  onSelect,
  onModify,
  onCancel,
}: {
  order: TradingOrder;
  digits: number;
  readOnly: boolean;
  onSelect: (symbol: string) => void;
  onModify: (order: TradingOrder) => void;
  onCancel: (order: TradingOrder) => void;
}) {
  const offsetSeconds = useBrokerOffsetSeconds();
  const suffixPolicy = useSessionStore((s) => s.suffixPolicy);
  const quote = useQuote(suffixPolicy.toGateway(order.displaySymbol));

  // The order snapshot's own `last` is optional on the wire and arrives as
  // zero often enough that this column was permanently a dash; the live quote
  // is preferred and the snapshot is the fallback.
  const reference = order.side === 'buy' ? (quote?.ask ?? null) : (quote?.bid ?? null);
  const currentPrice = reference ?? order.currentPrice;
  const distance =
    currentPrice !== null && order.price !== null
      ? formatPrice(decimalStringOf(dec(order.price).minus(dec(currentPrice)).abs()), digits)
      : null;

  return (
    <tr className="border-b border-[var(--border-default)] hover:bg-[var(--surface-raised)]">
      <Td>
        <button
          onClick={() => onSelect(order.displaySymbol)}
          className="flex items-center gap-1.5 font-medium hover:text-[var(--brand-primary)]"
        >
          <SymbolLogo symbol={order.displaySymbol} size={13} />
          {order.displaySymbol}
        </button>
      </Td>
      <Td>
        <span className="capitalize text-text-secondary">{order.kind}</span>
      </Td>
      <Td>
        <Badge tone={order.side === 'buy' ? 'positive' : 'negative'}>
          {order.side === 'buy' ? 'Buy' : 'Sell'}
        </Badge>
      </Td>
      <Td align="right">
        <span className="tabular">{order.volume}</span>
      </Td>
      <Td align="right">
        {order.price ? (
          <span className="tabular">{formatPrice(order.price, digits)}</span>
        ) : (
          <Unavailable />
        )}
      </Td>
      <Td align="right">
        {currentPrice !== null ? (
          <span
            className="tabular"
            title={
              distance === null
                ? undefined
                : `${distance} from the trigger price ${formatPrice(order.price!, digits)}`
            }
          >
            {formatPrice(currentPrice, digits)}
            {distance !== null && <span className="ml-1 text-text-muted">({distance})</span>}
          </span>
        ) : (
          <Unavailable />
        )}
      </Td>
      <Td align="right">
        <BracketCell
          value={order.stopLoss}
          digits={digits}
          leg="sl"
          parent={{ kind: 'order', order }}
          readOnly={readOnly}
        />
      </Td>
      <Td align="right">
        <BracketCell
          value={order.takeProfit}
          digits={digits}
          leg="tp"
          parent={{ kind: 'order', order }}
          readOnly={readOnly}
        />
      </Td>
      <Td>
        <Badge tone={order.status === 'working' ? 'info' : 'neutral'}>
          {order.status === 'unknown' ? 'Unknown' : capitalise(order.status)}
        </Badge>
      </Td>
      <Td>
        {order.createdAt ? (
          <span className="tabular text-text-muted">
            {formatBrokerTime(order.createdAt, offsetSeconds)}
          </span>
        ) : (
          <Unavailable />
        )}
      </Td>
      <Td align="right">
        <div className="flex justify-end gap-1">
          <Button
            size="xs"
            variant="ghost"
            disabled={readOnly}
            onClick={() => onModify(order)}
            aria-label={`Modify order ${order.id}`}
          >
            Modify
          </Button>
          <Button
            size="xs"
            variant="danger"
            disabled={readOnly}
            onClick={() => onCancel(order)}
            aria-label={`Cancel order ${order.id}`}
          >
            <X className="h-2.5 w-2.5" aria-hidden />
            Cancel
          </Button>
        </div>
      </Td>
    </tr>
  );
});

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
