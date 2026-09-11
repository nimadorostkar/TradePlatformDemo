import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Clock, Lock, Zap } from 'lucide-react';
import { cn } from '@/components/ui/cn';
import { Badge, Button, Field, Input } from '@/components/ui/primitives';
import { env } from '@/app/config/env';
import { reportError, useServices } from '@/app/providers/services';
import { dec, toDecimalString, type DecimalString } from '@/domain/common/decimal';
import { isInsufficientFunds, TradingError } from '@/domain/common/errors';
import type { OrderKind, Side, TradeSubmissionResult, TradingSymbol } from '@/domain/common/models';
import { issueFor, validateOrder } from '@/domain/orders/validation';
import { computeOrderInfo } from '@/domain/orders/order-info';
import { bracketToPrice } from '@/domain/orders/risk';
import { useOrderDraft } from '@/stores/order-draft-store';
import { BracketInput } from './BracketInput';
import { LeverageField } from './LeverageField';
import { useMarketState } from './useMarketState';
import { useQuoteToAccountRate } from './useQuoteToAccountRate';
import { volumePresets } from './volume-presets';
import { useQuoteWithStaleness } from '@/stores/quote-store';
import { formatQuoteAge } from '@/domain/market/quote-staleness';
import { useSessionStore } from '@/stores/session-store';
import { useTradingStore } from '@/stores/trading-store';
import { useSystemMessages } from '@/stores/system-messages-store';
import { useWorkspace } from '@/workspace/layout/workspace-store';
import { useSymbolSubscription } from '@/features/watchlist/useSymbolSubscription';
import { ConfirmTradeDialog } from './ConfirmTradeDialog';
import { OrderInfoBlock } from './OrderInfoBlock';
import { useSymbolMetadata } from './useSymbolMetadata';
import { SymbolLogo } from '@/features/watchlist/SymbolLogo';

/**
 * Order ticket.
 *
 * Safety rules implemented here, all of them deliberate:
 *   - submit is disabled while a mutation is in flight (no double-send)
 *   - a trade is NEVER auto-retried
 *   - a timeout resolves to "unknown — reconciling", not to failure
 *   - `Filled` is never displayed; the authoritative position/order state says so
 *   - one-click trading requires an explicit opt-in and shows a persistent
 *     armed indicator while it is on
 */

const ORDER_KINDS: readonly { value: OrderKind; label: string }[] = [
  { value: 'market', label: 'Market' },
  { value: 'limit', label: 'Limit' },
  { value: 'stop', label: 'Stop' },
];

