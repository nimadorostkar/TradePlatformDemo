import { Badge, EmptyState, LoadingState, Money, Unavailable } from '@/components/ui/primitives';
import { FUNDS_LABEL, FUNDS_TONE, hasBadge } from '@/domain/account/account-environment';
import { selectAccount, useTradingStore } from '@/stores/trading-store';
import { useSessionStore } from '@/stores/session-store';
import { useAccountGroup } from '@/app/providers/use-account-group';
import { StalenessBadge } from '@/features/system-messages/StalenessBadge';

/**
 * Account metrics.
 *
 * Every figure comes from the authoritative account snapshot. Margin level is
 * `null` when no margin is in use — MT5 reports 0 there, which is "not
 * applicable", not "0%".
 */
export default function AccountSummaryWidget() {
  const account = useTradingStore(selectAccount);
  const freshness = useTradingStore((s) => s.accountFreshness);
  const activeLogin = useSessionStore((s) => s.activeLogin);
  const accounts = useSessionStore((s) => s.accounts);

  const group = useAccountGroup(account?.login ?? null);
  // The kind the gateway stated for THIS account, from the same list the
  // header and the picker read.
  const funds =
    accounts.find((option) => option.login === String(account?.login ?? ''))?.kind ?? 'unknown';

  if (!account) {
    // An account switch nulls the snapshot while the new one is fetched, and
    // that took 45 seconds on a login holding seventeen accounts. Saying
    // "No account selected — Choose a trading account." throughout was simply
    // untrue: one had been chosen, and the panel was waiting for it.
    return activeLogin !== null ? (
      <LoadingState label="Loading account…" />
    ) : (
      <EmptyState title="No account selected" description="Choose a trading account." />
    );
  }

  return (
    <div className="widget-scroll h-full p-2">
      <div className="mb-2 flex items-center gap-2">
        <div>
          <p className="text-sm font-semibold">{account.name}</p>
          <p className="text-2xs text-text-muted">
            {account.server ?? 'Server unavailable'} · #{account.login}
          </p>
          {group ? (
            <p className="text-2xs text-text-muted" title="The MT5 group this account trades under">
              Group <span className="tabular">{group}</span>
            </p>
          ) : null}
        </div>
        <StalenessBadge freshness={freshness} className="ml-auto" />
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
        <Metric label="Balance">
          <Money value={account.balance} currency={account.currency} />
        </Metric>
        {/* Shown whenever the server reports it, INCLUDING zero: without it,
            equity exceeding balance by the credit amount reads as an error. */}
        {account.credit !== null && (
          <Metric label="Credit">
            <Money value={account.credit} currency={account.currency} />
          </Metric>
        )}
        <Metric label="Equity">
          <Money value={account.equity} currency={account.currency} />
        </Metric>
        <Metric label="Floating P/L">
          <Money value={account.profit} currency={account.currency} colorBySign />
        </Metric>
        <Metric label="Margin">
          <Money value={account.margin} currency={account.currency} />
        </Metric>
        <Metric label="Free margin">
          <Money value={account.marginFree} currency={account.currency} />
        </Metric>
        <Metric label="Margin level">
          {account.marginLevel === null ? (
            <Unavailable label="No margin in use" />
          ) : (
            <MarginLevel value={account.marginLevel} />
          )}
        </Metric>
        <Metric label="Leverage">
          {account.leverage === null ? (
            <Unavailable />
          ) : (
            <span className="tabular">1:{account.leverage}</span>
          )}
        </Metric>
        <Metric label="Mode">
          <span className={account.readOnly ? 'text-[var(--warning)]' : 'text-text-primary'}>
            {account.readOnly ? 'Read-only' : 'Trading'}
          </span>
        </Metric>
        {/* Stated only when the gateway states it. An account whose kind the
            server has not confirmed says so, rather than claiming either —
            "LIVE" over demo funds, or the reverse, is a misrepresentation on
            the panel a trader checks their balance against. */}
        <Metric label="Funds">
          {hasBadge(funds) ? (
            <Badge tone={FUNDS_TONE[funds as 'live' | 'demo']}>
              {FUNDS_LABEL[funds as 'live' | 'demo']}
            </Badge>
          ) : (
            <Unavailable label="Not confirmed" />
          )}
        </Metric>
      </dl>
    </div>
  );
}

function Metric({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-2 border-b border-[var(--border-default)] pb-1">
      <dt className="text-2xs text-text-muted">{label}</dt>
      <dd className="tabular text-text-primary">{children}</dd>
    </div>
  );
}

/**
 * Margin level with a warning band. The threshold text is shown alongside the
 * colour so the warning does not depend on hue alone.
 */
function MarginLevel({ value }: { value: string }) {
  const level = Number(value);
  const critical = level > 0 && level < 100;
  const warning = level >= 100 && level < 200;

  return (
    <span
      className={
        critical
          ? 'text-[var(--negative)]'
          : warning
            ? 'text-[var(--warning)]'
            : 'text-text-primary'
      }
    >
      {level.toFixed(2)}%{critical ? ' · margin call risk' : warning ? ' · low' : ''}
    </span>
  );
}
