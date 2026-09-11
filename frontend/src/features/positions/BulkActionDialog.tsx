import { useCallback, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button, Money } from '@/components/ui/primitives';
import { Modal, ModalRow } from '@/components/ui/Modal';
import { reportError } from '@/app/providers/services';
import { TradingError } from '@/domain/common/errors';
import type { TradeSubmissionResult } from '@/domain/common/models';
import { useSystemMessages } from '@/stores/system-messages-store';

/**
 * Confirmation for an action that affects MANY positions or orders at once.
 *
 * Bulk actions get their own explicit confirmation, separate from the ordinary
 * trade dialog, because the blast radius is the point: it shows the count and
 * the net realised effect before anything is sent, and it reports partial
 * failure honestly rather than as a single success or a single error.
 */

export interface BulkTarget {
  id: string;
  label: string;
}

interface Progress {
  done: number;
  failed: number;
  /** Submitted, but the server never confirmed either way. */
  undecided: number;
}

export function BulkActionDialog({
  title,
  actionLabel,
  targets,
  netProfit,
  currency,
  warning,
  run,
  onClose,
}: {
  title: string;
  actionLabel: string;
  targets: readonly BulkTarget[];
  /** Combined P/L when the action realises it; null when not applicable. */
  netProfit: string | null;
  currency: string | null;
  warning?: string;
  /**
   * Runs one item. Return the submission so an UNDECIDED outcome can be counted
   * as such: a resolved promise is not proof of acceptance, and reporting
   * "10 of 10 accepted" when none were confirmed is the worst answer here.
   */
  run: (target: BulkTarget) => Promise<TradeSubmissionResult | void>;
  onClose: () => void;
}) {
  const pushMessage = useSystemMessages((s) => s.push);
  const [submitting, setSubmitting] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  /** Batch size as confirmed, kept because `targets` shrinks while it runs. */
  const [submittedCount, setBatchSize] = useState<number | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  const submit = useCallback(async () => {
    if (submitting) return;
    setSubmitting(true);
    // `targets` is derived from the live store by every caller, so it SHRINKS
    // as items succeed. Everything below reports against the batch as it was
    // when the trader confirmed it — otherwise "cancel all" over three orders
    // that leaves one failure reports it as "of 1".
    const batchSize = targets.length;
    setBatchSize(batchSize);
    setProgress({ done: 0, failed: 0, undecided: 0 });

    let done = 0;
    let failed = 0;
    let undecided = 0;
    const failures: string[] = [];
    const undecideds: string[] = [];

    // Sequential, not parallel: these are non-idempotent trade mutations, and
    // firing a dozen at once makes a partial failure much harder to reason
    // about — and risks tripping the server's rate limiting.
    for (const target of targets) {
      try {
        const result = await run(target);
        if (result && result.state === 'unknown') {
          undecided += 1;
          undecideds.push(target.label);
        } else {
          done += 1;
        }
      } catch (error) {
        failed += 1;
        failures.push(target.label);
        reportError('bulk', TradingError.from(error));
      }
      setProgress({ done, failed, undecided });
    }

    const parts = [`${done} accepted`];
    if (undecided > 0) parts.push(`${undecided} undecided (${undecideds.join(', ')})`);
    if (failed > 0) parts.push(`${failed} failed (${failures.join(', ')})`);

    pushMessage({
      level: failed === 0 && undecided === 0 ? 'success' : 'warning',
      scope: 'bulk',
      text:
        failed === 0 && undecided === 0
          ? `${actionLabel}: ${done} of ${batchSize} accepted.`
          : `${actionLabel}: ${parts.join(', ')}.`,
      code: 'bulk.complete',
      requestId: null,
    });

    setSubmitting(false);
    // An undecided item leaves the dialog open too: it needs the same "check
    // before retrying" pause a failure does.
    if (failed === 0 && undecided === 0) onClose();
  }, [submitting, targets, run, actionLabel, pushMessage, onClose]);

  const unresolved = (progress?.failed ?? 0) + (progress?.undecided ?? 0);

  return (
    <Modal title={title} titleId="bulk-action-title" onClose={onClose} initialFocusRef={cancelRef}>
      <dl className="mt-3 space-y-1.5 text-xs">
        <ModalRow label="Affected">
          <span className="tabular font-semibold">{targets.length}</span>
        </ModalRow>
        {netProfit !== null && (
          <ModalRow label="Net profit / loss">
            <Money value={netProfit} currency={currency} colorBySign />
          </ModalRow>
        )}
      </dl>

      <ul className="widget-scroll mt-2 max-h-32 space-y-0.5 rounded border border-[var(--border-default)] bg-[var(--background-tertiary)] p-1.5 text-2xs text-text-secondary">
        {targets.map((target) => (
          <li key={target.id}>{target.label}</li>
        ))}
      </ul>

      <div className="mt-2 flex items-start gap-1.5 text-2xs text-[var(--warning)]">
        <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
        <p>
          {warning ??
            'This sends one request per item and cannot be undone. Each is submitted in turn; some may succeed while others are rejected.'}
        </p>
      </div>

      {progress && (
        <p role="status" className="mt-2 text-2xs text-text-secondary">
          {progress.done} accepted
          {progress.undecided > 0 ? `, ${progress.undecided} undecided` : ''}
          {progress.failed > 0 ? `, ${progress.failed} failed` : ''} of{' '}
          {submittedCount ?? targets.length}.
          {unresolved > 0 && !submitting
            ? progress.undecided > 0
              ? ' Check Positions before retrying — an undecided item may have gone through.'
              : ' Review System Messages, then close and retry the rest.'
            : ''}
        </p>
      )}

      <div className="mt-4 flex gap-2">
        <Button ref={cancelRef} variant="secondary" size="md" onClick={onClose} className="flex-1">
          {progress && !submitting ? 'Close' : 'Cancel'}
        </Button>
        <Button
          variant="danger"
          size="md"
          loading={submitting}
          disabled={targets.length === 0}
          onClick={() => void submit()}
          className="flex-1"
        >
          {actionLabel}
        </Button>
      </div>
    </Modal>
  );
}
