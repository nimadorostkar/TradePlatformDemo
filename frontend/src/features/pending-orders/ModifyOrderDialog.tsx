import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Field, Input } from '@/components/ui/primitives';
import { Modal } from '@/components/ui/Modal';
import { reportError, useServices } from '@/app/providers/services';
import { dec, toDecimalString } from '@/domain/common/decimal';
import { TradingError } from '@/domain/common/errors';
import type { OrderKind, TradingOrder } from '@/domain/common/models';
import { useSystemMessages } from '@/stores/system-messages-store';
import { useResizeConfirm } from '@/stores/resize-confirm-store';
import { volumeIssues } from '@/domain/orders/validation';
import { useToasts } from '@/stores/toast-store';
import { useSymbolMetadata } from '@/features/order-ticket/useSymbolMetadata';
import { useQuote } from '@/stores/quote-store';
import { useSessionStore } from '@/stores/session-store';
import { formatPrice } from '@/domain/market/price-format';

/**
 * Edits a working pending order: entry price and protective levels.
 *
 * An empty stop or target field means "remove that level", sent as MT5's 0.
 * The distinction is spelled out so clearing a field is never accidental.
 *
 * Volume is shown but NOT editable. MT5's modify action can change price, SL,
 * TP and expiry only — a pending order's size cannot change in place, it needs
 * cancel + re-place. This dialog used to accept a new volume anyway: the server
 * applied the rest of the request, silently ignored the volume, and reported
 * success, so a trader could believe their order had doubled when it had not.
 * An input the platform is structurally unable to honour must not look live.
 */