export default function OrderTicketWidget() {
  const services = useServices();
  const config = env();

  const displaySymbol = useWorkspace((s) => s.workspace.activeSymbol);
  const oneClickTrading = useWorkspace((s) => s.workspace.oneClickTrading);
  const confirmTrades = useWorkspace((s) => s.workspace.confirmTrades);
  const setOneClickTrading = useWorkspace((s) => s.setOneClickTrading);

  const readOnly = useSessionStore((s) => s.readOnly);
  const activeLogin = useSessionStore((s) => s.activeLogin);
  const suffixPolicy = useSessionStore((s) => s.suffixPolicy);
  const pushMessage = useSystemMessages((s) => s.push);

  const { symbol, loading: symbolLoading } = useSymbolMetadata(displaySymbol);

  // Keep the ticket's own symbol subscribed even if it is not in the watchlist.
  const subscribed = useMemo(() => [displaySymbol], [displaySymbol]);
  useSymbolSubscription(subscribed);
  const {
    quote,
    stale: quoteStale,
    ageMs: quoteAge,
  } = useQuoteWithStaleness(suffixPolicy.toGateway(displaySymbol));

  // The draft lives in a store so the risk calculator can populate it.
  const kind = useOrderDraft((s) => s.kind);
  const volume = useOrderDraft((s) => s.volume);
  const price = useOrderDraft((s) => s.price);
  const stopLoss = useOrderDraft((s) => s.stopLoss);
  const stopLossUnit = useOrderDraft((s) => s.stopLossUnit);
  const takeProfit = useOrderDraft((s) => s.takeProfit);
  const takeProfitUnit = useOrderDraft((s) => s.takeProfitUnit);
  const appliedFrom = useOrderDraft((s) => s.appliedFrom);
  // The side another widget INTENDED, when it had an opinion — the ladder says
  // "Buy Limit", not just "a limit at this price". It is a hint, never a
  // decision: the ticket keeps both buttons, because choosing the direction of
  // a trade is the one thing that must stay an explicit act.
  const preferredSide = useOrderDraft((s) => s.side);
  const setDraft = useOrderDraft((s) => s.set);
  const resetDraftForSymbol = useOrderDraft((s) => s.resetForSymbol);
  const adoptSymbol = useOrderDraft((s) => s.adoptSymbol);
  const acknowledgeApplied = useOrderDraft((s) => s.acknowledgeApplied);

  const setKind = useCallback((next: OrderKind) => setDraft({ kind: next }), [setDraft]);
  const setVolume = useCallback((next: string) => setDraft({ volume: next }), [setDraft]);
  const setPrice = useCallback((next: string) => setDraft({ price: next }), [setDraft]);

  const [pending, setPending] = useState<{ side: Side } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<TradeSubmissionResult | null>(null);
  const [error, setError] = useState<TradingError | null>(null);
  // STATE-001: the acceptance banner is correlated with the authoritative
  // stores instead of being a write-once string. `awaiting` becomes
  // `confirmed` when the accepted id (or a new position for this symbol)
  // shows up, and `overdue` when nothing has after CONFIRM_OVERDUE_MS —
  // the production test saw "Awaiting confirmation" still on screen after
  // the position had opened AND closed.
  const [confirmation, setConfirmation] = useState<ConfirmationState>('awaiting');
  const acceptedRef = useRef<{ orderId: string; knownPositionIds: ReadonlySet<string> } | null>(
    null,
  );
  const positionsById = useTradingStore((s) => s.positionsById);
  const ordersById = useTradingStore((s) => s.ordersById);

  const abortRef = useRef<AbortController | null>(null);

  // Clear per-symbol inputs when the symbol changes; carrying a EURUSD stop
  // price onto XAUUSD would be actively dangerous. The previous symbol's
  // submission status goes with them: a pending banner shown against another
  // symbol reads as this one's.
  //
  // A CHANGE is required, not merely a run of this effect. It used to clear on
  // every mount, which made a remount indistinguishable from switching
  // instrument: while the chart was recovering from a wedge and remounting the
  // dock with it, a half-typed stop ticket silently lost its entry, its stop
  // and its target mid-keystroke (2026-08-20 retest, BUG-D). The draft lives in
  // a store precisely so it survives a remount, and nothing but the trader
  // moving to another instrument may throw it away.
  const previousSymbolRef = useRef<string | null>(null);
  useEffect(() => {
    const leaving = previousSymbolRef.current;
    previousSymbolRef.current = displaySymbol;
    if (leaving === null || leaving === displaySymbol) {
      // A mount, not a move. The draft is adopted rather than reset, which
      // keeps a restored ticket only when it belongs to the instrument on
      // screen and clears it when it does not.
      adoptSymbol(displaySymbol);
      return;
    }

    // The symbol being LEFT is what the current volume belongs to; the one
    // being entered is what to restore.
    resetDraftForSymbol(leaving, displaySymbol);
    setResult(null);
    setError(null);
    acceptedRef.current = null;
    setConfirmation('awaiting');
  }, [displaySymbol, resetDraftForSymbol, adoptSymbol]);

  useEffect(() => () => abortRef.current?.abort(), []);

  // Flip `awaiting` → `confirmed` when the accepted operation becomes visible:
  // its id appears in Positions/Orders (MT5 position ids equal the opening
  // order ticket), or a position id we had never seen arrives for a market
  // order. The confirmed banner then expires on its own — completed statuses
  // do not linger; System Messages keeps the durable record.
  useEffect(() => {
    if (result?.state !== 'accepted' || confirmation !== 'awaiting') return;
    const accepted = acceptedRef.current;
    if (!accepted) return;

    const idVisible =
      accepted.orderId !== '' &&
      (positionsById.has(accepted.orderId) || ordersById.has(accepted.orderId));
    const newPosition = [...positionsById.keys()].some((id) => !accepted.knownPositionIds.has(id));
    if (idVisible || newPosition) setConfirmation('confirmed');
  }, [result, confirmation, positionsById, ordersById]);

  // Expire a confirmed banner; escalate a silent one to `overdue`.
  useEffect(() => {
    if (result?.state !== 'accepted') return;
    if (confirmation === 'confirmed') {
      const timer = setTimeout(() => {
        setResult(null);
        setConfirmation('awaiting');
        acceptedRef.current = null;
      }, CONFIRMED_BANNER_MS);
      return () => clearTimeout(timer);
    }
    if (confirmation === 'awaiting') {
      const timer = setTimeout(() => setConfirmation('overdue'), CONFIRM_OVERDUE_MS);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [result, confirmation]);

  const { state: market, reopensIn } = useMarketState(symbol);
  const presets = useMemo(() => volumePresets(symbol), [symbol]);

  /**
   * The entry a bracket is measured from. For a market order that is the live
   * side price; for a pending order it is the entry the trader typed.
   */
  const entryFor = useCallback(
    (side: Side): DecimalString | null => {
      if (kind !== 'market') return toDecimalString(price);
      if (!quote) return null;
      return side === 'buy' ? quote.ask : quote.bid;
    },
    [kind, price, quote],
  );

  /** Converts a bracket field into the absolute price the server receives. */
  const resolveBracket = useCallback(
    (side: Side, which: 'stopLoss' | 'takeProfit') => {
      const entry = entryFor(side);
      const raw = which === 'stopLoss' ? stopLoss : takeProfit;
      const unit = which === 'stopLoss' ? stopLossUnit : takeProfitUnit;

      if (!symbol || entry === null) {
        return { price: null, unavailable: raw.trim() === '' ? null : 'Waiting for a price…' };
      }
      return bracketToPrice({
        unit,
        value: raw,
        entryPrice: entry,
        symbol,
        side,
        kind: which,
        volumeLots: toDecimalString(volume),
      });
    },
    [entryFor, stopLoss, stopLossUnit, takeProfit, takeProfitUnit, symbol, volume],
  );

  const buyStop = useMemo(() => resolveBracket('buy', 'stopLoss'), [resolveBracket]);
  const buyTarget = useMemo(() => resolveBracket('buy', 'takeProfit'), [resolveBracket]);
  const sellStop = useMemo(() => resolveBracket('sell', 'stopLoss'), [resolveBracket]);
  const sellTarget = useMemo(() => resolveBracket('sell', 'takeProfit'), [resolveBracket]);

  const draft = useMemo(
    () => ({
      kind,
      side: 'buy' as Side,
      volume,
      price,
      // Validation always works on resolved PRICES, whatever unit was typed.
      stopLoss: buyStop.price ?? '',
      takeProfit: buyTarget.price ?? '',
    }),
    [kind, volume, price, buyStop.price, buyTarget.price],
  );

  const marketClosed = market === 'closed';

  // MED-05: the entry-price error is suppressed until the trader has actually
  // visited the field. Switching order kind resets the slate — a fresh Limit
  // ticket must open calm, not red.
  const [priceTouched, setPriceTouched] = useState(false);
  useEffect(() => {
    setPriceTouched(false);
  }, [kind]);

  const validationBuy = useMemo(
    () => validateOrder({ ...draft, side: 'buy' }, { symbol, quote, readOnly, marketClosed }),
    [draft, symbol, quote, readOnly, marketClosed],
  );
  const validationSell = useMemo(
    () =>
      validateOrder(
        {
          ...draft,
          side: 'sell',
          stopLoss: sellStop.price ?? '',
          takeProfit: sellTarget.price ?? '',
        },
        { symbol, quote, readOnly, marketClosed },
      ),
    [draft, sellStop.price, sellTarget.price, symbol, quote, readOnly, marketClosed],
  );

  const account = useTradingStore((s) => s.account);
  const accountRate = useQuoteToAccountRate(
    symbol?.currencyCode ?? null,
    account?.currency ?? null,
  );

  // The same estimate the Order info block renders (computeOrderInfo on the
  // BUY entry), so the disabled button and the red margin line can never
  // disagree. Margin was the one blocking state that never reached the
  // buttons: the block said "it would be rejected" while BUY and SELL stayed
  // live, and one click sent the guaranteed rejection (HGH-06).
  const insufficientMargin = useMemo(() => {
    const volumeLots =
      issueFor(validationBuy, 'volume')?.severity === 'error' ? null : toDecimalString(volume);
    const info = computeOrderInfo({
      symbol,
      volumeLots,
      price: entryFor('buy'),
      quoteToAccountRate: accountRate,
      leverage: account?.leverage ?? null,
      marginFree: account?.marginFree ?? null,
    });
    return (
      info.marginUsed !== null &&
      info.marginAvailable !== null &&
      dec(info.marginUsed).greaterThan(dec(info.marginAvailable))
    );
  }, [
    validationBuy,
    volume,
    symbol,
    entryFor,
    accountRate,
    account?.leverage,
    account?.marginFree,
  ]);

  const submit = useCallback(
    async (side: Side) => {
      if (submitting) return;

      const validation = side === 'buy' ? validationBuy : validationSell;
      if (!validation.canSubmit || insufficientMargin) return;

      const volumeLots = toDecimalString(volume);
      if (volumeLots === null || !quote) return;

      const entryPrice: DecimalString | null =
        kind === 'market' ? (side === 'buy' ? quote.ask : quote.bid) : toDecimalString(price);
      if (entryPrice === null) return;

      // Brackets are submitted as absolute prices regardless of the unit typed.
      const resolvedStop = side === 'buy' ? buyStop.price : sellStop.price;
      const resolvedTarget = side === 'buy' ? buyTarget.price : sellTarget.price;

      setSubmitting(true);
      setError(null);
      setResult(null);
      setConfirmation('awaiting');
      // Snapshot the ids we already know so a NEW position is recognisable —
      // that, or the echoed order id itself, is what confirms the fill.
      acceptedRef.current = {
        orderId: '',
        knownPositionIds: new Set(useTradingStore.getState().positionsById.keys()),
      };

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const submission =
          kind === 'market'
            ? await services.tradingService.openPosition(
                {
                  displaySymbol,
                  side,
                  volumeLots,
                  price: entryPrice,
                  stopLoss: resolvedStop,
                  takeProfit: resolvedTarget,
                },
                controller.signal,
              )
            : await services.tradingService.placePendingOrder(
                {
                  displaySymbol,
                  side,
                  kind: kind as Exclude<OrderKind, 'market'>,
                  volumeLots,
                  price: entryPrice,
                  stopLoss: resolvedStop,
                  takeProfit: resolvedTarget,
                },
                controller.signal,
              );

        if (acceptedRef.current) {
          acceptedRef.current = { ...acceptedRef.current, orderId: submission.orderId ?? '' };
        }
        setResult(submission);
        pushMessage({
          level: submission.state === 'unknown' ? 'warning' : 'success',
          scope: 'order',
          text:
            submission.state === 'unknown'
              ? `${side.toUpperCase()} ${volume} ${displaySymbol}: outcome unknown, reconciling.`
              : `${side.toUpperCase()} ${volume} ${displaySymbol} accepted by the trading server.`,
          code: submission.retcode ? `mt5.${submission.retcode}` : 'order.accepted',
          requestId: submission.requestId,
        });
      } catch (caught) {
        const tradingError = TradingError.from(caught);
        setError(tradingError);
        reportError('order', tradingError);
      } finally {
        setSubmitting(false);
        setPending(null);
      }
    },
    [
      submitting,
      validationBuy,
      validationSell,
      insufficientMargin,
      volume,
      quote,
      kind,
      price,
      buyStop.price,
      buyTarget.price,
      sellStop.price,
      sellTarget.price,
      services,
      displaySymbol,
      pushMessage,
    ],
  );

  const requestSubmit = useCallback(
    (side: Side) => {
      // Validation is checked BEFORE the confirmation dialog. Showing a
      // confirm screen for an order that cannot be submitted would ask the
      // trader to approve something that then silently does nothing.
      const validation = side === 'buy' ? validationBuy : validationSell;
      if (!validation.canSubmit || insufficientMargin) return;

      // One-click bypasses confirmation only when the trader has explicitly
      // armed it AND the environment permits it.
      // Runtime policy can REQUIRE confirmation. A stale/migrated workspace
      // preference must never weaken that policy; it may only opt into extra
      // confirmation when the environment does not require it. The sole
      // bypass is the explicit one-click toggle AND deployment permission.
      const needsConfirmation =
        (config.confirmTrades || confirmTrades) &&
        !(oneClickTrading && config.enableOneClickTrading);
      if (needsConfirmation) setPending({ side });
      else void submit(side);
    },
    [
      validationBuy,
      validationSell,
      insufficientMargin,
      confirmTrades,
      config.confirmTrades,
      config.enableOneClickTrading,
      oneClickTrading,
      submit,
    ],
  );

  const digits = symbol?.digits ?? 5;

  if (!activeLogin) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-center text-xs text-text-muted">
        Select a trading account to place orders.
      </div>
    );
  }

  return (
    <div className="widget-scroll flex h-full min-h-0 flex-col">
      <div className="space-y-2 p-2">
        <SymbolHeader symbol={symbol} displaySymbol={displaySymbol} loading={symbolLoading} />

        {/* Account-level, so it sits above the per-order fields rather than
            among them — and renders nothing where the broker does not offer
            it. */}
        <LeverageField />

        {readOnly && (
          <div className="flex items-center gap-1.5 rounded border border-[var(--warning)] bg-warning/10 p-1.5 text-2xs text-[var(--warning)]">
            <Lock className="h-3 w-3 shrink-0" aria-hidden />
            This account is read-only. Trading is disabled.
          </div>
        )}

        {market === 'closed' && (
          <div
            role="status"
            className="flex items-center gap-1.5 rounded border border-[var(--warning)] bg-warning/10 p-1.5 text-2xs text-[var(--warning)]"
          >
            <Clock className="h-3 w-3 shrink-0" aria-hidden />
            Market closed{reopensIn ? ` — reopens in ${reopensIn}` : ''}.
          </div>
        )}

        {/*
          Only when the session calendar says the market is OPEN. If it already
          says closed, that banner explains the silence and this one would just
          be a second way of saying the same thing. An open session with no
          recent quotes is the case worth surfacing — a holiday the calendar
          does not know about, or a stalled feed.
        */}
        {quoteStale && market !== 'closed' && quoteAge !== null && (
          <div
            role="status"
            className="flex items-center gap-1.5 rounded border border-[var(--warning)] bg-warning/10 p-1.5 text-2xs text-[var(--warning)]"
          >
            <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden />
            No recent quotes — last price is {formatQuoteAge(quoteAge)} old.
          </div>
        )}

        {appliedFrom && (
          <div
            role="status"
            className="flex items-center justify-between gap-2 rounded border border-[var(--brand-primary)] bg-brand-primary/10 p-1.5 text-2xs text-text-secondary"
          >
            <span>Values applied from {appliedFrom}.</span>
            <button
              onClick={acknowledgeApplied}
              className="text-text-muted underline hover:text-text-primary"
            >
              Dismiss
            </button>
          </div>
        )}

        <PriceButtons
          displaySymbol={displaySymbol}
          digits={digits}
          preferredSide={appliedFrom ? preferredSide : null}
          buyDisabled={
            readOnly || submitting || !quote || insufficientMargin || !validationBuy.canSubmit
          }
          sellDisabled={
            readOnly || submitting || !quote || insufficientMargin || !validationSell.canSubmit
          }
          buyBlockedBecause={blockReason(validationBuy, readOnly, quote, insufficientMargin)}
          sellBlockedBecause={blockReason(validationSell, readOnly, quote, insufficientMargin)}
          submitting={submitting}
          onBuy={() => requestSubmit('buy')}
          onSell={() => requestSubmit('sell')}
        />

        <div className="flex gap-1" role="group" aria-label="Order type">
          {ORDER_KINDS.map((option) => (
            <button
              key={option.value}
              aria-pressed={kind === option.value}
              onClick={() => setKind(option.value)}
              className={cn(
                'flex-1 rounded border px-1.5 py-1 text-2xs transition-colors',
                kind === option.value
                  ? 'border-[var(--brand-primary)] bg-brand-primary/12 text-text-primary'
                  : 'border-[var(--border-default)] text-text-muted hover:text-text-secondary',
              )}
            >
              {option.label}
            </button>
          ))}
        </div>

        <Field
          label="Volume (lots)"
          htmlFor="order-volume"
          error={
            issueFor(validationBuy, 'volume')?.severity === 'error'
              ? issueFor(validationBuy, 'volume')?.message
              : null
          }
          hint={
            symbol?.volumeStep
              ? `Step ${symbol.volumeStep}${symbol.volumeMin ? `, min ${symbol.volumeMin}` : ''}`
              : 'Volume limits unavailable — the server will validate.'
          }
        >
          <div className="flex gap-1">
            <Input
              id="order-volume"
              inputMode="decimal"
              value={volume}
              onChange={(event) => setVolume(event.target.value)}
              // Same reason as the bracket fields: a size is replaced far more
              // often than it is edited a digit at a time, and typing over a
              // value the caret happens to sit beside produced "0.100.01" and
              // "Enter a valid volume." (2026-08-21 QA). Selecting on focus
              // means the next keystroke always replaces.
              onFocus={(event) => event.currentTarget.select()}
              className="flex-1"
            />
            {presets.map((preset) => (
              <button
                key={preset}
                // Explicitly not a submit button. A bare <button> defaults to
                // type="submit", so one inside any ancestor form submits it
                // instead of setting the size — which is what "the chips do not
                // reliably set the value" looks like from outside.
                type="button"
                onClick={() => setVolume(preset)}
                className="min-w-6 rounded border border-[var(--border-default)] px-1.5 text-2xs text-text-muted hover:text-text-primary"
              >
                {preset}
              </button>
            ))}
          </div>
        </Field>

        {kind !== 'market' && (
          <Field
            label="Entry price"
            htmlFor="order-price"
            // Shown only when the price is unusable in BOTH directions. A
            // stop below the market is a valid SELL and an invalid BUY, and
            // rendering the buy branch's message here told a trader
            // configuring a sell stop that "a buy stop must be above the
            // current price". Per-side reasons live on the buttons.
            error={
              priceTouched && issueFor(validationBuy, 'price') && issueFor(validationSell, 'price')
                ? issueFor(validationBuy, 'price')?.message
                : null
            }
          >
            <Input
              id="order-price"
              inputMode="decimal"
              value={price}
              onChange={(event) => setPrice(event.target.value)}
              // Validate on blur, not on render: "Enter an entry price" in red
              // before the trader has touched the field trains them to ignore
              // red text — the colour later used for genuine errors (MED-05).
              onBlur={() => setPriceTouched(true)}
              placeholder={quote ? Number(quote.ask).toFixed(digits) : ''}
            />
          </Field>
        )}

        <div className="grid grid-cols-2 gap-2">
          <BracketInput
            id="order-sl"
            label="Stop loss"
            value={stopLoss}
            unit={stopLossUnit}
            onValueChange={(next) => setDraft({ stopLoss: next })}
            onUnitChange={(next) => setDraft({ stopLossUnit: next })}
            resolvedPrice={buyStop.price}
            unavailable={buyStop.unavailable}
            error={issueFor(validationBuy, 'stopLoss')?.message}
            digits={digits}
          />
          <BracketInput
            id="order-tp"
            label="Take profit"
            value={takeProfit}
            unit={takeProfitUnit}
            onValueChange={(next) => setDraft({ takeProfit: next })}
            onUnitChange={(next) => setDraft({ takeProfitUnit: next })}
            resolvedPrice={buyTarget.price}
            unavailable={buyTarget.unavailable}
            error={issueFor(validationBuy, 'takeProfit')?.message}
            digits={digits}
          />
        </div>

        {/* The reference price is the BUY entry — the live ask for a market
            order, the typed entry for a pending one — matching the draft the
            rest of the ticket validates against. The bid differs from it by
            the spread, which is noise at this block's precision. */}
        <OrderInfoBlock
          title="Order info"
          symbol={symbol}
          volumeLots={volume}
          // While the volume itself is invalid, the block must show "—", not
          // figures computed from a size the server would refuse (HGH-06).
          volumeInvalid={issueFor(validationBuy, 'volume')?.severity === 'error'}
          price={entryFor('buy')}
        />

        {config.enableOneClickTrading && (
          <label className="flex items-center gap-1.5 text-2xs text-text-secondary">
            <input
              type="checkbox"
              checked={oneClickTrading}
              onChange={(event) => setOneClickTrading(event.target.checked)}
            />
            <Zap className="h-3 w-3" aria-hidden />
            One-click trading
            {oneClickTrading && (
              <Badge tone="warning" className="ml-auto">
                Armed
              </Badge>
            )}
          </label>
        )}

        <SubmissionStatus result={result} error={error} confirmation={confirmation} kind={kind} />
      </div>

      {pending && (
        <ConfirmTradeDialog
          side={pending.side}
          kind={kind}
          symbol={displaySymbol}
          volume={volume}
          price={
            kind === 'market'
              ? quote
                ? Number(pending.side === 'buy' ? quote.ask : quote.bid).toFixed(digits)
                : '—'
              : price
          }
          stopLoss={stopLoss || null}
          takeProfit={takeProfit || null}
          onConfirm={() => void submit(pending.side)}
          onCancel={() => setPending(null)}
        />
      )}
    </div>
  );
}

