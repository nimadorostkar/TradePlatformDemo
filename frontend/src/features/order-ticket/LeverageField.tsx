import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/primitives';
import { Modal } from '@/components/ui/Modal';
import { useServices, reportError } from '@/app/providers/services';
import { useToasts } from '@/stores/toast-store';
import { useCapabilities } from '@/stores/capabilities-store';
import { useSessionStore } from '@/stores/session-store';
import { useSystemMessages } from '@/stores/system-messages-store';
import { useTradingStore } from '@/stores/trading-store';
import { TradingError } from '@/domain/common/errors';
import { toDecimalString } from '@/domain/common/decimal';
import { projectLeverageChange } from '@/domain/orders/leverage';

/**
 * Account leverage, with the dialog that changes it.
 *
 * The charting library renders its own leverage control inside ITS order
 * ticket; this is the equivalent for the app's panel, over the same gateway
 * endpoints, so the two cannot disagree.
 *
 * Renders nothing at all unless the gateway reports the capability. Leverage is
 * a property of the ACCOUNT and a broker policy — MT5 has no per-symbol
 * leverage and will not enumerate the permitted values — so where the broker
 * has not said what may be set, there is no control, not a disabled one.
 * TradingView's own test case assumes PER-ORDER leverage and expects symbol /
 * side / order-type tags here; that model does not exist on this broker, so the
 * dialog instead names the ACCOUNT it applies to and the TV case needs
 * amending. (QA 2026-08-24, Issue B decision: account-level kept.)
 */
