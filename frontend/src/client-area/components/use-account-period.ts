import { useEffect, useMemo, useState } from 'react';
import { SymbolSuffixPolicy } from '@/integrations/gateway/mappers/symbol-suffix';
import type { ClientAccount } from '../api';
import { useAccounts } from '../hooks';
import { useSearchParam } from '../router';

/**
 * The account and period a report page is about, with the symbol-suffix
 * policy the gateway needs for that account.
 */

export type Period = '7d' | '30d' | '90d' | 'all';

const PERIOD_DAYS: Record<Period, number | null> = { '7d': 7, '30d': 30, '90d': 90, all: null };

export function rangeFor(period: Period): { fromSeconds: number; toSeconds: number } {
  const now = Math.floor(Date.now() / 1000);
  const days = PERIOD_DAYS[period];
  return { fromSeconds: days === null ? 0 : now - days * 86_400, toSeconds: now + 60 };
}

export function useAccountPeriod() {
  const accounts = useAccounts({ poll: false });
  const preselected = useSearchParam('account');
  const [login, setLogin] = useState(preselected ?? '');
  const [period, setPeriod] = useState<Period>('30d');
  const list = useMemo(() => accounts.data ?? [], [accounts.data]);
  useEffect(() => {
    if (!accounts.data) return;
    if (!list.some((a) => a.login === login)) setLogin(list[0]?.login ?? '');
  }, [accounts.data, list, login]);
  const account: ClientAccount | null = list.find((a) => a.login === login) ?? null;
  const suffix = useMemo(
    () => SymbolSuffixPolicy.forAccountType(account?.typeId ?? null),
    [account?.typeId],
  );
  return { accounts, list, login, setLogin, period, setPeriod, account, suffix };
}
