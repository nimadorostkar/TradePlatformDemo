import { useMemo, useState } from 'react';
import {
  Badge,
  EmptyState,
  ErrorState,
  LoadingState,
  Money,
  Unavailable,
} from '@/components/ui/primitives';
import { formatBrokerTime, withZone } from '@/domain/common/broker-time';
import { useBrokerOffsetSeconds } from '@/app/providers/use-broker-clock';
import { Td, Th } from '@/components/ui/table';
import { sortRows, useTableSort, type SortValue } from '@/components/ui/table-sort';
import { useHistory, type HistoryRange } from './useHistory';
import type { Deal, DealKind } from '@/domain/common/models';
import { SymbolLogo } from '@/features/watchlist/SymbolLogo';

/**
 * Raw deals, including the ledger.
 *
 * Unlike Order History this shows EVERY deal — trade legs plus balance,
 * credit, and commission entries — because a trader reconciling their account
 * needs the full ledger. Each row is labelled with its kind so a deposit is
 * never mistaken for a trade.
 */

const KIND_TONE: Record<DealKind, 'neutral' | 'positive' | 'info' | 'warning'> = {
  trade: 'neutral',
  balance: 'positive',
  credit: 'info',
  commission: 'warning',
  other: 'neutral',
};

function dealSortValue(deal: Deal, key: string): SortValue {
  switch (key) {
    case 'id':
      return deal.id;
    case 'kind':
      return deal.kind;
    case 'symbol':
      return deal.displaySymbol;
    case 'side':
      return deal.side;
    case 'volume':
      return deal.volume;
    case 'price':
      return deal.price;
    case 'swap':
      return deal.swap;
    case 'commission':
      return deal.commission;
    case 'profit':
      return deal.profit;
    case 'time':
      return deal.time;
    default:
      return null;
  }
}

export default function DealsWidget() {
  const brokerOffsetSeconds = useBrokerOffsetSeconds();
  const [range, setRange] = useState<HistoryRange>('90d');
  const [showLedgerOnly, setShowLedgerOnly] = useState(false);
  const { deals, loading, error, refetch } = useHistory(range);

  const { sort, toggle } = useTableSort();
  const rows = useMemo(() => {
    const filtered = showLedgerOnly ? deals.filter((d) => d.kind !== 'trade') : deals;
    return sortRows(filtered, sort, dealSortValue, (deal) => deal.id);
  }, [deals, showLedgerOnly, sort]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border-default)] px-2 py-1 text-2xs">
        <select
          aria-label="Deals range"
          value={range}
          onChange={(event) => setRange(event.target.value as HistoryRange)}
          className="h-5 rounded border border-[var(--border-default)] bg-[var(--background-tertiary)] px-1"
        >
          <option value="1d">Today</option>
          <option value="7d">7 days</option>
          <option value="30d">30 days</option>
          <option value="90d">90 days</option>
          <option value="1y">1 year</option>
        </select>
        <label className="hit-target cursor-pointer gap-1 text-text-secondary">
          <input
            type="checkbox"
            checked={showLedgerOnly}
            onChange={(event) => setShowLedgerOnly(event.target.checked)}
          />
          Balance &amp; credit only
        </label>
        <span className="ml-auto text-text-muted">{rows.length} deals</span>
      </div>

      {loading ? (
        <LoadingState label="Loading deals…" />
      ) : error ? (
        <ErrorState title="Deals unavailable" onRetry={refetch} />
      ) : rows.length === 0 ? (
        <EmptyState title="No deals" description="Deals in the selected period appear here." />
      ) : (
        <div className="widget-scroll min-h-0 flex-1">
          <table className="w-full border-collapse text-2xs">
            <thead className="sticky top-0 z-10 bg-[var(--background-tertiary)]">
              <tr className="text-text-muted">
                <Th sortKey="id" sort={sort} onSort={toggle}>
                  Deal
                </Th>
                <Th sortKey="kind" sort={sort} onSort={toggle}>
                  Kind
                </Th>
                <Th sortKey="symbol" sort={sort} onSort={toggle}>
                  Symbol
                </Th>
                <Th sortKey="side" sort={sort} onSort={toggle}>
                  Side
                </Th>
                <Th align="right" sortKey="volume" sort={sort} onSort={toggle}>
                  Volume
                </Th>
                <Th align="right" sortKey="price" sort={sort} onSort={toggle}>
                  Price
                </Th>
                <Th align="right" sortKey="swap" sort={sort} onSort={toggle}>
                  Swap
                </Th>
                <Th align="right" sortKey="commission" sort={sort} onSort={toggle}>
                  Commission
                </Th>
                <Th align="right" sortKey="profit" sort={sort} onSort={toggle}>
                  Profit
                </Th>
                <Th sortKey="time" sort={sort} onSort={toggle}>
                  {withZone('Time', brokerOffsetSeconds)}
                </Th>
                <Th>Comment</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((deal) => (
                <tr
                  key={deal.id}
                  className="border-b border-[var(--border-default)] hover:bg-[var(--surface-raised)]"
                >
                  <Td>
                    <span className="tabular">{deal.id}</span>
                  </Td>
                  <Td>
                    <Badge tone={KIND_TONE[deal.kind]}>{deal.kind}</Badge>
                  </Td>
                  <Td>
                    {deal.displaySymbol ? (
                      <span className="flex items-center gap-1.5">
                        <SymbolLogo symbol={deal.displaySymbol} size={13} />
                        {deal.displaySymbol}
                      </span>
                    ) : (
                      <Unavailable />
                    )}
                  </Td>
                  <Td>
                    {deal.side ? (
                      <span
                        className={
                          deal.side === 'buy' ? 'text-[var(--positive)]' : 'text-[var(--negative)]'
                        }
                      >
                        {deal.side === 'buy' ? 'Buy' : 'Sell'}
                      </span>
                    ) : (
                      <Unavailable />
                    )}
                  </Td>
                  <Td align="right">
                    {deal.volume !== null ? (
                      <span className="tabular">{deal.volume}</span>
                    ) : (
                      <Unavailable />
                    )}
                  </Td>
                  <Td align="right">
                    {deal.price !== null ? (
                      <span className="tabular">{deal.price}</span>
                    ) : (
                      <Unavailable />
                    )}
                  </Td>
                  <Td align="right">
                    <Money value={deal.swap} digits={2} />
                  </Td>
                  <Td align="right">
                    <Money value={deal.commission} digits={2} />
                  </Td>
                  <Td align="right">
                    <Money value={deal.profit} digits={2} colorBySign />
                  </Td>
                  <Td>
                    {deal.time ? (
                      <span className="tabular text-text-muted">
                        {formatBrokerTime(deal.time, brokerOffsetSeconds)}
                      </span>
                    ) : (
                      <Unavailable />
                    )}
                  </Td>
                  <Td>
                    <span className="text-text-muted">{deal.comment ?? ''}</span>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
