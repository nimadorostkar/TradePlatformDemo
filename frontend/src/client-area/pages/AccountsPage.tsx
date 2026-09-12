import { useMemo, useState, type FormEvent } from 'react';
import {
  ArrowDownToLine,
  ArrowLeftRight,
  ArrowUpFromLine,
  ChevronDown,
  Copy,
  Check,
  KeyRound,
  Plus,
  TrendingUp,
} from 'lucide-react';
import { useMutation } from '@tanstack/react-query';
import { cn } from '@/components/ui/cn';
import { Button, ErrorState, Field, Input, LoadingState } from '@/components/ui/primitives';
import { Modal } from '@/components/ui/Modal';
import type { AccountKind, ClientAccount } from '../api';
import {
  formatMoney,
  formatSignedMoney,
  useAccounts,
  useCatalogue,
  useClientAreaApi,
  useInvalidateMoney,
  useOpenAccount,
} from '../hooks';
import { ROUTES, navigate, terminalUrl } from '../router';
import {
  Card,
  Chip,
  KindBadge,
  Notice,
  PageHeader,
  Row,
  Segmented,
  Select,
} from '../components/ui';
import { errorMessage } from '../components/format';

type SortKey = 'newest' | 'oldest' | 'balance';

export default function AccountsPage() {
  const accounts = useAccounts();
  const [kind, setKind] = useState<AccountKind>('real');
  const [sort, setSort] = useState<SortKey>('newest');
  const [opening, setOpening] = useState(false);
  const [passwordFor, setPasswordFor] = useState<ClientAccount | null>(null);

  const list = useMemo(() => {
    const rows = (accounts.data ?? []).filter((a) => a.kind === kind);
    return rows.sort((a, b) => {
      if (sort === 'balance') return b.balance - a.balance;
      const at = Date.parse(a.createdAt) || Number(a.login);
      const bt = Date.parse(b.createdAt) || Number(b.login);
      return sort === 'newest' ? bt - at : at - bt;
    });
  }, [accounts.data, kind, sort]);

  const counts = {
    real: (accounts.data ?? []).filter((a) => a.kind === 'real').length,
    demo: (accounts.data ?? []).filter((a) => a.kind === 'demo').length,
  };

  return (
    <>
      <PageHeader
        title="My accounts"
        actions={
          <Button variant="secondary" size="md" onClick={() => setOpening(true)}>
            <Plus className="h-4 w-4" aria-hidden />
            Open account
          </Button>
        }
      />
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <Segmented
          label="Account kind"
          value={kind}
          onChange={setKind}
          options={[
            { value: 'real', label: `Real${counts.real ? ` (${counts.real})` : ''}` },
            { value: 'demo', label: `Demo${counts.demo ? ` (${counts.demo})` : ''}` },
          ]}
        />
        <label className="flex items-center gap-2 text-sm text-text-secondary">
          Sort
          <Select
            value={sort}
            onChange={(event) => setSort(event.target.value as SortKey)}
            className="w-36"
            aria-label="Sort accounts"
          >
            <option value="newest">Newest</option>
            <option value="oldest">Oldest</option>
            <option value="balance">Balance</option>
          </Select>
        </label>
      </div>

      {accounts.isPending && <LoadingState label="Loading your accounts…" />}
      {accounts.isError && (
        <ErrorState
          title="Could not load your accounts"
          description={errorMessage(accounts.error)}
          onRetry={() => void accounts.refetch()}
        />
      )}
      {accounts.data && list.length === 0 && (
        <Card className="p-8 text-center">
          <p className="text-sm text-text-secondary">
            {kind === 'demo'
              ? 'No demo accounts yet. A demo account opens with virtual money to practise on.'
              : 'No real accounts yet.'}
          </p>
          <Button variant="primary" size="md" className="mt-4" onClick={() => setOpening(true)}>
            <Plus className="h-4 w-4" aria-hidden />
            Open {kind} account
          </Button>
        </Card>
      )}
      <div className="space-y-4">
        {list.map((account) => (
          <AccountCard
            key={account.login}
            account={account}
            onChangePassword={() => setPasswordFor(account)}
          />
        ))}
      </div>

      {opening && <OpenAccountDialog initialKind={kind} onClose={() => setOpening(false)} />}
      {passwordFor && (
        <TradingPasswordDialog account={passwordFor} onClose={() => setPasswordFor(null)} />
      )}
    </>
  );
}