export function ModifyOrderDialog({
  order,
  onClose,
}: {
  order: TradingOrder;
  onClose: () => void;
}) {
  const services = useServices();
  const pushMessage = useSystemMessages((s) => s.push);
  const pushToast = useToasts((s) => s.push);
  const { symbol } = useSymbolMetadata(order.displaySymbol);
  const suffixPolicy = useSessionStore((s) => s.suffixPolicy);
  const quote = useQuote(suffixPolicy.toGateway(order.displaySymbol));

  const [price, setPrice] = useState<string>(order.price ?? '');

  const [stopLoss, setStopLoss] = useState<string>(order.stopLoss ?? '');
  const [takeProfit, setTakeProfit] = useState<string>(order.takeProfit ?? '');
  // Whether each field still holds what the order arrived with. The dialog can
  // open before the instrument's precision is known, and these are editable
  // inputs — so they are restated at full precision when it lands, and never
  // once the trader has touched them.
  const pristine = useRef({ price: true, stopLoss: true, takeProfit: true });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  /**
   * The resize flow, which is a different act from a modify: the order is
   * cancelled and replaced, and comes back with a new ticket. Kept behind an
   * explicit toggle so it can never happen by simply typing in a field.
   */
  const [resizing, setResizing] = useState(false);
  const [newVolume, setNewVolume] = useState<string>(order.volume);
  const askResize = useResizeConfirm((s) => s.ask);

  const resize = useCallback(async () => {
    if (submitting) return;
    const volume = toDecimalString(newVolume);
    if (volume === null || dec(volume).lessThanOrEqualTo(0)) {
      setError('Enter a valid volume.');
      return;
    }
    if (symbol) {
      const blocking = volumeIssues(volume, symbol).find((i) => i.severity === 'error');
      if (blocking) {
        setError(blocking.message);
        return;
      }
    }

    const confirmed = await askResize({
      orderId: order.id,
      displaySymbol: order.displaySymbol,
      from: order.volume,
      to: volume,
    });
    if (!confirmed) return;

    setSubmitting(true);
    setError(null);
    try {
      const result = await services.tradingService.resizePendingOrder(order, volume);
      const unknown = result.placed.state === 'unknown';
      pushToast({
        tone: unknown ? 'warning' : 'success',
        title: unknown ? 'Replacement outcome unknown' : 'Order resized',
        body: unknown
          ? `Order ${order.id} was cancelled; its replacement is reconciling.`
          : `${order.id} replaced by ${result.placed.orderId ?? 'a new order'} at ${volume} lots.`,
      });
      pushMessage({
        level: unknown ? 'warning' : 'success',
        scope: 'order',
        text: unknown
          ? `Resize of order ${order.id}: replacement outcome unknown, reconciling.`
          : `Order ${order.id} resized to ${volume} lots as ${result.placed.orderId ?? 'a new order'}.`,
        code: 'order.resize',
        requestId: result.placed.requestId,
      });
      onClose();
    } catch (caught) {
      const tradingError = TradingError.from(caught);
      setError(tradingError.message);
      // An orphaned resize is the one the trader must not miss: their order is
      // gone and nothing replaced it. A toast as well as the inline message,
      // because this dialog stays open and they may be reading the field.
      if (tradingError.code === 'trade.resize-orphaned') {
        pushToast({
          tone: 'error',
          title: 'Order cancelled, replacement failed',
          body: tradingError.message,
        });
      }
      pushMessage({
        level: 'error',
        scope: 'order',
        text: `Resize of order ${order.id} failed: ${tradingError.message}`,
        code: tradingError.code,
        requestId: tradingError.requestId,
      });
      reportError('order', tradingError);
    } finally {
      setSubmitting(false);
    }
  }, [submitting, newVolume, symbol, order, askResize, services, pushToast, pushMessage, onClose]);

  const submit = useCallback(async () => {
    if (submitting) return;

    const nextPrice = toDecimalString(price);

    if (nextPrice === null || dec(nextPrice).lessThanOrEqualTo(0)) {
      setError('Enter a valid entry price.');
      return;
    }

    const nextStop = stopLoss.trim() === '' ? null : toDecimalString(stopLoss);
    const nextTarget = takeProfit.trim() === '' ? null : toDecimalString(takeProfit);
    if (stopLoss.trim() !== '' && nextStop === null) {
      setError('Enter a valid stop-loss price.');
      return;
    }
    if (takeProfit.trim() !== '' && nextTarget === null) {
      setError('Enter a valid take-profit price.');
      return;
    }

    // A stop on the wrong side of the entry would close the trade the instant
    // the order triggers.
    if (nextStop !== null) {
      const wrongSide =
        order.side === 'buy'
          ? dec(nextStop).greaterThanOrEqualTo(dec(nextPrice))
          : dec(nextStop).lessThanOrEqualTo(dec(nextPrice));
      if (wrongSide) {
        setError(`Stop-loss must be ${order.side === 'buy' ? 'below' : 'above'} the entry price.`);
        return;
      }
    }
    if (nextTarget !== null) {
      const wrongSide =
        order.side === 'buy'
          ? dec(nextTarget).lessThanOrEqualTo(dec(nextPrice))
          : dec(nextTarget).greaterThanOrEqualTo(dec(nextPrice));
      if (wrongSide) {
        setError(
          `Take-profit must be ${order.side === 'buy' ? 'above' : 'below'} the entry price.`,
        );
        return;
      }
    }

    setSubmitting(true);
    setError(null);

    try {
      // Volume is deliberately absent: the service reuses the order's current
      // size, and would refuse a changed one (see modifyOrder's guard).
      const result = await services.tradingService.modifyOrder(order, {
        price: nextPrice,
        stopLoss: nextStop,
        takeProfit: nextTarget,
      });
      const unknown = result.state === 'unknown';
      // The toast is what the trader actually sees; the system-messages entry
      // is the durable log. Logging alone looked like silence: the entry lands
      // in a panel most layouts do not have open.
      pushToast({
        tone: unknown ? 'warning' : 'success',
        title: unknown ? 'Modification outcome unknown' : 'Order modified',
        body: unknown
          ? `Order ${order.id}: reconciling — check Orders before retrying.`
          : `Order ${order.id} updated.`,
      });
      pushMessage({
        level: unknown ? 'warning' : 'success',
        scope: 'order',
        text: unknown
          ? `Modify of order ${order.id}: outcome unknown, reconciling.`
          : `Order ${order.id} updated.`,
        code: 'order.modify',
        requestId: result.requestId,
      });
      onClose();
    } catch (caught) {
      const tradingError = TradingError.from(caught);
      setError(tradingError.message);
      reportError('order', tradingError);
    } finally {
      setSubmitting(false);
    }
  }, [submitting, price, stopLoss, takeProfit, order, services, pushToast, pushMessage, onClose]);

  const digits = symbol?.digits ?? 5;

  useEffect(() => {
    if (symbol === undefined) return;
    if (pristine.current.price) setPrice(formatPrice(order.price, digits) ?? '');
    if (pristine.current.stopLoss) setStopLoss(formatPrice(order.stopLoss, digits) ?? '');
    if (pristine.current.takeProfit) setTakeProfit(formatPrice(order.takeProfit, digits) ?? '');
  }, [symbol, digits, order.price, order.stopLoss, order.takeProfit]);
  const kindLabel: Record<OrderKind, string> = {
    market: 'Market',
    limit: 'Limit',
    stop: 'Stop',
    'stop-limit': 'Stop limit',
  };

  return (
    <Modal
      title={`Modify ${order.displaySymbol}`}
      titleId="modify-order-title"
      onClose={onClose}
      initialFocusRef={cancelRef}
    >
      <p className="mt-0.5 text-2xs text-text-muted">
        {kindLabel[order.kind]} {order.side === 'buy' ? 'buy' : 'sell'} · order {order.id}
        {quote ? ` · market ${Number(quote.bid).toFixed(digits)}` : ''}
      </p>

      <div className="mt-3 space-y-2">
        <Field label="Entry price" htmlFor="modify-price">
          <Input
            id="modify-price"
            inputMode="decimal"
            value={price}
            onChange={(event) => {
              pristine.current.price = false;
              setPrice(event.target.value);
            }}
          />
        </Field>

        {/* Read-only, WITH the way out. This server cannot resize a pending
            order in place, so the size is not editable here — but a field that
            merely refuses, and leaves the trader to work out cancel-and-replace
            for themselves, is the gap QA hit. The action does it for them. */}
        <Field
          label="Volume (lots)"
          htmlFor="modify-volume"
          hint="This server cannot resize an order in place — it is cancelled and replaced, and gets a new ID."
        >
          <div className="flex gap-1">
            <Input
              id="modify-volume"
              inputMode="decimal"
              value={resizing ? newVolume : order.volume}
              onChange={(event) => setNewVolume(event.target.value)}
              onFocus={(event) => event.currentTarget.select()}
              disabled={!resizing}
              readOnly={!resizing}
              aria-disabled={resizing ? undefined : 'true'}
              className="flex-1"
            />
            {resizing ? (
              <Button
                type="button"
                variant="primary"
                size="sm"
                onClick={() => void resize()}
                disabled={submitting}
              >
                Replace
              </Button>
            ) : (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setResizing(true)}
                disabled={submitting || order.status !== 'working'}
              >
                Resize
              </Button>
            )}
          </div>
        </Field>

        <div className="grid grid-cols-2 gap-2">
          <Field label="Stop loss" htmlFor="modify-order-sl" hint="Empty removes it.">
            <Input
              id="modify-order-sl"
              inputMode="decimal"
              value={stopLoss}
              onChange={(event) => {
                pristine.current.stopLoss = false;
                setStopLoss(event.target.value);
              }}
              placeholder="None"
            />
          </Field>
          <Field label="Take profit" htmlFor="modify-order-tp" hint="Empty removes it.">
            <Input
              id="modify-order-tp"
              inputMode="decimal"
              value={takeProfit}
              onChange={(event) => {
                pristine.current.takeProfit = false;
                setTakeProfit(event.target.value);
              }}
              placeholder="None"
            />
          </Field>
        </div>
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
          variant="primary"
          size="md"
          loading={submitting}
          onClick={() => void submit()}
          className="flex-1"
        >
          Save changes
        </Button>
      </div>
    </Modal>
  );
}
