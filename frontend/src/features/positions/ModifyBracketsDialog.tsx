import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Field, Input } from '@/components/ui/primitives';
import { reportError, useServices } from '@/app/providers/services';
import { toDecimalString } from '@/domain/common/decimal';
import { issueFor, validatePositionBrackets } from '@/domain/orders/validation';
import { useQuote } from '@/stores/quote-store';
import { useSessionStore } from '@/stores/session-store';
import { TradingError } from '@/domain/common/errors';
import type { Position } from '@/domain/common/models';
import { useSystemMessages } from '@/stores/system-messages-store';
import { SymbolLogo } from '@/features/watchlist/SymbolLogo';
import { OrderInfoBlock } from '@/features/order-ticket/OrderInfoBlock';
import { useSymbolMetadata } from '@/features/order-ticket/useSymbolMetadata';

/**
 * Edits a position's protective levels.
 *
 * An EMPTY field means "remove this level" and is sent as MT5's 0, which is how
 * MT5 encodes "no stop". The distinction is spelled out in the UI so clearing a
 * field is never an accident.
 */
export function ModifyBracketsDialog({
  position,
  onClose,
}: {
  position: Position;
  onClose: () => void;
}) {
  const services = useServices();
  const pushMessage = useSystemMessages((s) => s.push);
  const { symbol } = useSymbolMetadata(position.displaySymbol);
  const suffixPolicy = useSessionStore((s) => s.suffixPolicy);

  const [stopLoss, setStopLoss] = useState(position.stopLoss ?? '');
  const [takeProfit, setTakeProfit] = useState(position.takeProfit ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * The price that would close this position right now: a long closes at the
   * bid, a short at the ask. The live quote is preferred over the position
   * snapshot's own `currentPrice`, which only refreshes with the frame.
   */
  const quote = useQuote(suffixPolicy.toGateway(position.displaySymbol));
  const referencePrice =
    (position.side === 'buy' ? quote?.bid : quote?.ask) ?? position.currentPrice ?? null;

  const validation = validatePositionBrackets(
    { side: position.side, stopLoss, takeProfit },
    { referencePrice, symbol },
  );
  const stopLossIssue = issueFor(validation, 'stopLoss');
  const takeProfitIssue = issueFor(validation, 'takeProfit');
  const priceIssue = issueFor(validation, 'price');
  // The same treatment the order ticket gives a blocked BUY: the button says
  // why it cannot be pressed instead of failing silently at the server.
  const blockingMessage =
    validation.issues.find((issue) => issue.severity === 'error')?.message ?? null;

  const firstFieldRef = useRef<HTMLInputElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    firstFieldRef.current?.focus();
    return () => previouslyFocused.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const submit = useCallback(async () => {
    if (submitting) return;

    const nextStopLoss = stopLoss.trim() === '' ? null : toDecimalString(stopLoss);
    const nextTakeProfit = takeProfit.trim() === '' ? null : toDecimalString(takeProfit);

    if (stopLoss.trim() !== '' && nextStopLoss === null) {
      setError('Enter a valid stop-loss price.');
      return;
    }
    if (takeProfit.trim() !== '' && nextTakeProfit === null) {
      setError('Enter a valid take-profit price.');
      return;
    }

    // Both legs, judged against where the market is NOW — a level on the far
    // side of it fires the instant the server accepts it.
    if (!validation.canSubmit) return;

    setSubmitting(true);
    setError(null);

    try {
      const result = await services.tradingService.modifyPositionBrackets(position, {
        stopLoss: nextStopLoss,
        takeProfit: nextTakeProfit,
      });
      pushMessage({
        level: result.state === 'unknown' ? 'warning' : 'success',
        scope: 'position',
        text:
          result.state === 'unknown'
            ? `Modify of position ${position.id}: outcome unknown, reconciling.`
            : `Position ${position.id} levels updated.`,
        code: 'position.modify',
        requestId: result.requestId,
      });
      onClose();
    } catch (caught) {
      const tradingError = TradingError.from(caught);
      setError(tradingError.message);
      reportError('position', tradingError);
    } finally {
      setSubmitting(false);
    }
  }, [
    submitting,
    stopLoss,
    takeProfit,
    position,
    services,
    pushMessage,
    onClose,
    validation.canSubmit,
  ]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="modify-brackets-title"
        onClick={(event) => event.stopPropagation()}
        className="w-full max-w-xs rounded-lg border border-[var(--border-strong)] bg-[var(--surface-overlay)] p-4 shadow-[var(--shadow-panel)]"
      >
        <h2 id="modify-brackets-title" className="flex items-center gap-1.5 text-sm font-semibold">
          Modify <SymbolLogo symbol={position.displaySymbol} size={15} /> {position.displaySymbol}
        </h2>
        <p className="mt-0.5 text-2xs text-text-muted">
          {position.side === 'buy' ? 'Buy' : 'Sell'} {position.volume} lots at {position.openPrice}
        </p>

        <div className="mt-3 space-y-2">
          <Field
            label="Stop loss"
            htmlFor="modify-sl"
            error={stopLossIssue?.severity === 'error' ? stopLossIssue.message : null}
            hint="Leave empty to remove the stop-loss."
          >
            <Input
              ref={firstFieldRef}
              id="modify-sl"
              inputMode="decimal"
              value={stopLoss}
              onChange={(event) => setStopLoss(event.target.value)}
              placeholder="None"
            />
          </Field>
          <Field
            label="Take profit"
            htmlFor="modify-tp"
            error={takeProfitIssue?.severity === 'error' ? takeProfitIssue.message : null}
            hint="Leave empty to remove the take-profit."
          >
            <Input
              id="modify-tp"
              inputMode="decimal"
              value={takeProfit}
              onChange={(event) => setTakeProfit(event.target.value)}
              placeholder="None"
            />
          </Field>

          {/* Computed from the position's OPEN price, so a position opened at
              the ticket's entry shows exactly what the ticket's Order info
              showed. */}
          <OrderInfoBlock
            title="Position info"
            symbol={symbol}
            volumeLots={position.volume}
            price={position.openPrice}
          />
        </div>

        {priceIssue && <p className="mt-2 text-2xs text-text-muted">{priceIssue.message}</p>}

        {error && (
          <p role="alert" className="mt-2 text-2xs text-[var(--negative)]">
            {error}
          </p>
        )}

        <div className="mt-4 flex gap-2">
          <Button variant="secondary" size="md" onClick={onClose} className="flex-1">
            Cancel
          </Button>
          <Button
            variant="primary"
            size="md"
            loading={submitting}
            disabled={!validation.canSubmit}
            title={blockingMessage ?? undefined}
            aria-label={blockingMessage ? `Save — ${blockingMessage}` : undefined}
            onClick={() => void submit()}
            className="flex-1"
          >
            Save
          </Button>
        </div>
      </div>
    </div>
  );
}