function AccountCard({
  account,
  onChangePassword,
}: {
  account: ClientAccount;
  onChangePassword: () => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const floating = account.equity - account.balance;
  const [whole, cents] = formatMoney(account.balance, '').trim().split('.');
  const go = (route: string) => navigate(route, { search: `?account=${account.login}` });

  return (
    <Card as="article" className="p-5">
      <div className="flex flex-wrap items-center gap-2">
        <Chip>{account.type.platform}</Chip>
        <Chip>{account.type.title}</Chip>
        <KindBadge kind={account.kind} />
        <span className="ml-1 text-sm font-semibold"># {account.login}</span>
        <span className="text-sm text-text-secondary">{account.type.title}</span>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          aria-label={expanded ? 'Collapse account details' : 'Expand account details'}
          className="ml-auto rounded p-1 text-text-secondary hover:bg-[var(--surface-raised)]"
        >
          <ChevronDown className={cn('h-4 w-4 transition-transform', expanded && 'rotate-180')} />
        </button>
      </div>

      <div className="mt-4 flex flex-wrap items-end justify-between gap-4">
        <div className="text-4xl font-semibold tabular-nums">
          {whole}
          <span className="text-lg text-text-secondary">
            .{cents ?? '00'} {account.currency}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <a
            href={terminalUrl(account.login)}
            className="inline-flex h-9 items-center gap-1.5 rounded bg-[var(--brand-primary)] px-3 text-sm font-medium text-[var(--brand-primary-contrast)] hover:brightness-110"
          >
            <TrendingUp className="h-4 w-4" aria-hidden />
            Trade
          </a>
          <Button size="md" onClick={() => go(ROUTES.deposit)}>
            <ArrowDownToLine className="h-4 w-4" aria-hidden />
            Deposit
          </Button>
          {account.kind === 'real' && (
            <Button size="md" onClick={() => go(ROUTES.withdrawal)}>
              <ArrowUpFromLine className="h-4 w-4" aria-hidden />
              Withdraw
            </Button>
          )}
          <Button size="md" onClick={() => go(ROUTES.transfer)}>
            <ArrowLeftRight className="h-4 w-4" aria-hidden />
            Transfer
          </Button>
        </div>
      </div>

      {expanded && (
        <>
          <div className="mt-4 grid gap-x-8 gap-y-2 rounded bg-[var(--background-tertiary)] p-4 sm:grid-cols-2">
            <Row
              label="Floating P/L"
              value={
                <span
                  className={cn(
                    floating > 0 && 'text-[var(--positive)]',
                    floating < 0 && 'text-[var(--negative)]',
                  )}
                >
                  {formatSignedMoney(floating, account.currency)}
                </span>
              }
            />
            <Row label="Free margin" value={formatMoney(account.marginFree, account.currency)} />
            <Row label="Equity" value={formatMoney(account.equity, account.currency)} />
            <Row label="Max leverage" value={`1:${account.leverage}`} />
            <Row label="Open positions" value={account.openPositions} />
            <Row label="Pending orders" value={account.pendingOrders} />
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
            <CopyField label="Server" value={account.type.server} />
            <CopyField label={`${account.type.platform} login`} value={account.login} />
            <span className="hidden h-4 w-px bg-[var(--border-default)] sm:block" aria-hidden />
            <button
              type="button"
              onClick={onChangePassword}
              className="inline-flex items-center gap-1.5 text-text-secondary hover:text-text-primary"
            >
              <KeyRound className="h-4 w-4" aria-hidden />
              {account.hasTradingPassword ? 'Change trading password' : 'Set trading password'}
            </button>
          </div>
        </>
      )}
    </Card>
  );
}

function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="text-text-secondary">{label}</span>
      <span className="font-medium">{value}</span>
      <button
        type="button"
        aria-label={`Copy ${label}`}
        onClick={() => {
          void navigator.clipboard?.writeText(value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          });
        }}
        className="rounded p-0.5 text-text-muted hover:text-text-primary"
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
    </span>
  );
}

