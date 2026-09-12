import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { Button, Field, Input } from '@/components/ui/primitives';
import { cn } from '@/components/ui/cn';
import type { ClientAccount } from '../api';
import { formatMoney, useAccounts } from '../hooks';
import { useSearchParam } from '../router';
import { AccountSelect, Card, Notice, Select } from './ui';
import { errorMessage } from './format';

/**
 * The shape shared by Deposit and Withdrawal: pick an account, a method
 * and an amount; confirm; see the result. The page supplies the words, the
 * eligible accounts, the limits and the mutation.
 */

const QUICK_AMOUNTS = [100, 500, 1000, 5000];

export interface MoneyFormProps {
  title: string;
  accountLabel: string;
  submitLabel: string;
  methods: readonly string[];
  eligible: (account: ClientAccount) => boolean;
  /** Ceiling for the amount, when the page knows one; null for none. */
  max?: (account: ClientAccount) => number | null;
  maxLabel?: string;
  /** Blocks the form with a message when the trader may not do this at all. */
  blocked?: ReactNode;
  pending: boolean;
  error: unknown;
  onSubmit: (input: { login: string; amount: number; method: string }) => void;
  result?: ReactNode;
  aside?: ReactNode;
}

export function MoneyForm(props: MoneyFormProps) {
  const accounts = useAccounts();
  const preselected = useSearchParam('account');
  const eligible = useMemo(
    () => (accounts.data ?? []).filter(props.eligible),
    [accounts.data, props],
  );
  const [login, setLogin] = useState(preselected ?? '');
  const [method, setMethod] = useState(props.methods[0] ?? '');
  const [amount, setAmount] = useState('');

  // Only once the list is known: before that, an ?account= preselection
  // would be thrown away for an empty list.
  useEffect(() => {
    if (!accounts.data) return;
    if (!eligible.some((a) => a.login === login)) setLogin(eligible[0]?.login ?? '');
  }, [accounts.data, eligible, login]);
  useEffect(() => {
    if (!props.methods.includes(method)) setMethod(props.methods[0] ?? '');
  }, [props.methods, method]);

  const account = eligible.find((a) => a.login === login) ?? null;
  const numeric = Number(amount);
  const max = account && props.max ? props.max(account) : null;
  const amountError =
    amount === ''
      ? null
      : !Number.isFinite(numeric) || numeric <= 0
        ? 'Enter an amount above zero.'
        : max !== null && numeric > max
          ? `${props.maxLabel ?? 'Maximum'} is ${formatMoney(max, account?.currency)}.`
          : null;
  const canSubmit = !!account && amount !== '' && !amountError && !props.pending;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!canSubmit || !account) return;
    props.onSubmit({ login: account.login, amount: Math.round(numeric * 100) / 100, method });
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
      <Card as="form" className="p-5" onSubmit={submit}>
        {props.blocked ? (
          <Notice tone="info">{props.blocked}</Notice>
        ) : eligible.length === 0 && accounts.data ? (
          <Notice tone="info">No account is eligible for this operation.</Notice>
        ) : (
          <div className="space-y-5">
            <Field label={props.accountLabel} htmlFor="money-account">
              <AccountSelect
                id="money-account"
                accounts={eligible}
                value={login}
                onChange={setLogin}
              />
            </Field>
            <Field label="Payment method" htmlFor="money-method">
              <Select
                id="money-method"
                value={method}
                onChange={(event) => setMethod(event.target.value)}
              >
                {props.methods.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label={`Amount (${account?.currency ?? 'USD'})`}
              htmlFor="money-amount"
              error={amountError}
              hint={
                max !== null && !amountError
                  ? `${props.maxLabel ?? 'Maximum'}: ${formatMoney(max, account?.currency)}`
                  : null
              }
            >
              <Input
                id="money-amount"
                inputMode="decimal"
                placeholder="0.00"
                value={amount}
                onChange={(event) => setAmount(event.target.value.replace(/[^0-9.]/g, ''))}
                className="h-11 text-lg"
              />
              <div className="mt-2 flex flex-wrap gap-2">
                {QUICK_AMOUNTS.map((q) => (
                  <button
                    key={q}
                    type="button"
                    onClick={() => setAmount(String(q))}
                    className={cn(
                      'rounded border border-[var(--border-default)] px-2.5 py-1 text-xs hover:bg-[var(--surface-raised)]',
                      Number(amount) === q && 'bg-[var(--surface-raised)] font-medium',
                    )}
                  >
                    {q.toLocaleString()}
                  </button>
                ))}
                {max !== null && max > 0 && (
                  <button
                    type="button"
                    onClick={() => setAmount(String(Math.floor(max * 100) / 100))}
                    className="rounded border border-[var(--border-default)] px-2.5 py-1 text-xs hover:bg-[var(--surface-raised)]"
                  >
                    Max
                  </button>
                )}
              </div>
            </Field>
            {props.error ? <Notice tone="error">{errorMessage(props.error)}</Notice> : null}
            {props.result}
            <Button
              type="submit"
              variant="primary"
              size="lg"
              className="w-full sm:w-auto"
              disabled={!canSubmit}
              loading={props.pending}
            >
              {props.submitLabel}
            </Button>
          </div>
        )}
      </Card>
      {props.aside && <div className="space-y-4">{props.aside}</div>}
    </div>
  );
}