function SymbolHeader({
  symbol,
  displaySymbol,
  loading,
}: {
  symbol: TradingSymbol | undefined;
  displaySymbol: string;
  loading: boolean;
}) {
  return (
    <div className="space-y-0.5">
      <div className="flex items-center gap-2">
        <SymbolLogo symbol={displaySymbol} size={18} />
        <span className="text-sm font-semibold">{displaySymbol}</span>
        {symbol?.type ? <Badge>{symbol.type}</Badge> : null}
      </div>
      <p className="truncate text-2xs text-text-muted">
        {loading ? 'Loading symbol…' : (symbol?.description ?? 'Symbol details unavailable')}
      </p>
    </div>
  );
}

/**
 * Why a side cannot be submitted, in the trader's words — or null when it can.
 *
 * The ticket used to disable a BUY/SELL button on `canSubmit` alone and show
 * nothing, so a bracket left over from the opposite side (a stop-loss below
 * entry is right for a buy and wrong for a sell) locked out that side on every
 * order type, market included, with no way to find out why short of a reload.
 */
function blockReason(
  validation: ReturnType<typeof validateOrder>,
  readOnly: boolean,
  quote: unknown,
  insufficientMargin: boolean,
): string | null {
  if (readOnly) return 'This account is read-only and cannot place trades.';
  if (!quote) return 'No live price is available for this symbol yet.';
  // Same sentence as the Order info block's red line, so the button and the
  // warning describe one fact in one voice.
  if (insufficientMargin) return 'Not enough free margin for this order — it would be rejected.';
  const blocking = validation.issues.find((issue) => issue.severity === 'error');
  return blocking?.message ?? null;
}

