import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useServices } from '@/app/providers/services';
import { ErrorState, LoadingState } from '@/components/ui/primitives';
import { cn } from '@/components/ui/cn';
import type { Deal } from '@/domain/common/models';
import { formatDateTime, formatMoney, formatSignedMoney } from '../hooks';
import { AccountPeriodBar } from '../components/AccountPeriodBar';
import { rangeFor, useAccountPeriod } from '../components/use-account-period';
import { Card, PageHeader, SectionTitle, Stat } from '../components/ui';
import { errorMessage } from '../components/format';

/**
 * Trading performance from the broker's own deals: closed-trade P/L, win
 * rate, profit factor and the equity path, for one account over a period.
 */
export default function PerformancePage() {
  const services = useServices();
  const { accounts, list, login, setLogin, period, setPeriod, account, suffix } =
    useAccountPeriod();
  const deals = useQuery({
    queryKey: ['pa', 'deals', login, period],
    enabled: login !== '',
    queryFn: ({ signal }) => services.trading.deals(login, rangeFor(period), suffix, {}, signal),
  });

  const stats = useMemo(() => summarise(deals.data?.deals ?? []), [deals.data]);
  const currency = account?.currency ?? 'USD';

  return (
    <>
      <PageHeader
        title="Performance"
        description="Closed-trade results from the trading server's deal history."
      />
      <AccountPeriodBar
        list={list}
        login={login}
        setLogin={setLogin}
        period={period}
        setPeriod={setPeriod}
      />
      {accounts.isPending && <LoadingState label="Loading accounts…" />}
      {deals.isPending && login !== '' && <LoadingState label="Loading deals…" />}
      {deals.isError && (
        <ErrorState
          title="Could not load deals"
          description={errorMessage(deals.error)}
          onRetry={() => void deals.refetch()}
        />
      )}
      {deals.data && account && (
        <>
          <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Card className="p-5">
              <Stat
                label="Balance"
                value={formatMoney(account.balance, currency)}
                hint={`Equity ${formatMoney(account.equity, currency)}`}
              />
            </Card>
            <Card className="p-5">
              <Stat
                label="Net P/L (closed)"
                value={formatSignedMoney(stats.net, currency)}
                tone={stats.net > 0 ? 'positive' : stats.net < 0 ? 'negative' : undefined}
                hint={`${stats.trades} closed trade${stats.trades === 1 ? '' : 's'}`}
              />
            </Card>
            <Card className="p-5">
              <Stat
                label="Win rate"
                value={stats.trades ? `${Math.round((stats.wins / stats.trades) * 100)}%` : '—'}
                hint={`${stats.wins} won · ${stats.losses} lost`}
              />
            </Card>
            <Card className="p-5">
              <Stat
                label="Profit factor"
                value={
                  stats.grossLoss > 0
                    ? (stats.grossProfit / stats.grossLoss).toFixed(2)
                    : stats.grossProfit > 0
                      ? '∞'
                      : '—'
                }
                hint={`Best ${formatSignedMoney(stats.best, currency)} · worst ${formatSignedMoney(stats.worst, currency)}`}
              />
            </Card>
          </div>

          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
            <Card className="p-5">
              <SectionTitle>Cumulative P/L</SectionTitle>
              {stats.curve.length >= 2 ? (
                <Sparkline points={stats.curve} />
              ) : (
                <p className="text-sm text-text-secondary">
                  Close at least two trades to draw the curve.
                </p>
              )}
            </Card>
            <Card className="p-5">
              <SectionTitle>Money in and out</SectionTitle>
              <dl className="space-y-2 text-sm">
                <Line label="Deposits" value={formatMoney(stats.deposits, currency)} />
                <Line label="Withdrawals" value={formatMoney(stats.withdrawals, currency)} />
                <Line label="Swaps" value={formatSignedMoney(stats.swap, currency)} />
                <Line label="Commission" value={formatSignedMoney(stats.commission, currency)} />
              </dl>
            </Card>
          </div>

          <SectionTitle>
            <span className="mt-6 block">Closed trades</span>
          </SectionTitle>
          {stats.closed.length === 0 ? (
            <Card className="p-8 text-center text-sm text-text-secondary">
              No closed trades in this period.
            </Card>
          ) : (
            <Card className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-text-secondary">
                  <tr className="border-b border-[var(--border-default)]">
                    <th className="px-4 py-3 font-medium">Closed</th>
                    <th className="px-4 py-3 font-medium">Symbol</th>
                    <th className="px-4 py-3 font-medium">Side</th>
                    <th className="px-4 py-3 text-right font-medium">Volume</th>
                    <th className="px-4 py-3 text-right font-medium">Price</th>
                    <th className="px-4 py-3 text-right font-medium">Profit</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.closed.slice(0, 100).map((d) => {
                    const p = Number(d.profit ?? 0);
                    return (
                      <tr
                        key={String(d.id)}
                        className="border-b border-[var(--border-default)] last:border-0"
                      >
                        <td className="whitespace-nowrap px-4 py-2.5 tabular-nums text-text-secondary">
                          {formatDateTime(d.time)}
                        </td>
                        <td className="px-4 py-2.5 font-medium">
                          {d.displaySymbol ?? d.symbol ?? '—'}
                        </td>
                        <td className="px-4 py-2.5 capitalize">{d.side ?? '—'}</td>
                        <td className="px-4 py-2.5 text-right tabular-nums">{d.volume ?? '—'}</td>
                        <td className="px-4 py-2.5 text-right tabular-nums">{d.price ?? '—'}</td>
                        <td
                          className={cn(
                            'px-4 py-2.5 text-right font-medium tabular-nums',
                            p > 0 && 'text-[var(--positive)]',
                            p < 0 && 'text-[var(--negative)]',
                          )}
                        >
                          {formatSignedMoney(p, currency)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </Card>
          )}
        </>
      )}
    </>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <dt className="text-text-secondary">{label}</dt>
      <span className="flex-1 border-b border-dotted border-[var(--border-default)]" aria-hidden />
      <dd className="font-medium tabular-nums">{value}</dd>
    </div>
  );
}

function summarise(deals: readonly Deal[]) {
  const num = (v: string | null) => {
    const n = Number(v ?? 0);
    return Number.isFinite(n) ? n : 0;
  };
  // Closing deals carry the realised result; opening deals carry none.
  const closed = deals
    .filter((d) => d.kind === 'trade' && (d.entry ?? 0) !== 0)
    .sort((a, b) => (b.time ?? 0) - (a.time ?? 0));
  let wins = 0;
  let losses = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  let best = 0;
  let worst = 0;
  let swap = 0;
  let commission = 0;
  for (const d of closed) {
    const p = num(d.profit);
    if (p > 0) {
      wins++;
      grossProfit += p;
    } else if (p < 0) {
      losses++;
      grossLoss += -p;
    }
    best = Math.max(best, p);
    worst = Math.min(worst, p);
    swap += num(d.swap);
    commission += num(d.commission);
  }
  let deposits = 0;
  let withdrawals = 0;
  for (const d of deals) {
    if (d.kind !== 'balance') continue;
    const p = num(d.profit);
    if (p >= 0) deposits += p;
    else withdrawals += -p;
  }
  const curve: number[] = [];
  let running = 0;
  for (const d of [...closed].reverse()) {
    running += num(d.profit);
    curve.push(running);
  }
  return {
    closed,
    trades: closed.length,
    wins,
    losses,
    net: grossProfit - grossLoss,
    grossProfit,
    grossLoss,
    best,
    worst,
    swap,
    commission,
    deposits,
    withdrawals,
    curve,
  };
}

function Sparkline({ points }: { points: number[] }) {
  const width = 600;
  const height = 160;
  const pad = 8;
  const min = Math.min(0, ...points);
  const max = Math.max(0, ...points);
  const span = max - min || 1;
  const x = (i: number) => pad + (i / (points.length - 1)) * (width - pad * 2);
  const y = (v: number) => height - pad - ((v - min) / span) * (height - pad * 2);
  const path = points
    .map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`)
    .join(' ');
  const zero = y(0);
  const last = points[points.length - 1] ?? 0;
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="h-40 w-full"
      role="img"
      aria-label={`Cumulative P/L ending at ${last.toFixed(2)}`}
    >
      <line
        x1={pad}
        x2={width - pad}
        y1={zero}
        y2={zero}
        stroke="var(--border-strong)"
        strokeDasharray="4 4"
      />
      <path
        d={path}
        fill="none"
        stroke={last >= 0 ? 'var(--positive)' : 'var(--negative)'}
        strokeWidth="2"
      />
    </svg>
  );
}
