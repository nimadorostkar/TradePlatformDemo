import { useMemo, useState } from 'react';
import { Download } from 'lucide-react';
import {
  Button,
  EmptyState,
  ErrorState,
  LoadingState,
  Money,
  Unavailable,
} from '@/components/ui/primitives';
import { Badge } from '@/components/ui/primitives';
import { Td, Th } from '@/components/ui/table';
import { sortRows, useTableSort, type SortValue } from '@/components/ui/table-sort';
import { useHistory, useOrderHistory, useYearProbe, type HistoryRange } from './useHistory';
import { fillPrices } from './fill-prices';
import { historyTotals, netResultOf } from './net-result';
import { formatBrokerDate, formatBrokerTime, withZone } from '@/domain/common/broker-time';
import { useBrokerOffsetSeconds } from '@/app/providers/use-broker-clock';
import type { ClosedPosition, HistoricalOrder } from '@/domain/common/models';
import { SymbolLogo } from '@/features/watchlist/SymbolLogo';

/**
 * History: two views over the same period selector.
 *
 * "Closed positions" pairs opening/closing MT5 deals — realised P/L, the
 * trader's scoreboard. "Orders" is the broker's ORDER history: every order
 * that reached a final state, INCLUDING cancelled, rejected and expired ones
 * — the record the broker's own platform shows, and the view whose absence
 * made a cancelled order vanish without trace.
 *
 * Ledger entries (deposits, credits, commissions) appear in the Deals widget.
 */

const RANGES: readonly { value: HistoryRange; label: string }[] = [
  { value: '1d', label: 'Today (broker day)' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: '90d', label: 'Last 90 days' },
  { value: '1y', label: 'Last year' },
];

const RANGE_LABEL: Record<HistoryRange, string> = {
  '1d': 'today',
  '7d': 'the last 7 days',
  '30d': 'the last 30 days',
  '90d': 'the last 90 days',
  '1y': 'the last year',
};

type HistoryView = 'positions' | 'orders';