export function LeverageField() {
  const services = useServices();
  const queryClient = useQueryClient();
  const enabled = useCapabilities((s) => s.capabilities.leverage.enabled);
  const login = useSessionStore((s) => s.activeLogin);
  const accounts = useSessionStore((s) => s.accounts);
  const readOnly = useSessionStore((s) => s.readOnly);
  const pushMessage = useSystemMessages((s) => s.push);
  const account = useTradingStore((s) => s.account);
  const openPositions = useTradingStore((s) => s.positions.length);
  const [open, setOpen] = useState(false);
  // Selecting a preset is an OPINION, not an action. It used to apply the
  // change on the spot with no Confirm and no undo — one mis-click re-margined
  // every open position on the account (QA 2026-08-24, Issue A).
  const [pending, setPending] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const pushToast = useToasts((s) => s.push);
  const patchAccount = useTradingStore((s) => s.patchAccount);

  const query = useQuery({
    queryKey: ['leverage', login],
    enabled: enabled && login !== null,
    staleTime: 5 * 60 * 1000,
    queryFn: ({ signal }) => services.trading.leverage(login!, signal),
  });

  // A read that fails must SAY so. This one failed silently for a whole QA
  // cycle: the row sat on "—", the button was disabled with no tooltip, and the
  // only way to find out was a network log.
  const failure = query.error;
  useEffect(() => {
    if (!failure) return;
    reportError('account', TradingError.from(failure));
  }, [failure]);

  if (!enabled || login === null) return null;

  const state = query.data;
  const blockedBecause = readOnly
    ? 'This account is read-only.'
    : query.isLoading
      ? 'Loading the current leverage…'
      : failure
        ? 'The trading server did not return this account’s leverage.'
        : !state
          ? 'The trading server did not return this account’s leverage.'
          : state.choices.length === 0
            ? 'This broker does not offer a choice of leverage on this account.'
            : null;

  const accountName = accounts.find((a) => a.login === login)?.name ?? account?.name ?? login;

  const projection =
    state && pending !== null && pending !== state.leverage
      ? projectLeverageChange({
          currentLeverage: state.leverage,
          nextLeverage: pending,
          margin: account?.margin ?? null,
          equity: account?.equity ?? null,
        })
      : null;

  // The one client-side veto: a change whose projected requirement is more
  // than the account holds must not be submittable. The server may also
  // reject it, but "the button worked and then an error came back" is a
  // worse experience than the button saying why it will not press.
  const exceedsEquity = projection?.wouldExceedEquity === true;

  const confirmDisabled =
    saving ||
    pending === null ||
    (state !== undefined && pending === state.leverage) ||
    exceedsEquity;

  const closeDialog = () => {
    setOpen(false);
    setPending(null);
    setSaveError(null);
  };

  const confirm = async () => {
    if (saving || pending === null) return;
    setSaving(true);
    setSaveError(null);
    try {
      const next = await services.trading.setLeverage(login, pending);
      // Answered from the server's record, and the account summary carries
      // leverage too — both must move together or one of them is lying.
      queryClient.setQueryData(['leverage', login], next);
      // The Account tab reads the authoritative snapshot, which arrives on the
      // broker's own WebSocket cadence — so the toast said 1:300 while the tab
      // beside it still read 1:200 for about four seconds (2026-08-20 retest).
      // It always converged, but a trader checking their leverage in the one
      // place that is meant to be definitive was told the old number.
      //
      // The store HOLDS this value over the frames that still carry the old
      // one, and hands authority back the moment they agree. Applying it once
      // would have been reverted by the very next frame.
      const confirmed = toDecimalString(next.leverage);
      if (confirmed !== null) patchAccount({ leverage: confirmed });
      // Refetched, not invalidated: invalidating the account key could take the
      // whole account bootstrap with it, which dropped the terminal to its
      // "Loading your accounts…" splash for ten seconds on a change that only
      // moved one number.
      await queryClient.refetchQueries({ queryKey: ['account'], exact: false, type: 'active' });
      // The toast is what the trader actually sees; the system-messages entry
      // is the durable log, and a log alone reads as silence.
      pushToast({
        tone: 'success',
        title: 'Leverage updated',
        body: `This account is now 1:${next.leverage}.`,
      });
      pushMessage({
        level: 'success',
        scope: 'account',
        text: `Leverage is now 1:${next.leverage}.`,
        code: 'leverage.updated',
        requestId: null,
      });
      closeDialog();
    } catch (error) {
      const failure = TradingError.from(error);
      reportError('account', failure);
      // Shown IN the dialog, which stays open and retryable: the dialog used
      // to close-or-sit with no sign that anything had gone wrong.
      setSaveError(failure.message);
      pushToast({
        tone: 'error',
        title: 'Could not change leverage',
        body: failure.message,
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="flex items-center justify-between gap-2 text-2xs">
        <span className="text-text-secondary">Leverage</span>
        <span className="flex items-center gap-1.5">
          <span className="tabular font-medium">
            {state ? `1:${state.leverage}` : query.isLoading ? '…' : '—'}
          </span>
          {failure && (
            <Button size="xs" variant="secondary" onClick={() => void query.refetch()}>
              Retry
            </Button>
          )}
          <Button
            size="xs"
            variant="secondary"
            disabled={blockedBecause !== null}
            // A disabled control with no stated reason is indistinguishable
            // from a broken one — the same rule the BUY/SELL buttons follow.
            title={blockedBecause ?? undefined}
            aria-label={blockedBecause ? `Adjust leverage — ${blockedBecause}` : 'Adjust leverage'}
            onClick={() => setOpen(true)}
          >
            Adjust
          </Button>
        </span>
      </div>

      {open && state && (
        <Modal title="Adjust leverage" titleId="leverage-title" onClose={closeDialog}>
          {/* The scope, named. This dialog changes the ACCOUNT, and the account
              must be identifiable without leaving it. */}
          <p className="mt-0.5 text-2xs font-medium text-text-secondary">{accountName}</p>
          <p className="mt-2 text-2xs text-text-muted">
            Leverage applies to this whole account — every open position and every symbol — not to a
            single order. Nothing changes until you press Confirm.
          </p>

          {!state.choices.includes(state.leverage) && (
            <p className="mt-2 text-2xs text-[var(--warning)]">
              This account is currently on 1:{state.leverage}, which is not one of the values
              offered here. Choosing another cannot be undone from this dialog.
            </p>
          )}

          {saveError && (
            <p role="alert" className="mt-2 text-2xs text-[var(--negative)]">
              {saveError}
            </p>
          )}

          <div className="mt-3 grid grid-cols-3 gap-1.5">
            {state.choices.map((choice) => {
              const isCurrent = choice === state.leverage;
              const isPending = pending !== null && choice === pending;
              return (
                <Button
                  key={choice}
                  size="md"
                  variant={isPending || (pending === null && isCurrent) ? 'primary' : 'secondary'}
                  disabled={saving}
                  onClick={() => setPending(choice)}
                  aria-pressed={isPending || (pending === null && isCurrent)}
                  aria-label={`1:${choice}${isCurrent ? ' (current)' : ''}`}
                >
                  1:{choice}
                  {isCurrent && <span className="ml-1 text-2xs opacity-70">current</span>}
                </Button>
              );
            })}
          </div>

          {projection && openPositions > 0 && (
            <div
              role="status"
              className="mt-3 rounded border border-[var(--warning)] bg-warning/10 p-2 text-2xs text-[var(--warning)]"
            >
              You have {openPositions} open position{openPositions === 1 ? '' : 's'}. Changing
              leverage to 1:{pending} will change your margin requirement
              {projection.marginAfter !== null && account ? (
                <>
                  {' '}
                  from {money(account.margin)} to {money(projection.marginAfter)}{' '}
                  {account.currency ?? ''}
                </>
              ) : null}
              {projection.marginLevelBefore !== null && projection.marginLevelAfter !== null ? (
                <>
                  {' '}
                  and your margin level from {percent(projection.marginLevelBefore)}% to{' '}
                  {percent(projection.marginLevelAfter)}%
                </>
              ) : null}
              . These are estimates — the trading server decides the final figures.
            </div>
          )}

          {exceedsEquity && (
            <p role="alert" className="mt-2 text-2xs text-[var(--negative)]">
              1:{pending} cannot be applied: the projected margin requirement
              {projection?.marginAfter
                ? ` (${money(projection.marginAfter)} ${account?.currency ?? ''})`
                : ''}{' '}
              would exceed this account’s equity. Close positions first.
            </p>
          )}

          <div className="mt-4 flex justify-end gap-2">
            <Button variant="secondary" size="md" disabled={saving} onClick={closeDialog}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="md"
              loading={saving}
              disabled={confirmDisabled}
              // Same rule as every other disabled control: say why.
              title={
                exceedsEquity
                  ? 'The projected margin requirement would exceed equity.'
                  : pending === null || pending === state.leverage
                    ? 'Select a different leverage first.'
                    : undefined
              }
              onClick={() => void confirm()}
            >
              Confirm
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}

/** 2-dp money for the warning copy. Inputs are DecimalStrings, never null here. */
function money(value: string): string {
  return Number(value).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function percent(value: string): string {
  return Number(value).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