function PriceButtons({
  displaySymbol,
  digits,
  preferredSide,
  buyDisabled,
  sellDisabled,
  buyBlockedBecause,
  sellBlockedBecause,
  submitting,
  onBuy,
  onSell,
}: {
  displaySymbol: string;
  digits: number;
  /** Highlighted, not preselected — see the ticket's note on `preferredSide`. */
  preferredSide: Side | null;
  buyDisabled: boolean;
  sellDisabled: boolean;
  buyBlockedBecause: string | null;
  sellBlockedBecause: string | null;
  submitting: boolean;
  onBuy: () => void;
  onSell: () => void;
}) {
  const suffixPolicy = useSessionStore((s) => s.suffixPolicy);
  const { quote, stale, ageMs } = useQuoteWithStaleness(suffixPolicy.toGateway(displaySymbol));

  // Dimmed, never hidden and never disabled. Staleness is a labelling problem:
  // the broker still decides whether a fill is possible, and blocking the
  // button here would stop a trader acting on a market we merely think is quiet.
  const staleTitle =
    stale && ageMs !== null
      ? `Last broker quote ${formatQuoteAge(ageMs)} ago — this is not a live price`
      : undefined;

  return (
    <div className="grid grid-cols-2 gap-1">
      <Button
        variant="sell"
        size="lg"
        disabled={sellDisabled}
        loading={submitting}
        onClick={onSell}
        // A ring, not a preselection: the intent is shown so a trader can see
        // the ladder meant SELL, while the act of choosing stays theirs.
        className={cn(
          'flex-col gap-0 py-1',
          preferredSide === 'sell' && 'ring-2 ring-[var(--focus-ring)]',
        )}
        // A disabled trading button with no stated reason is indistinguishable
        // from a broken one. The two sides are validated independently — the
        // same price can be a valid sell and an invalid buy — so each carries
        // its own.
        title={(sellDisabled ? sellBlockedBecause : null) ?? staleTitle}
        aria-label={sellDisabled && sellBlockedBecause ? `Sell — ${sellBlockedBecause}` : undefined}
      >
        <span className="text-2xs font-normal opacity-90">SELL</span>
        <span className={cn('tabular text-base font-semibold', stale && 'opacity-50')}>
          {quote ? Number(quote.bid).toFixed(digits) : '—'}
        </span>
      </Button>
      <Button
        variant="buy"
        size="lg"
        disabled={buyDisabled}
        loading={submitting}
        onClick={onBuy}
        className={cn(
          'flex-col gap-0 py-1',
          preferredSide === 'buy' && 'ring-2 ring-[var(--focus-ring)]',
        )}
        title={(buyDisabled ? buyBlockedBecause : null) ?? staleTitle}
        aria-label={buyDisabled && buyBlockedBecause ? `Buy — ${buyBlockedBecause}` : undefined}
      >
        <span className="text-2xs font-normal opacity-90">BUY</span>
        <span className={cn('tabular text-base font-semibold', stale && 'opacity-50')}>
          {quote ? Number(quote.ask).toFixed(digits) : '—'}
        </span>
      </Button>
    </div>
  );
}

