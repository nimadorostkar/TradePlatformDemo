import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useServices } from '@/app/providers/services';
import { env } from '@/app/config/env';
import { ClientAreaApi, type AccountKind, type ClientAccount } from './api';

/**
 * Data hooks for the client area. Everything is React Query keyed under
 * 'pa' so a money movement can invalidate exactly what it changed; the
 * account list polls, because balances and equity move while the page is
 * open (positions run in the terminal next door).
 */

export const paKeys = {
  all: ['pa'] as const,
  me: ['pa', 'me'] as const,
  accounts: ['pa', 'accounts'] as const,
  catalogue: ['pa', 'catalogue'] as const,
  transactions: ['pa', 'transactions'] as const,
  verification: ['pa', 'verification'] as const,
};

export function useClientAreaApi(): ClientAreaApi {
  const services = useServices();
  return useMemo(() => new ClientAreaApi(env().crmHttpUrl, services.tokens), [services.tokens]);
}

export function useMe() {
  const api = useClientAreaApi();
  return useQuery({ queryKey: paKeys.me, queryFn: ({ signal }) => api.me(signal) });
}

export function useAccounts(options: { poll?: boolean } = {}) {
  const api = useClientAreaApi();
  return useQuery({
    queryKey: paKeys.accounts,
    queryFn: ({ signal }) => api.accounts(signal),
    refetchInterval: options.poll === false ? false : 5_000,
    staleTime: 2_000,
  });
}

export function useCatalogue() {
  const api = useClientAreaApi();
  return useQuery({
    queryKey: paKeys.catalogue,
    queryFn: ({ signal }) => api.catalogue(signal),
    staleTime: Infinity,
  });
}

export function useTransactions() {
  const api = useClientAreaApi();
  return useQuery({
    queryKey: paKeys.transactions,
    queryFn: ({ signal }) => api.transactions(signal),
  });
}

export function useVerification() {
  const api = useClientAreaApi();
  return useQuery({
    queryKey: paKeys.verification,
    queryFn: ({ signal }) => api.verification(signal),
    // The identity step verifies itself after the demo's review delay; poll
    // while something is pending so the page catches up without a reload.
    refetchInterval: (query) =>
      query.state.data?.verification.steps.some((s) => s.status === 'pending') ? 5_000 : false,
  });
}

/** Invalidates what a wallet movement or account change can affect. */
export function useInvalidateMoney() {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: paKeys.accounts }),
      queryClient.invalidateQueries({ queryKey: paKeys.transactions }),
      queryClient.invalidateQueries({ queryKey: paKeys.verification }),
    ]);
}

export function useOpenAccount() {
  const api = useClientAreaApi();
  const services = useServices();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      typeId: number;
      kind: AccountKind;
      currency: string;
      leverage: number;
    }) => api.openAccount(input),
    onSuccess: async () => {
      // The gateway JWT's accounts claim was minted before this account
      // existed; renew it so the terminal can trade the new login at once.
      await services.auth.renew().catch(() => null);
      await queryClient.invalidateQueries({ queryKey: paKeys.accounts });
    },
  });
}

export function totalBalance(
  accounts: readonly ClientAccount[] | undefined,
  kind?: 'real' | 'demo',
) {
  if (!accounts) return 0;
  return accounts
    .filter((a) => (kind ? a.kind === kind : true))
    .reduce((sum, a) => sum + (Number.isFinite(a.balance) ? a.balance : 0), 0);
}

export function formatMoney(value: number | null | undefined, currency = 'USD', digits = 2) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${new Intl.NumberFormat(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value)} ${currency}`;
}

export function formatSignedMoney(value: number, currency = 'USD') {
  const sign = value > 0 ? '+' : value < 0 ? '−' : '';
  return sign + formatMoney(Math.abs(value), currency);
}

export function formatDateTime(iso: string | number | null | undefined) {
  if (!iso) return '—';
  const date = typeof iso === 'number' ? new Date(iso) : new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}
