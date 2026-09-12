import { useQuery } from '@tanstack/react-query';
import { useServices } from '@/app/providers/services';
import { ErrorState, LoadingState } from '@/components/ui/primitives';
import { cn } from '@/components/ui/cn';
import { formatDateTime } from '../hooks';
import { AccountPeriodBar } from '../components/AccountPeriodBar';
import { rangeFor, useAccountPeriod } from '../components/use-account-period';
import { Card, PageHeader } from '../components/ui';
import { errorMessage } from '../components/format';

/** Every order that reached a final state, from the trading server. */
export default function OrderHistoryPage() {
  const services = useServices();
  const { accounts, list, login, setLogin, period, setPeriod, suffix } = useAccountPeriod();
  const history = useQuery({
    queryKey: ['pa', 'order-history', login, period],
    enabled: login !== '',
    queryFn: ({ signal }) =>
      services.trading.orderHistory(login, rangeFor(period), suffix, {}, signal),
  });
  const orders = [...(history.data?.orders ?? [])].sort(
    (a, b) => (b.updateTime ?? b.setupTime ?? 0) - (a.updateTime ?? a.setupTime ?? 0),
  );

  return (
    <>
      <PageHeader
        title="History of orders"
        description="Filled, cancelled, rejected and expired orders."
      />
      <AccountPeriodBar
        list={list}
        login={login}
        setLogin={setLogin}
        period={period}
        setPeriod={setPeriod}
      />
      {accounts.isPending && <LoadingState label="Loading accounts…" />}
      {history.isPending && login !== '' && <LoadingState label="Loading orders…" />}
      {history.isError && (
        <ErrorState
          title="Could not load order history"
          description={errorMessage(history.error)}
          onRetry={() => void history.refetch()}
        />
      )}
      {history.data && orders.length === 0 && (
        <Card className="p-8 text-center text-sm text-text-secondary">
          No orders in this period.
        </Card>
      )}
      {orders.length > 0 && (
        <Card className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-text-secondary">
              <tr className="border-b border-[var(--border-default)]">
                <th className="px-4 py-3 font-medium">Time</th>
                <th className="px-4 py-3 font-medium">Order</th>
                <th className="px-4 py-3 font-medium">Symbol</th>
                <th className="px-4 py-3 font-medium">Type</th>
                <th className="px-4 py-3 text-right font-medium">Volume</th>
                <th className="px-4 py-3 text-right font-medium">Price</th>
                <th className="px-4 py-3 text-right font-medium">S/L</th>
                <th className="px-4 py-3 text-right font-medium">T/P</th>
                <th className="px-4 py-3 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.id} className="border-b border-[var(--border-default)] last:border-0">
                  <td className="whitespace-nowrap px-4 py-2.5 tabular-nums text-text-secondary">
                    {formatDateTime(o.updateTime ?? o.setupTime)}
                  </td>
                  <td className="px-4 py-2.5 tabular-nums">#{o.id}</td>
                  <td className="px-4 py-2.5 font-medium">{o.displaySymbol}</td>
                  <td className="px-4 py-2.5">
                    <span
                      className={cn(
                        'font-medium capitalize',
                        o.side === 'buy' ? 'text-[var(--positive)]' : 'text-[var(--negative)]',
                      )}
                    >
                      {o.side}
                    </span>{' '}
                    <span className="text-text-secondary">{o.kind}</span>
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums">
                    {o.filledLots ?? '0'} / {o.volumeLots ?? '—'}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{o.price ?? 'market'}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-text-secondary">
                    {o.stopLoss ?? '—'}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-text-secondary">
                    {o.takeProfit ?? '—'}
                  </td>
                  <td className="px-4 py-2.5">
                    <span
                      className={cn(
                        'rounded px-2 py-0.5 text-2xs font-medium capitalize',
                        o.status === 'filled'
                          ? 'bg-[rgba(var(--positive-rgb),0.12)] text-[var(--positive)]'
                          : o.status === 'rejected'
                            ? 'bg-[rgba(var(--negative-rgb),0.12)] text-[var(--negative)]'
                            : 'bg-[var(--surface-raised)] text-text-secondary',
                      )}
                    >
                      {o.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </>
  );
}
