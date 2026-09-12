import { useCallback, useMemo, useRef, useState } from 'react';
import { Button, Field, Input } from '@/components/ui/primitives';
import { Modal } from '@/components/ui/Modal';
import { reportError, useServices } from '@/app/providers/services';
import { cmp, dec } from '@/domain/common/decimal';
import { TradingError } from '@/domain/common/errors';
import type { Position } from '@/domain/common/models';
import { useSystemMessages } from '@/stores/system-messages-store';
import { useSymbolMetadata } from '@/features/order-ticket/useSymbolMetadata';
import { partialVolume, validateCloseVolume } from './close-volume';

/**
 * Closes a position, in whole or in part.
 *
 * A partial close submits a smaller volume on the opposite side; MT5 nets it
 * against the open position rather than opening a second one. The remainder is
 * shown explicitly, because "close 0.3 of 1.0" and "close down to 0.3" are easy
 * to confuse and only one of them is what the button does.
 */
export function ClosePositionDialog({
  position,
  onClose,
}: {
  position: Position;
  onClose: () => void;
}) {
  const services = useServices();
  const pushMessage = useSystemMessages((s) => s.push);
  const { symbol } = useSymbolMetadata(position.displaySymbol);

  const [volume, setVolume] = useState<string>(position.volume);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  const validation = useMemo(
    () => validateCloseVolume(volume, position, symbol),
    [volume, position, symbol],
  );

  const submit = useCallback(async () => {
    if (submitting || validation.error !== null || validation.volume === null) return;

    setSubmitting(true);
    setError(null);

    try {
      const isFull = cmp(validation.volume, position.volume) === 0;
      const result = await services.tradingService.closePosition(
        position,
        isFull ? undefined : validation.volume,
      );

      pushMessage({
        level: result.state === 'unknown' ? 'warning' : 'success',
        scope: 'position',
        text:
          result.state === 'unknown'
            ? `Close of ${validation.volume} on position ${position.id}: outcome unknown, reconciling.`
            : `Close of ${validation.volume} on position ${position.id} accepted.`,
        code: isFull ? 'position.close' : 'position.partial-close',
        requestId: result.requestId,
      });

      // FIN-001's settlement follow-up is NOT fired here any more: it now
      // runs wherever a position disappears from the store, so a close from
      // the chart or a stop-loss firing gets the same authoritative number
      // this dialog used to keep to itself.
      onClose();
    } catch (caught) {
      const tradingError = TradingError.from(caught);
      setError(tradingError.message);
      reportError('position', tradingError);
    } finally {
      setSubmitting(false);
    }
  }, [submitting, validation, position, services, pushMessage, onClose]);

  const remaining =
    validation.volume === null
      ? null
      : dec(position.volume).minus(dec(validation.volume)).toFixed();

  return (
    <Modal
      title={`Close ${position.displaySymbol}`}
      titleId="close-position-title"
      onClose={onClose}
      initialFocusRef={cancelRef}
    >
      <p className="mt-0.5 text-2xs text-text-muted">
        {position.side === 'buy' ? 'Buy' : 'Sell'} {position.volume} lots at {position.openPrice}
      </p>

      <div className="mt-3 space-y-2">
        <Field
          label="Volume to close (lots)"
          htmlFor="close-volume"
          error={validation.error}
          hint={
            symbol?.volumeStep
              ? `Step ${symbol.volumeStep}; max ${position.volume}`
              : `Max ${position.volume}`
          }
        >
          <div className="flex gap-1">
            <Input
              id="close-volume"
              inputMode="decimal"
              value={volume}
              onChange={(event) => setVolume(event.target.value)}
              className="flex-1"
            />
            {/* Fractions of the OPEN volume, snapped to the symbol's step. */}
            {([0.25, 0.5, 0.75, 1] as const).map((fraction) => {
              const candidate = partialVolume(position.volume, fraction, symbol);
              if (candidate === null) return null;
              return (
                <button
                  key={fraction}
                  type="button"
                  onClick={() => setVolume(candidate)}
                  className="rounded border border-[var(--border-default)] px-1.5 text-2xs text-text-muted hover:text-text-primary"
                >
                  {fraction === 1 ? 'All' : `${fraction * 100}%`}
                </button>
              );
            })}
          </div>
        </Field>

        {remaining !== null && (
          <p className="text-2xs text-text-muted">
            {dec(remaining).isZero()
              ? 'This closes the entire position.'
              : `${remaining} lots will remain open.`}
          </p>
        )}
      </div>

      {error && (
        <p role="alert" className="mt-2 text-2xs text-[var(--negative)]">
          {error}
        </p>
      )}

      <div className="mt-4 flex gap-2">
        <Button ref={cancelRef} variant="secondary" size="md" onClick={onClose} className="flex-1">
          Cancel
        </Button>
        <Button
          variant="danger"
          size="md"
          loading={submitting}
          disabled={validation.error !== null || validation.volume === null}
          onClick={() => void submit()}
          className="flex-1"
        >
          Close position
        </Button>
      </div>
    </Modal>
  );
}
