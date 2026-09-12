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
import { Card, Notice, PageHeader, SectionTitle } from '../components/ui';

export default function WithdrawalPage() {
  const api = useClientAreaApi();
  const catalogue = useCatalogue();
  const verification = useVerification();
  const invalidate = useInvalidateMoney();
  const [last, setLast] = useState<{ transaction: ClientTransaction; balance: number } | null>(
    null,
  );
  const withdraw = useMutation({
    mutationFn: (input: { login: string; amount: number; method: string }) => api.withdraw(input),
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
        title="Withdrawal"
        description="Withdraw from a real account. Only free margin can leave: money holding open positions stays."
      />
      <MoneyForm
        title="Withdrawal"
        accountLabel="From account"
        submitLabel="Withdraw"
        methods={catalogue.data?.withdrawalMethods ?? ['Bank card']}
        eligible={(a) => a.kind === 'real'}
        max={(a) => a.marginFree}
        maxLabel="Free margin"
        blocked={
          v && !v.withdrawalsEnabled ? (
            <span>
              Withdrawals unlock after the first verification step.{' '}
              <a href={ROUTES.verification} onClick={goVerify} className="font-medium underline">
                Complete your profile
              </a>
              .
            </span>
          ) : null
        }
        pending={withdraw.isPending}
        error={withdraw.error}
        onSubmit={(input) => {
          setLast(null);
          withdraw.mutate(input);
        }}
        result={
          last ? (
            <Notice tone="success">
              {formatMoney(last.transaction.amount, last.transaction.currency)} withdrawn from #
              {last.transaction.login} to {last.transaction.method}. Remaining balance{' '}
              {formatMoney(last.balance, last.transaction.currency)}.
            </Notice>
          ) : null
        }
        aside={
          <Card className="p-5">
            <SectionTitle>Good to know</SectionTitle>
            <ul className="list-disc space-y-1.5 pl-4 text-sm text-text-secondary">
              <li>Withdrawals are processed instantly on this demo platform.</li>
              <li>Demo accounts hold virtual money and cannot be withdrawn from.</li>
              <li>The amount cannot exceed the account's free margin.</li>
            </ul>
          </Card>
        }
      />
    </>
  );
}
