import { useMemo, useState } from 'react';
import { ArrowDownToLine, ArrowLeftRight, ArrowUpFromLine } from 'lucide-react';
import { cn } from '@/components/ui/cn';
import { ErrorState, LoadingState } from '@/components/ui/primitives';
import type { ClientTransaction } from '../api';
import { formatDateTime, formatMoney, useTransactions } from '../hooks';
import { Card, PageHeader, Segmented } from '../components/ui';
import { errorMessage } from '../components/format';

type Filter = 'all' | 'deposit' | 'withdrawal' | 'transfer';

const LABEL: Record<ClientTransaction['kind'], string> = {
  deposit: 'Deposit',
  withdrawal: 'Withdrawal',
  transfer_in: 'Transfer in',
  transfer_out: 'Transfer out',
};

export default function TransactionsPage() {
  const transactions = useTransactions();
  const [filter, setFilter] = useState<Filter>('all');
  const rows = useMemo(
    () =>
      (transactions.data ?? []).filter((t) =>
        filter === 'all'
          ? true
          : filter === 'transfer'
            ? t.kind.startsWith('transfer')
            : t.kind === filter,
      ),
    [transactions.data, filter],
  );

  return (
    <>
      <PageHeader
        title="Transaction history"
        description="Every deposit, withdrawal and transfer on your profile, newest first."
      />
      <div className="mb-4">
        <Segmented
          label="Filter"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: 'All' },
            { value: 'deposit', label: 'Deposits' },
            { value: 'withdrawal', label: 'Withdrawals' },
            { value: 'transfer', label: 'Transfers' },
          ]}
        />
      </div>
      {transactions.isPending && <LoadingState label="Loading transactions…" />}
      {transactions.isError && (
        <ErrorState
          title="Could not load transactions"
          description={errorMessage(transactions.error)}
          onRetry={() => void transactions.refetch()}
        />
      )}
      {transactions.data && rows.length === 0 && (
        <Card className="p-8 text-center text-sm text-text-secondary">No transactions yet.</Card>
      )}
      {rows.length > 0 && (
        <Card className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-text-secondary">
              <tr className="border-b border-[var(--border-default)]">
                <th className="px-4 py-3 font-medium">Date</th>
                <th className="px-4 py-3 font-medium">Type</th>
                <th className="px-4 py-3 font-medium">Account</th>
                <th className="px-4 py-3 font-medium">Method</th>
                <th className="px-4 py-3 text-right font-medium">Amount</th>
                <th className="px-4 py-3 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => {
                const outgoing = t.kind === 'withdrawal' || t.kind === 'transfer_out';
                const Icon =
                  t.kind === 'deposit'
                    ? ArrowDownToLine
                    : t.kind === 'withdrawal'
                      ? ArrowUpFromLine
                      : ArrowLeftRight;
                return (
                  <tr key={t.id} className="border-b border-[var(--border-default)] last:border-0">
                    <td className="whitespace-nowrap px-4 py-3 tabular-nums text-text-secondary">
                      {formatDateTime(t.createdAt)}
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center gap-2">
                        <Icon className="h-4 w-4 text-text-muted" aria-hidden />
                        {LABEL[t.kind]}
                      </span>
                    </td>
                    <td className="px-4 py-3 tabular-nums">
                      #{t.login}
                      {t.kind.startsWith('transfer') && t.counterpart !== '0' && (
                        <span className="text-text-muted">
                          {' '}
                          {t.kind === 'transfer_out' ? '→' : '←'} #{t.counterpart}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-text-secondary">{t.method}</td>
                    <td
                      className={cn(
                        'px-4 py-3 text-right font-medium tabular-nums',
                        outgoing ? 'text-[var(--negative)]' : 'text-[var(--positive)]',
                      )}
                    >
                      {outgoing ? '−' : '+'}
                      {formatMoney(t.amount, t.currency)}
                    </td>
                    <td className="px-4 py-3">
                      <span className="rounded bg-[rgba(var(--positive-rgb),0.12)] px-2 py-0.5 text-2xs font-medium capitalize text-[var(--positive)]">
                        {t.status}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}
    </>
  );
}