/** Lifecycle of an accepted submission's banner (STATE-001). */
type ConfirmationState = 'awaiting' | 'confirmed' | 'overdue';

/** How long a confirmed banner stays before clearing itself. */
const CONFIRMED_BANNER_MS = 6_000;

/** How long an acceptance may stay unconfirmed before the banner says so. */
const CONFIRM_OVERDUE_MS = 30_000;

/**
 * Reports the outcome truthfully.
 *
 * `accepted` means the gateway took the request — NOT that it filled. A fill
 * shows up in the positions table when the authoritative snapshot says so;
 * `confirmation` tracks that store, so this banner can never keep promising a
 * confirmation that already happened (or report a five-minute-old acceptance
 * as if it were still in flight).
 */
function SubmissionStatus({
  result,
  kind,
  error,
  confirmation,
}: {
  result: TradeSubmissionResult | null;
  kind: OrderKind;
  error: TradingError | null;
  confirmation: ConfirmationState;
}) {
  if (error) {
    return (
      <div className="flex items-start gap-1.5 rounded border border-[var(--negative)] bg-negative/10 p-1.5 text-2xs text-[var(--negative)]">
        <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
        <div role="alert">
          <p>{error.message}</p>
          {isInsufficientFunds(error) && (
            <p className="mt-0.5 opacity-80">Deposit funds to trade.</p>
          )}
        </div>
      </div>
    );
  }

  // A market order becomes a position. A pending order becomes an ORDER, and
  // only reaches Positions if it fills — telling the trader to look there for
  // a resting limit sends them to an empty table.
  const destination = kind === 'market' ? 'Positions' : 'Orders';

  if (!result) return null;

  if (result.state === 'unknown') {
    return (
      <div
        role="status"
        className="rounded border border-[var(--warning)] bg-warning/10 p-1.5 text-2xs text-[var(--warning)]"
      >
        Outcome unknown — reconciling with the trading server. Check {destination} before retrying.
      </div>
    );
  }

  const id = result.orderId ? ` (#${result.orderId})` : '';

  if (confirmation === 'confirmed') {
    return (
      <div
        role="status"
        className="rounded border border-[var(--positive)] bg-positive/10 p-1.5 text-2xs text-[var(--positive)]"
      >
        Confirmed{id} — now visible in {destination}.
      </div>
    );
  }

  if (confirmation === 'overdue') {
    return (
      <div
        role="status"
        className="rounded border border-[var(--warning)] bg-warning/10 p-1.5 text-2xs text-[var(--warning)]"
      >
        Accepted{id}, but not yet visible in {destination}. Check {destination} and History before
        retrying — do not resubmit blindly.
      </div>
    );
  }

  return (
    <div
      role="status"
      className="rounded border border-[var(--positive)] bg-positive/10 p-1.5 text-2xs text-[var(--positive)]"
    >
      Accepted by the trading server{id}. Awaiting confirmation in Positions.
    </div>
  );
}
