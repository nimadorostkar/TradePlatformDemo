import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { ClientTransaction } from '../api';
import {
  formatMoney,
  useCatalogue,
  useClientAreaApi,
  useInvalidateMoney,
  useVerification,
} from '../hooks';
import { ROUTES, useLinkClick } from '../router';
import { MoneyForm } from '../components/MoneyForm';
import { Card, Notice, PageHeader, Row, SectionTitle } from '../components/ui';

export default function DepositPage() {
  const api = useClientAreaApi();
  const catalogue = useCatalogue();
  const verification = useVerification();
  const invalidate = useInvalidateMoney();
  const [last, setLast] = useState<{ transaction: ClientTransaction; balance: number } | null>(
    null,
  );
  const deposit = useMutation({
    mutationFn: (input: { login: string; amount: number; method: string }) => api.deposit(input),
    onSuccess: async (result) => {
      setLast(result);
      await invalidate();
    },
  });
  const v = verification.data?.verification;
  const goVerify = useLinkClick(ROUTES.verification);

  return (
    <>
      <PageHeader
        title="Deposit"
        description="Fund a trading account. This is a demo platform: the deposit is credited instantly and no payment is taken."
      />
      <MoneyForm
        title="Deposit"
        accountLabel="To account"
        submitLabel="Deposit"
        methods={catalogue.data?.depositMethods ?? ['Bank card']}
        eligible={() => true}
        max={(a) => (a.kind === 'real' && v ? v.depositRemaining : null)}
        maxLabel="Available under your verification level"
        blocked={
          v && v.depositLimit === 0 ? (
            <span>
              Deposits to real accounts unlock after the first verification step.{' '}
              <a href={ROUTES.verification} onClick={goVerify} className="font-medium underline">
                Complete your profile
              </a>{' '}
              — demo accounts can be topped up at any time.
            </span>
          ) : null
        }
        pending={deposit.isPending}
        error={deposit.error}
        onSubmit={(input) => {
          setLast(null);
          deposit.mutate(input);
        }}
        result={
          last ? (
            <Notice tone="success">
              {formatMoney(last.transaction.amount, last.transaction.currency)} deposited to #
              {last.transaction.login} via {last.transaction.method}. New balance{' '}
              {formatMoney(last.balance, last.transaction.currency)}.
            </Notice>
          ) : null
        }
        aside={
          <Card className="p-5">
            <SectionTitle>Deposit limit</SectionTitle>
            <div className="space-y-2">
              <Row
                label="Verification level"
                value={v ? `${v.stepsComplete}/${v.stepsTotal} steps` : '—'}
              />
              <Row
                label="Limit"
                value={
                  v ? (v.depositLimit === null ? 'Unlimited' : formatMoney(v.depositLimit)) : '—'
                }
              />
              <Row label="Deposited so far" value={v ? formatMoney(v.depositedTotal) : '—'} />
              <Row
                label="Remaining"
                value={
                  v
                    ? v.depositRemaining === null
                      ? 'Unlimited'
                      : formatMoney(v.depositRemaining)
                    : '—'
                }
              />
            </div>
            {v && !v.verified && (
              <a
                href={ROUTES.verification}
                onClick={goVerify}
                className="mt-4 inline-block text-sm font-medium text-[var(--brand-primary)] hover:underline"
              >
                Raise your limit →
              </a>
            )}
          </Card>
        }
      />
    </>
  );
}