export default function OrderHistoryWidget() {
  // 90 days, not 30: the shorter default rendered "No closed positions" on
  // accounts whose latest trade was five weeks old — indistinguishable from
  // data loss, and the exact trigger of a "history is not recorded" report.
  const [range, setRange] = useState<HistoryRange>('90d');
  const [view, setView] = useState<HistoryView>('positions');
  const [symbolFilter, setSymbolFilter] = useState('');

  const history = useHistory(range);
  const orders = useOrderHistory(range, view === 'orders');

  const active = view === 'positions' ? history : orders;
  const loading = active.loading;
  const error = active.error;

  const positionRows = useMemo(() => {
    if (symbolFilter.trim() === '') return history.closedPositions;
    const needle = symbolFilter.trim().toUpperCase();
    return history.closedPositions.filter((p) => p.displaySymbol.toUpperCase().includes(needle));
  }, [history.closedPositions, symbolFilter]);

  const orderRows = useMemo(() => {
    if (symbolFilter.trim() === '') return orders.orders;
    const needle = symbolFilter.trim().toUpperCase();
    return orders.orders.filter((o) => o.displaySymbol.toUpperCase().includes(needle));
  }, [orders.orders, symbolFilter]);

  // What each order actually EXECUTED at, from the deals that filled it.
  //
  // An order record only carries the price the order ASKED for, so a stop
  // placed at 1.16759 showed 1.16759 whether it filled there or a point away,
  // and a market order — which has no price of its own — showed nothing at all.
  // The deal is the only record of what a trade really cost, and it names the
  // order it executed. Deals for the same window are already loaded for the
  // closed-positions view, so this join costs nothing.
  const fills = useMemo(() => fillPrices(history.deals), [history.deals]);

  const rowCount = view === 'positions' ? positionRows.length : orderRows.length;

  // An empty window is only allowed to say "empty" once the widest window has
  // been consulted: bare emptiness with data sitting outside the range reads
  // as data loss.
  const probe = useYearProbe(
    !loading &&
      error === null &&
      view === 'positions' &&
      positionRows.length === 0 &&
      range !== '1y',
  );

  const totals = useMemo(() => historyTotals(positionRows), [positionRows]);
  const netTotal = Number(totals.net);

  // One clock for the whole tab, and the column headers name it.
  const brokerOffsetSeconds = useBrokerOffsetSeconds();

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--border-default)] px-2 py-1 text-2xs">
        <div className="flex overflow-hidden rounded border border-[var(--border-default)]">
          <ViewTab active={view === 'positions'} onClick={() => setView('positions')}>
            Closed positions
          </ViewTab>
          <ViewTab active={view === 'orders'} onClick={() => setView('orders')}>
            Orders
          </ViewTab>
        </div>

        <select
          aria-label="History range"
          value={range}
          onChange={(event) => setRange(event.target.value as HistoryRange)}
          className="h-5 rounded border border-[var(--border-default)] bg-[var(--background-tertiary)] px-1"
        >
          {RANGES.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <input
          aria-label="Filter by symbol"
          placeholder="Symbol…"
          value={symbolFilter}
          onChange={(event) => setSymbolFilter(event.target.value)}
          className="h-5 w-24 rounded border border-[var(--border-default)] bg-[var(--background-tertiary)] px-1"
        />

        {view === 'positions' ? (
          <>
            <span className="text-text-muted">{positionRows.length} closed</span>
            <span
              className={netTotal >= 0 ? 'text-[var(--positive)]' : 'text-[var(--negative)]'}
              title={`Net of swap and commission. Gross ${Number(totals.gross).toFixed(
                2,
              )}, charges ${Number(totals.charges).toFixed(2)}.`}
            >
              {netTotal >= 0 ? '+' : ''}
              {netTotal.toFixed(2)} net
            </span>
            {totals.winRate !== null && (
              <span className="text-text-muted">
                {totals.wins}W / {totals.losses}L · {totals.winRate.toFixed(0)}%
              </span>
            )}
          </>
        ) : (
          <span className="text-text-muted">{orderRows.length} orders</span>
        )}

        <Button
          size="xs"
          variant="ghost"
          className="ml-auto"
          onClick={() =>
            view === 'positions'
              ? exportCsv(positionRows, brokerOffsetSeconds)
              : exportOrdersCsv(orderRows, brokerOffsetSeconds)
          }
          disabled={rowCount === 0}
        >
          <Download className="h-2.5 w-2.5" aria-hidden />
          CSV
        </Button>
      </div>

      {active.truncated && (
        <div className="shrink-0 border-b border-[var(--border-default)] bg-[var(--background-tertiary)] px-2 py-1 text-2xs text-[var(--warning,#b58900)]">
          Results truncated — this period holds more records than one view can load. Narrow the
          range for a complete list.
        </div>
      )}

      {loading ? (
        <LoadingState label="Loading history…" />
      ) : error ? (
        <ErrorState title="History unavailable" onRetry={active.refetch} />
      ) : rowCount === 0 ? (
        view === 'positions' && probe.count !== null && probe.count > 0 ? (
          <EmptyState
            title={`No trades in ${RANGE_LABEL[range]}`}
            description={`${probe.count} closed position${probe.count === 1 ? '' : 's'} found in the last year.`}
            action={
              <Button size="xs" onClick={() => setRange('1y')}>
                Show last year
              </Button>
            }
          />
        ) : (
          <EmptyState
            title={view === 'positions' ? 'No closed positions' : 'No orders'}
            description={
              view === 'positions'
                ? 'Closed trades in the selected period appear here.'
                : 'Filled, canceled, rejected and expired orders in the selected period appear here.'
            }
          />
        )
      ) : view === 'positions' ? (
        <PositionsTable rows={positionRows} offsetSeconds={brokerOffsetSeconds} />
      ) : (
        <OrdersTable rows={orderRows} fills={fills} offsetSeconds={brokerOffsetSeconds} />
      )}
    </div>
  );
}

