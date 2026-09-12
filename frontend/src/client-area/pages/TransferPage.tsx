import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ArrowRight } from 'lucide-react';
import { Button, Field, Input } from '@/components/ui/primitives';
import { formatMoney, useAccounts, useClientAreaApi, useInvalidateMoney } from '../hooks';
import { useSearchParam } from '../router';
import { AccountSelect, Card, Notice, PageHeader, SectionTitle } from '../components/ui';
import { errorMessage } from '../components/format';

export default function TransferPage() {
  const api = useClientAreaApi();
  const accounts = useAccounts();
  const invalidate = useInvalidateMoney();
  const preselected = useSearchParam('account');
  const [from, setFrom] = useState(preselected ?? '');
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [last, setLast] = useState<string | null>(null);

  const all = useMemo(() => accounts.data ?? [], [accounts.data]);
  const source = all.find((a) => a.login === from) ?? null;
  // Transfers stay within a kind: real ↔ real, demo ↔ demo.
  const targets = useMemo(
    () => all.filter((a) => a.login !== from && (!source || a.kind === source.kind)),
    [all, from, source],
  );

  useEffect(() => {
    if (!accounts.data) return;
    if (!all.some((a) => a.login === from)) setFrom(all[0]?.login ?? '');
  }, [accounts.data, all, from]);
  useEffect(() => {
    if (!targets.some((a) => a.login === to)) setTo(targets[0]?.login ?? '');
  }, [targets, to]);

  const transfer = useMutation({
    mutationFn: (input: { from: string; to: string; amount: number }) => api.transfer(input),
    onSuccess: async (result, input) => {
      setLast(
        `${formatMoney(input.amount, source?.currency)} moved from #${input.from} to #${input.to}. Balances: #${input.from} ${formatMoney(result.balances[input.from], source?.currency)}, #${input.to} ${formatMoney(result.balances[input.to], source?.currency)}.`,
      );
      setAmount('');
      await invalidate();
    },
  });

  const numeric = Number(amount);
  const max = source?.marginFree ?? null;
  const amountError =
    amount === ''
      ? null
      : !Number.isFinite(numeric) || numeric <= 0
        ? 'Enter an amount above zero.'
        : max !== null && numeric > max
          ? `Free margin on #${source?.login} is ${formatMoney(max, source?.currency)}.`
          : null;
  const canSubmit = !!source && !!to && amount !== '' && !amountError && !transfer.isPending;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!canSubmit || !source) return;
    setLast(null);
    transfer.mutate({ from: source.login, to, amount: Math.round(numeric * 100) / 100 });
  };

  return (
    <>
      <PageHeader
        title="Transfer"
        description="Move money between your own trading accounts. Instant, no fee."
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <Card as="form" className="p-5" onSubmit={submit}>
          {all.length < 2 && accounts.data ? (
            <Notice tone="info">You need at least two accounts to transfer between.</Notice>
          ) : (
            <div className="space-y-5">
              <div className="grid items-end gap-3 sm:grid-cols-[1fr_auto_1fr]">
                <Field label="From" htmlFor="transfer-from">
                  <AccountSelect
                    id="transfer-from"
                    accounts={all}
                    value={from}
                    onChange={setFrom}
                  />
                </Field>
                <ArrowRight
                  className="mx-auto mb-2 hidden h-5 w-5 text-text-muted sm:block"
                  aria-hidden
                />
                <Field label="To" htmlFor="transfer-to">
                  <AccountSelect
                    id="transfer-to"
                    accounts={targets}
                    value={to}
                    onChange={setTo}
                    emptyLabel={`No other ${source?.kind ?? ''} account`}
                  />
                </Field>
              </div>
              <Field
                label={`Amount (${source?.currency ?? 'USD'})`}
                htmlFor="transfer-amount"
                error={amountError}
                hint={
                  max !== null && !amountError
                    ? `Free margin: ${formatMoney(max, source?.currency)}`
                    : null
                }
              >
                <Input
                  id="transfer-amount"
                  inputMode="decimal"
                  placeholder="0.00"
                  value={amount}
                  onChange={(event) => setAmount(event.target.value.replace(/[^0-9.]/g, ''))}
                  className="h-11 text-lg"
                />
              </Field>
              {transfer.isError && <Notice tone="error">{errorMessage(transfer.error)}</Notice>}
              {last && <Notice tone="success">{last}</Notice>}
              <Button
                type="submit"
                variant="primary"
                size="lg"
                disabled={!canSubmit}
                loading={transfer.isPending}
              >
                Transfer
              </Button>
            </div>
          )}
        </Card>
        <Card className="p-5">
          <SectionTitle>Rules</SectionTitle>
          <ul className="list-disc space-y-1.5 pl-4 text-sm text-text-secondary">
            <li>Transfers stay within real accounts or within demo accounts.</li>
            <li>Only free margin can be moved out of an account.</li>
            <li>Both legs appear in the transaction history.</li>
          </ul>
        </Card>
      </div>
    </>
  );
}