function OpenAccountDialog({
  initialKind,
  onClose,
}: {
  initialKind: AccountKind;
  onClose: () => void;
}) {
  const catalogue = useCatalogue();
  const open = useOpenAccount();
  const [kind, setKind] = useState<AccountKind>(initialKind);
  const [typeId, setTypeId] = useState<number | null>(null);
  const [leverage, setLeverage] = useState<number>(100);
  const types = catalogue.data?.types ?? [];
  const chosen = types.find((t) => t.id === (typeId ?? types[0]?.id));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!chosen) return;
    open.mutate(
      { typeId: chosen.id, kind, currency: 'USD', leverage },
      { onSuccess: () => onClose() },
    );
  };

  return (
    <Modal title="Open account" titleId="open-account-title" onClose={onClose} className="max-w-lg">
      <form onSubmit={submit} className="space-y-4">
        <Segmented
          label="Account kind"
          value={kind}
          onChange={setKind}
          options={[
            { value: 'real', label: 'Real' },
            { value: 'demo', label: 'Demo' },
          ]}
        />
        <p className="text-xs text-text-secondary">
          {kind === 'demo'
            ? `Opens with ${formatMoney(catalogue.data?.demoStartBalance ?? 10000)} of virtual money to practise on.`
            : 'Opens empty; fund it from Deposit. Real accounts on this platform are demo money too — nothing is ever at risk.'}
        </p>
        <fieldset className="space-y-2">
          <legend className="text-2xs font-medium text-text-secondary">Account type</legend>
          {catalogue.isPending && <LoadingState label="Loading account types…" />}
          {types.map((t) => (
            <label
              key={t.id}
              className={cn(
                'flex cursor-pointer items-start gap-3 rounded border p-3',
                chosen?.id === t.id
                  ? 'border-[var(--brand-primary)] bg-[rgba(var(--brand-primary-rgb),0.06)]'
                  : 'border-[var(--border-default)] hover:bg-[var(--surface-raised)]',
              )}
            >
              <input
                type="radio"
                name="account-type"
                className="mt-1"
                checked={chosen?.id === t.id}
                onChange={() => setTypeId(t.id)}
              />
              <span className="flex-1">
                <span className="flex items-center gap-2 text-sm font-medium">
                  {t.platform} {t.title}
                  <Chip>max 1:{t.maxLeverage}</Chip>
                  {t.minDeposit > 0 && <Chip>min deposit {formatMoney(t.minDeposit)}</Chip>}
                </span>
                <span className="mt-0.5 block text-xs text-text-secondary">{t.description}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Leverage" htmlFor="open-leverage">
            <Select
              id="open-leverage"
              value={leverage}
              onChange={(event) => setLeverage(Number(event.target.value))}
            >
              {(catalogue.data?.leverages ?? [100])
                .filter((l) => !chosen || l <= chosen.maxLeverage)
                .map((l) => (
                  <option key={l} value={l}>
                    1:{l}
                  </option>
                ))}
            </Select>
          </Field>
          <Field label="Currency" htmlFor="open-currency">
            <Select id="open-currency" value="USD" disabled>
              <option value="USD">USD</option>
            </Select>
          </Field>
        </div>
        {open.isError && <Notice tone="error">{errorMessage(open.error)}</Notice>}
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" size="md" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            size="md"
            loading={open.isPending}
            disabled={!chosen}
          >
            Open {kind} account
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function TradingPasswordDialog({
  account,
  onClose,
}: {
  account: ClientAccount;
  onClose: () => void;
}) {
  const api = useClientAreaApi();
  const invalidate = useInvalidateMoney();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [done, setDone] = useState(false);
  const change = useMutation({
    mutationFn: () => api.setTradingPassword(account.login, password),
    onSuccess: async () => {
      setDone(true);
      await invalidate();
    },
  });
  const mismatch = confirm !== '' && confirm !== password;

  return (
    <Modal
      title={`Trading password · #${account.login}`}
      titleId="trading-password-title"
      onClose={onClose}
      className="max-w-md"
    >
      {done ? (
        <div className="space-y-4">
          <Notice tone="success">
            The trading password for #{account.login} has been{' '}
            {account.hasTradingPassword ? 'changed' : 'set'}. Use it with server{' '}
            {account.type.server} in {account.type.platform}.
          </Notice>
          <div className="flex justify-end">
            <Button variant="primary" size="md" onClick={onClose}>
              Done
            </Button>
          </div>
        </div>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!mismatch) change.mutate();
          }}
          className="space-y-4"
        >
          <p className="text-xs text-text-secondary">
            8–64 characters with upper and lower case letters and a digit. The web terminal signs
            you in with your profile; this password is for the {account.type.platform} desktop and
            mobile apps.
          </p>
          <Field label="New trading password" htmlFor="tp-new">
            <Input
              id="tp-new"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="h-9 text-sm"
              required
              minLength={8}
            />
          </Field>
          <Field
            label="Repeat password"
            htmlFor="tp-confirm"
            error={mismatch ? 'The passwords do not match.' : null}
          >
            <Input
              id="tp-confirm"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
              className="h-9 text-sm"
              required
            />
          </Field>
          {change.isError && <Notice tone="error">{errorMessage(change.error)}</Notice>}
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" size="md" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" size="md" loading={change.isPending}>
              Save password
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