function ViewTab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-2 py-0.5 ${
        active
          ? 'bg-[var(--surface-raised)] font-medium'
          : 'bg-[var(--background-tertiary)] text-text-muted'
      }`}
    >
      {children}
    </button>
  );
}

function closedSortValue(row: ClosedPosition, key: string): SortValue {
  switch (key) {
    case 'symbol':
      return row.displaySymbol;
    case 'side':
      return row.side;
    case 'volume':
      return row.volume;
    case 'open':
      return row.openPrice;
    case 'close':
      return row.closePrice;
    case 'opened':
      return row.openTime;
    case 'closed':
      return row.closeTime;
    case 'swap':
      return row.swap;
    case 'commission':
      return row.commission;
    case 'profit':
      return row.profit;
    case 'net':
      return netResultOf(row);
    default:
      return null;
  }
}

function PositionsTable({
  rows,
  offsetSeconds,
}: {
  rows: readonly ClosedPosition[];
  offsetSeconds: number | null;
}) {
  const { sort, toggle } = useTableSort();
  const sorted = useMemo(
    () => sortRows(rows, sort, closedSortValue, (row) => `${row.id}-${row.closeTime}`),
    [rows, sort],
  );

  return (
    <div className="widget-scroll min-h-0 flex-1">
      <table className="w-full border-collapse text-2xs">
        <thead className="sticky top-0 z-10 bg-[var(--background-tertiary)]">
          <tr className="text-text-muted">
            <Th sortKey="symbol" sort={sort} onSort={toggle}>
              Symbol
            </Th>
            <Th sortKey="side" sort={sort} onSort={toggle}>
              Side
            </Th>
            <Th align="right" sortKey="volume" sort={sort} onSort={toggle}>
              Volume
            </Th>
            <Th align="right" sortKey="open" sort={sort} onSort={toggle}>
              Open
            </Th>
            <Th align="right" sortKey="close" sort={sort} onSort={toggle}>
              Close
            </Th>
            <Th sortKey="opened" sort={sort} onSort={toggle}>
              {withZone('Opened', offsetSeconds)}
            </Th>
            <Th sortKey="closed" sort={sort} onSort={toggle}>
              {withZone('Closed', offsetSeconds)}
            </Th>
            <Th align="right" sortKey="swap" sort={sort} onSort={toggle}>
              Swap
            </Th>
            <Th align="right" sortKey="commission" sort={sort} onSort={toggle}>
              Commission
            </Th>
            <Th align="right" sortKey="profit" sort={sort} onSort={toggle}>
              P/L
            </Th>
            <Th align="right" sortKey="net" sort={sort} onSort={toggle}>
              Net
            </Th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => (
            <tr
              key={`${row.id}-${row.closeTime}`}
              className="border-b border-[var(--border-default)] hover:bg-[var(--surface-raised)]"
            >
              <Td>
                <span className="flex items-center gap-1.5 font-medium">
                  <SymbolLogo symbol={row.displaySymbol} size={13} />
                  {row.displaySymbol}
                </span>
              </Td>
              <Td>
                <Badge tone={row.side === 'buy' ? 'positive' : 'negative'}>
                  {row.side === 'buy' ? 'Buy' : 'Sell'}
                </Badge>
              </Td>
              <Td align="right">
                <span className="tabular">{row.volume}</span>
              </Td>
              <Td align="right">
                {row.openPrice ? (
                  <span className="tabular">{row.openPrice}</span>
                ) : (
                  <BeforeRange inRange={!row.openedBeforeRange} />
                )}
              </Td>
              <Td align="right">
                {row.closePrice ? (
                  <span className="tabular">{row.closePrice}</span>
                ) : (
                  <Unavailable />
                )}
              </Td>
              <Td>
                {row.openTime !== null ? (
                  <TimeCell value={row.openTime} offsetSeconds={offsetSeconds} />
                ) : (
                  <BeforeRange inRange={!row.openedBeforeRange} />
                )}
              </Td>
              <Td>
                <TimeCell value={row.closeTime} offsetSeconds={offsetSeconds} />
              </Td>
              <Td align="right">
                <Money value={row.swap} digits={2} />
              </Td>
              <Td align="right">
                <Money value={row.commission} digits={2} />
              </Td>
              <Td align="right">
                <Money value={row.profit} digits={2} colorBySign />
              </Td>
              <Td align="right">
                <span className="font-medium">
                  <Money value={netResultOf(row)} digits={2} colorBySign />
                </span>
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const ORDER_STATUS_TONE: Record<HistoricalOrder['status'], 'positive' | 'negative' | 'neutral'> = {
  filled: 'positive',
  canceled: 'neutral',
  expired: 'neutral',
  rejected: 'negative',
  working: 'neutral',
  placing: 'neutral',
  unknown: 'neutral',
};

/**
 * What an order's Price column should say.
 *
 * A filled order is reported at the price it EXECUTED at, which is the number
 * that decided the trade's cost, and the requested price is kept alongside it
 * for anyone reconciling slippage. An order that never filled has only the
 * price it asked for, and says so.
 */
function OrderPrice({ requested, filled }: { requested: string | null; filled: string | null }) {
  if (filled === null) {
    return requested ? <span className="tabular">{requested}</span> : <Unavailable />;
  }
  return (
    <span
      className="tabular"
      title={
        requested && requested !== filled
          ? `Filled at ${filled}, ordered at ${requested}`
          : undefined
      }
    >
      {filled}
    </span>
  );
}

function orderSortValue(row: HistoricalOrder, key: string): SortValue {
  switch (key) {
    case 'symbol':
      return row.displaySymbol;
    case 'side':
      return row.side;
    case 'type':
      return row.kind;
    case 'lots':
      return row.volumeLots;
    case 'filled':
      return row.filledLots;
    case 'price':
      return row.price;
    case 'status':
      return row.status;
    case 'placed':
      return row.setupTime;
    case 'final':
      return row.updateTime;
    default:
      return null;
  }
}

function OrdersTable({
  rows,
  fills,
  offsetSeconds,
}: {
  rows: readonly HistoricalOrder[];
  fills: ReadonlyMap<string, string>;
  offsetSeconds: number | null;
}) {
  const { sort, toggle } = useTableSort();
  const sorted = useMemo(() => sortRows(rows, sort, orderSortValue, (row) => row.id), [rows, sort]);

  return (
    <div className="widget-scroll min-h-0 flex-1">
      <table className="w-full border-collapse text-2xs">
        <thead className="sticky top-0 z-10 bg-[var(--background-tertiary)]">
          <tr className="text-text-muted">
            <Th sortKey="symbol" sort={sort} onSort={toggle}>
              Symbol
            </Th>
            <Th sortKey="side" sort={sort} onSort={toggle}>
              Side
            </Th>
            <Th sortKey="type" sort={sort} onSort={toggle}>
              Type
            </Th>
            <Th align="right" sortKey="lots" sort={sort} onSort={toggle}>
              Lots
            </Th>
            <Th align="right" sortKey="filled" sort={sort} onSort={toggle}>
              Filled
            </Th>
            <Th align="right" sortKey="price" sort={sort} onSort={toggle}>
              Price
            </Th>
            <Th align="right">SL</Th>
            <Th align="right">TP</Th>
            <Th sortKey="status" sort={sort} onSort={toggle}>
              Status
            </Th>
            <Th sortKey="placed" sort={sort} onSort={toggle}>
              {withZone('Placed', offsetSeconds)}
            </Th>
            <Th sortKey="final" sort={sort} onSort={toggle}>
              {withZone('Final', offsetSeconds)}
            </Th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => (
            <tr
              key={row.id}
              className="border-b border-[var(--border-default)] hover:bg-[var(--surface-raised)]"
            >
              <Td>
                <span className="flex items-center gap-1.5 font-medium">
                  <SymbolLogo symbol={row.displaySymbol} size={13} />
                  {row.displaySymbol}
                </span>
              </Td>
              <Td>
                <Badge tone={row.side === 'buy' ? 'positive' : 'negative'}>
                  {row.side === 'buy' ? 'Buy' : 'Sell'}
                </Badge>
              </Td>
              <Td>
                <span className="uppercase text-text-muted">{row.kind}</span>
              </Td>
              <Td align="right">
                {row.volumeLots ? (
                  <span className="tabular">{row.volumeLots}</span>
                ) : (
                  <Unavailable />
                )}
              </Td>
              <Td align="right">
                {row.filledLots ? (
                  <span className="tabular">{row.filledLots}</span>
                ) : (
                  <Unavailable />
                )}
              </Td>
              <Td align="right">
                <OrderPrice requested={row.price} filled={fills.get(row.id) ?? null} />
              </Td>
              <Td align="right">
                {row.stopLoss ? <span className="tabular">{row.stopLoss}</span> : <Unavailable />}
              </Td>
              <Td align="right">
                {row.takeProfit ? (
                  <span className="tabular">{row.takeProfit}</span>
                ) : (
                  <Unavailable />
                )}
              </Td>
              <Td>
                <Badge tone={ORDER_STATUS_TONE[row.status]}>{row.status}</Badge>
              </Td>
              <Td>
                <TimeCell value={row.setupTime} offsetSeconds={offsetSeconds} />
              </Td>
              <Td>
                <TimeCell value={row.updateTime} offsetSeconds={offsetSeconds} />
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TimeCell({
  value,
  offsetSeconds,
}: {
  value: number | null;
  offsetSeconds: number | null;
}) {
  if (value === null) return <Unavailable />;
  return <span className="tabular text-text-muted">{formatBrokerTime(value, offsetSeconds)}</span>;
}

/**
 * A missing open price/time is not corrupt data: when the position opened
 * BEFORE the fetched window, its entry deal was never in the response. Say
 * so, instead of a blank that reads as data loss.
 */
function BeforeRange({ inRange }: { inRange: boolean }) {
  if (inRange) return <Unavailable />;
  return <span className="text-text-muted">before range</span>;
}

/** Client-side CSV export — no server endpoint is required or implied. */
function exportCsv(rows: readonly ClosedPosition[], offsetSeconds: number | null): void {
  const header = [
    'Position',
    'Symbol',
    'Side',
    'Volume',
    'Open price',
    'Close price',
    'Open time',
    'Close time',
    'Swap',
    'Commission',
    'Profit',
    'Net',
  ];

  const lines = [
    header.join(','),
    ...rows.map((row) =>
      [
        row.id,
        row.displaySymbol,
        row.side,
        row.volume,
        row.openPrice ?? (row.openedBeforeRange ? 'before range' : ''),
        row.closePrice ?? '',
        // Both open cells must tell the same story: the price column used to
        // say "before range" while the time column beside it went blank.
        row.openTime !== null
          ? new Date(row.openTime).toISOString()
          : row.openedBeforeRange
            ? 'before range'
            : '',
        row.closeTime !== null ? new Date(row.closeTime).toISOString() : '',
        row.swap ?? '',
        row.commission ?? '',
        row.profit ?? '',
        netResultOf(row),
      ]
        .map((cell) => csvEscape(String(cell)))
        .join(','),
    ),
  ];

  // Dated by the clock the interface shows, so the file is not stamped a day
  // ahead of the rows inside it.
  downloadCsv(lines, `trade-history-${formatBrokerDate(Date.now(), offsetSeconds)}.csv`);
}

function exportOrdersCsv(rows: readonly HistoricalOrder[], offsetSeconds: number | null): void {
  const header = [
    'Order',
    'Symbol',
    'Side',
    'Type',
    'Lots',
    'Filled lots',
    'Price',
    'Stop loss',
    'Take profit',
    'Status',
    'Placed',
    'Final',
    'Comment',
  ];

  const lines = [
    header.join(','),
    ...rows.map((row) =>
      [
        row.id,
        row.displaySymbol,
        row.side,
        row.kind,
        row.volumeLots ?? '',
        row.filledLots ?? '',
        row.price ?? '',
        row.stopLoss ?? '',
        row.takeProfit ?? '',
        row.status,
        row.setupTime ? new Date(row.setupTime).toISOString() : '',
        row.updateTime ? new Date(row.updateTime).toISOString() : '',
        row.comment ?? '',
      ]
        .map((cell) => csvEscape(String(cell)))
        .join(','),
    ),
  ];

  downloadCsv(lines, `order-history-${formatBrokerDate(Date.now(), offsetSeconds)}.csv`);
}

function csvEscape(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function downloadCsv(lines: readonly string[], filename: string): void {
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
