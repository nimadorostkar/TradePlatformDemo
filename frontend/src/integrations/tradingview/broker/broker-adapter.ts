import type { TradingService } from '@/domain/orders/trading-service';
import { overallConnection, useTradingStore } from '@/stores/trading-store';
import { useResizeConfirm } from '@/stores/resize-confirm-store';
import { useSessionStore } from '@/stores/session-store';
import { selectActiveSymbol, useWorkspace } from '@/workspace/layout/workspace-store';
import { quoteStore } from '@/stores/quote-store';
import { dec, roundToDigits, snapPriceToTick, toDecimalString } from '@/domain/common/decimal';
import type { DecimalString } from '@/domain/common/decimal';
import { TradingError } from '@/domain/common/errors';
import type { LeverageState, MarketDepthDto } from '@/integrations/gateway/contracts/schemas';
import type {
  Position as DomainPosition,
  TradeSubmissionResult,
  TradingOrder,
  TradingSymbol,
} from '@/domain/common/models';
import { pipSize } from '@/domain/orders/risk';
import { DEPTH_POLL_BASE_MS, nextDepthPollDelay } from '@/domain/market/depth-poll';
import { tvSideOf, tvTypeOf } from '@/integrations/gateway/mappers/trade-codes';
import { clearDiagnostic, warnOnce } from '../diagnostics';
import type {
  AccountId,
  AccountManagerInfo,
  AccountMetainfo,
  ActionMetaInfo,
  Brackets,
  DefaultContextMenuActionsParams,
  DOMData,
  DOMLevel,
  Execution,
  IBrokerConnectionAdapterHost,
  INumberFormatter,
  InstrumentInfo,
  IWatchedValue,
  Order,
  OrderTableColumn,
  PlaceOrderResult,
  Position,
  PreOrder,
  StandardFormatterName,
  TradeContext,
  LeverageInfo,
  LeveragePreviewResult,
  LeverageSetResult,
} from '../types';
import {
  TV_CONNECTION_STATUS,
  TV_ORDER_STATUS,
  TV_ORDER_TYPE,
  TV_PARENT_TYPE,
  TV_SIDE,
} from '../types';

/**
 * TradingView Broker API adapter.
 *
 * This is a THIN bridge. It translates between the library's models and our
 * domain models and then calls the SAME `TradingService` the custom order
 * ticket uses. It holds no trading state of its own: positions and orders are
 * read from the shared normalised store, so the chart and the bottom dock can
 * never disagree about what is open.
 *
 * Chart trading, order/position lines, drag-to-modify, and bracket editing all
 * arrive through these methods.
 */

export interface BrokerAdapterDeps {
  host: IBrokerConnectionAdapterHost;
  trading: TradingService;
  /**
   * Resolves the full symbol record (cached where possible).
   *
   * Required so `symbolInfo` can report the instrument's REAL contract limits
   * to the chart's order ticket. Inventing them would let the chart accept a
   * volume the trading server rejects — or, worse, accept one it does not.
   */
  resolveSymbol: (displaySymbol: string) => Promise<TradingSymbol | undefined>;
  /**
   * Recent fills, already mapped and keyed by DISPLAY symbol.
   *
   * Absent when the deployment does not serve them, which is what keeps
   * `supportExecutions` and this method in agreement.
   */
  loadExecutions?: () => Promise<Execution[]>;
  /** Lot volume ↔ the library's `qty`. They are the same unit here (lots). */
  onNotification?: (title: string, message: string, isError: boolean) => void;
  /**
   * Account leverage, when the gateway reports the capability. Absent means
   * the broker does not offer trader-adjustable leverage here, and the
   * library's leverage control is not advertised at all.
   */
  leverage?: {
    get: (login: string) => Promise<LeverageState>;
    set: (login: string, leverage: number) => Promise<LeverageState>;
  };
  /**
   * Fetches the classified order book for a GATEWAY symbol.
   *
   * Injected — like every other dependency here — so the adapter never reaches
   * into the global service container. Absent when the gateway does not report
   * the market-depth capability, which keeps `subscribeDOM` inert on
   * deployments that cannot serve it.
   */
  loadMarketDepth?: (gatewaySymbol: string, signal: AbortSignal) => Promise<MarketDepthDto>;
  /**
   * Sanitized diagnostic sink for background DOM polling failures. Routed to
   * the system-messages store by the caller; a background poll must never
   * surface as an unhandled rejection or a console error.
   */
  onDepthError?: (error: unknown) => void;
}

/**
 * How long a fetched execution window is reused.
 *
 * The library re-requests on pan and symbol change; without this, scrolling a
 * chart would issue a request per frame. Short enough that a new fill appears
 * on the chart within seconds.
 */
const EXECUTIONS_CACHE_MS = 15_000;

/**
 * Fallback contract limits, used ONLY when the gateway did not return a symbol
 * record. They mirror the MT5 retail defaults and are deliberately permissive
 * rather than restrictive: the trading server validates authoritatively, so a
 * too-tight guess would block a legitimate trade, while a too-loose one merely
 * surfaces the server's own rejection.
 */
const FALLBACK_QTY = { min: 0.01, max: 100, step: 0.01 } as const;

/** Digits used when the symbol record is unavailable; 5 is the FX norm here. */
const FALLBACK_PRICE_DIGITS = 5;

/** How long a symbol lookup may hold up a FORMATTER answer. Tight: the
 * library wraps the formatter path in its own 10s limit and rejects the whole
 * position render when it fires. */
const SYMBOL_RESOLVE_BUDGET_MS = 3_000;

/** How long symbolInfo may wait before degrading to fallback contract limits.
 * Looser than the formatter budget: the library does not time-limit this call,
 * it CACHES the first answer per symbol — so a fallback served at second 3 of
 * a slow boot pins wrong volume limits on the chart ticket for the whole
 * session ("symbolInfo using fallback contract limits", 2026-08-24 QA
 * Issue 3). Ten seconds matches the library's own patience elsewhere. */
const SYMBOL_INFO_RESOLVE_BUDGET_MS = 10_000;

/** Decimal places of a volume step (0.01 → 2, 1 → 0), capped for float noise. */
function fractionDigitsOf(step: number): number {
  if (!Number.isFinite(step) || step <= 0) return 2;
  const text = String(step);
  const dot = text.indexOf('.');
  return dot === -1 ? 0 : Math.min(text.length - dot - 1, 8);
}

/** What the library seeds a symbol with when it has not been told otherwise. */
const LIBRARY_SEED_QTY = 1;
const SEED_CORRECTION_ATTEMPTS = 4;
const SEED_CORRECTION_INTERVAL_MS = 1_200;

/**
 * The largest step that still lands on every value a broker offers.
 *
 * The library models leverage as a range; brokers publish a list. A step that
 * did not divide every gap would let the dialog land between offered values
 * and produce a number the gateway refuses.
 */
function stepOverChoices(choices: readonly number[]): number {
  if (choices.length < 2) return 1;
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  let step = Math.abs(choices[1]! - choices[0]!);
  for (let i = 2; i < choices.length; i += 1) {
    step = gcd(step, Math.abs(choices[i]! - choices[i - 1]!));
  }
  return step > 0 ? step : 1;
}

/**
 * DOM poll pacing — shared with the custom market-depth ladder, so the built-in
 * DOM and the ladder cannot show books of different ages or double the request
 * rate against the same endpoint. An empty book backs this loop off; see
 * `domain/market/depth-poll.ts`.
 */
const DOM_POLL_MS = DEPTH_POLL_BASE_MS;

/**
 * Depth volume units this adapter can pass to the library.
 *
 * The gateway states `volumeUnit` explicitly and today always says "lots",
 * which IS the library's qty unit here, so lots pass through unconverted. Any
 * other unit has no defined conversion in this codebase — such a book is
 * rejected and reported rather than guessed at, because a guessed scale factor
 * turns every DOM level into a wrong size.
 */
const DOM_PASSTHROUGH_VOLUME_UNITS: ReadonlySet<string> = new Set(['lots']);

/** One live DOM poll loop. One exists per subscribed display symbol. */
interface DomSubscription {
  /** Aborts the in-flight request; replaced on account switch. */
  abort: AbortController;
  timer: ReturnType<typeof setTimeout> | null;
  stopped: boolean;
  /** Unknown-unit reports are per-unit, not per-poll — 1.5s spam is useless. */
  reportedUnits: Set<string>;
  /**
   * Delay before this symbol's next poll. Grows while the book comes back
   * empty and snaps back to the base cadence the moment it has levels.
   */
  delay: number;
}

export class GatewayBrokerAdapter {
  private readonly host: IBrokerConnectionAdapterHost;
  private readonly trading: TradingService;
  private readonly deps: BrokerAdapterDeps;
  private unsubscribeStore: (() => void) | null = null;
  private unsubscribeSession: (() => void) | null = null;
  /** Symbols whose seed has already been corrected this session. */
  private readonly seedCorrected = new Set<string>();
  private disposed = false;
  /** Timers backing removal-push reinforcement; cleared on dispose. */
  private readonly reinforceTimers = new Set<ReturnType<typeof setTimeout>>();

  private executionsCache: { fetchedAt: number; promise: Promise<Execution[]> } | null = null;
  /**
   * The connection status the library was last told about. Initialised to the
   * same value the library's own `connectionStatus()` call returns at
   * construction, so the two views can never start out of step.
   */
  private lastPushedStatus: number;
  private readonly domSubscriptions = new Map<string, DomSubscription>();
  /**
   * Orders currently being submitted, keyed by their full parameter set.
   *
   * The library can deliver the same user action twice (a double-fired
   * callback, an instant-mode double-click); an identical order that is STILL
   * IN FLIGHT joins the first submission instead of creating a second one.
   * This never retries anything — a settled promise leaves the map, and a
   * deliberate repeat order after settlement goes through normally.
   */
  private readonly inFlightOrders = new Map<string, Promise<PlaceOrderResult>>();
  /**
   * Watched values behind the Account Manager summary row, created lazily on
   * the library's first `accountManagerInfo()` call and refreshed on every
   * store tick. Lazy, because the host factory is only needed if the library
   * actually builds the panel.
   */
  private summaryValues: {
    balance: IWatchedValue<number>;
    equity: IWatchedValue<number>;
    profit: IWatchedValue<number>;
    margin: IWatchedValue<number>;
    freeMargin: IWatchedValue<number>;
  } | null = null;

  constructor(deps: BrokerAdapterDeps) {
    this.host = deps.host;
    this.trading = deps.trading;
    this.deps = deps;
    this.lastPushedStatus = this.connectionStatus();
    this.bindStore();
  }

  /**
   * Tells the library about a connection-status change, once per transition.
   * Returns true when a change was pushed. Data pushes are gated on the value
   * the LIBRARY holds, which is exactly what was pushed here.
   */
  private pushConnectionStatus(): boolean {
    const status = this.connectionStatus();
    if (status === this.lastPushedStatus) return false;
    this.lastPushedStatus = status;
    this.host.connectionStatusUpdate(
      status as Parameters<IBrokerConnectionAdapterHost['connectionStatusUpdate']>[0],
    );
    return true;
  }

  /**
   * Pushes store changes into the library. The store is the single source of
   * truth; this adapter only mirrors it outward.
   *
   * Ordering rule: the library must be told about a CONNECTION transition
   * before any data arrives under it. Pushing a position to a broker the
   * library considers disconnected fails an assertion inside the library
   * ("Broker is not connected") — exactly what an account switch used to do,
   * because the new account's snapshot landed while the streams were still
   * reconnecting. So every store tick pushes status first, holds data pushes
   * while not connected, and reconciles everything missed on reconnect.
   */
  private bindStore(): void {
    let previousPositions = useTradingStore.getState().positions;
    let previousOrders = useTradingStore.getState().orders;
    let previousGeneration = useTradingStore.getState().generation;

    this.unsubscribeStore = useTradingStore.subscribe((state) => {
      // Summary numbers are account-scalars, not per-object streams: they
      // carry no ordering hazard, so they refresh on every tick regardless of
      // the connection gating below.
      this.refreshSummaryValues();

      const becameConnected =
        this.pushConnectionStatus() && this.lastPushedStatus === TV_CONNECTION_STATUS.Connected;

      if (state.generation !== previousGeneration) {
        previousGeneration = state.generation;
        // The session generation advances exactly when the account-scoped
        // state was reset for a different account. The library drops and
        // re-requests all displayed account data on currentAccountUpdate, so
        // no diff against the PREVIOUS account's snapshot may be pushed —
        // baselines jump to the freshly reset store instead.
        previousPositions = state.positions;
        previousOrders = state.orders;
        this.executionsCache = null;
        this.host.currentAccountUpdate();
        return;
      }

      if (this.lastPushedStatus !== TV_CONNECTION_STATUS.Connected) {
        // Not connected: hold every data push. Baselines deliberately stay at
        // the last state the library SAW, so the reconnect reconciliation
        // below can replay exactly what was missed — including closes.
        //
        // A held push is invisible on the chart — an order that was placed
        // draws no line, a cancelled one leaves its line behind — and both
        // resolve themselves on the next reload or reconnect, which is exactly
        // the shape of a bug testers cannot catch in the act. So say so, with
        // the state that caused it: `overallConnection` takes the WORST of the
        // account, positions and orders streams, so one quiet stream is enough
        // to silence the chart.
        if (state.orders !== previousOrders || state.positions !== previousPositions) {
          warnOnce('chart-push-held', 'chart update held: broker not connected', {
            connection: overallConnection(state),
            libraryStatus: this.lastPushedStatus,
            account: state.accountFreshness.connection,
            positions: state.positionsFreshness.connection,
            orders: state.ordersFreshness.connection,
          });
        }
        return;
      }

      const positionsChanged = state.positions !== previousPositions;
      const ordersChanged = state.orders !== previousOrders;

      if (becameConnected || positionsChanged || ordersChanged) {
        if (becameConnected || positionsChanged) {
          this.diffPositions(previousPositions, state.positions);
          // A changed position set means something filled, so the cached
          // execution window is stale — otherwise the arrow for the trade
          // just placed would not appear for up to the cache lifetime.
          this.executionsCache = null;
        }
        if (becameConnected || ordersChanged) {
          this.diffOrders(previousOrders, state.orders, state.positions);
        }
        // Brackets are diffed ONCE, over the union of both parents. A pending
        // order and the position it becomes share an id, so its legs keep
        // theirs across the fill — diffing the two sets separately made the
        // order's legs "disappear" in the same tick the position's appeared,
        // and the library announced the transfer as a cancellation.
        this.diffBrackets(
          allBrackets(previousPositions, previousOrders),
          allBrackets(state.positions, state.orders),
        );
        previousPositions = state.positions;
        previousOrders = state.orders;
      }

      if (state.account) {
        this.host.equityUpdate(Number(state.account.equity));
      }
    });

    // An account switch (or sign-out) invalidates every in-flight depth
    // request: the response would describe the PREVIOUS account's symbol
    // group. Sign-out stops DOM polling outright; a switch aborts the
    // in-flight request and lets the loop continue, so the next poll reads the
    // new account's suffix at request time.
    this.unsubscribeSession = useSessionStore.subscribe((state, previous) => {
      if (
        state.activeLogin === previous.activeLogin &&
        state.suffixPolicy.suffix === previous.suffixPolicy.suffix
      ) {
        return;
      }
      if (state.activeLogin === null) {
        this.stopAllDomPolling();
        return;
      }
      for (const subscription of this.domSubscriptions.values()) {
        subscription.abort.abort();
        subscription.abort = new AbortController();
      }
    });
  }

  /**
   * Pushes a REMOVAL to the library more than once.
   *
   * The library's object cache carries a one-shot "my own pull is fresher"
   * flag (`_isObjectsRequestActual` in the trading bundle): after it re-pulls
   * positions()/orders(), the next incoming push is silently swallowed to
   * clear the flag. Ordinary updates survive that — every store tick re-pushes
   * the whole current set — but a removal is pushed exactly ONCE, and one
   * swallowed close left the position's line and label on the chart until a
   * full reload (2026-08-24 QA, Issue 1). The reinforcement replays the same
   * idempotent removal after the flag has been consumed; a removal for an id
   * the library no longer holds is a no-op by its own code.
   *
   * `stillGone` re-checks the store at fire time so a position re-opened (or
   * an order re-appearing) under the same id is never clobbered by a stale
   * removal.
   */
  private reinforceRemoval(stillGone: () => boolean, push: () => void): void {
    push();
    for (const delay of [400, 1600]) {
      const timer = setTimeout(() => {
        this.reinforceTimers.delete(timer);
        if (this.disposed || !stillGone()) return;
        push();
      }, delay);
      this.reinforceTimers.add(timer);
    }
  }

  private diffPositions(previous: DomainPosition[], next: DomainPosition[]): void {
    const nextIds = new Set(next.map((p) => p.id));

    for (const position of next) {
      this.host.positionUpdate(toLibraryPosition(position));
    }
    // A position absent from the new snapshot has been closed. The library
    // expects qty 0 to mean closed.
    for (const position of previous) {
      if (!nextIds.has(position.id)) {
        this.reinforceRemoval(
          () => !useTradingStore.getState().positionsById.has(position.id),
          () => this.host.positionUpdate({ ...toLibraryPosition(position), qty: 0 }),
        );
      }
    }
  }

  /**
   * `positions` is what an order that LEFT the working set is judged against.
   * MT5 gives the position the ticket of the order that opened it, so a
   * vanished order whose id is now a position filled — it was not cancelled,
   * and saying so told the trader the opposite of what happened to their money.
   */
  private diffOrders(
    previous: TradingOrder[],
    next: TradingOrder[],
    positions: DomainPosition[],
  ): void {
    const nextIds = new Set(next.map((o) => o.id));
    // Compared as plain strings: OrderId and PositionId are distinct brands,
    // and this is exactly the place where MT5 makes the two the same ticket.
    const positionIds = new Set<string>(positions.map((p) => String(p.id)));

    for (const order of next) {
      this.host.orderUpdate(toLibraryOrder(order));
    }
    for (const order of previous) {
      if (nextIds.has(order.id)) continue;
      const status = (
        positionIds.has(String(order.id)) ? TV_ORDER_STATUS.Filled : TV_ORDER_STATUS.Canceled
      ) as Order['status'];
      this.reinforceRemoval(
        () => !useTradingStore.getState().ordersById.has(order.id),
        () => this.host.orderUpdate({ ...toLibraryOrder(order), status }),
      );
    }
  }

  /**
   * Pushes bracket appearances, price moves and disappearances.
   *
   * A bracket that is gone from the new snapshot was cleared — either the leg
   * itself was nulled or its parent closed. It must be pushed as Canceled
   * rather than merely dropped: the library keeps what it was last told, so an
   * unannounced disappearance leaves a dead SL line on the chart and a stale
   * row in the Account Manager forever. This is also what flips the row's
   * status to Canceled, which is the only visible record that a bracket was
   * removed. Because both legs are diffed independently, cancelling one leaves
   * the sibling's own row untouched.
   */
  private diffBrackets(previous: Order[], next: Order[]): void {
    const nextIds = new Set(next.map((bracket) => bracket.id));

    for (const bracket of next) {
      this.host.orderUpdate(bracket);
    }
    for (const bracket of previous) {
      if (!nextIds.has(bracket.id)) {
        this.reinforceRemoval(
          () => {
            const state = useTradingStore.getState();
            return !allBrackets(state.positions, state.orders).some((b) => b.id === bracket.id);
          },
          () =>
            this.host.orderUpdate({
              ...bracket,
              status: TV_ORDER_STATUS.Canceled as Order['status'],
            }),
        );
      }
    }
  }

  // ── IBrokerTerminal surface ────────────────────────────────────────────────

  connectionStatus(): number {
    const connection = overallConnection(useTradingStore.getState());
    if (connection === 'connected') return TV_CONNECTION_STATUS.Connected;
    if (connection === 'connecting' || connection === 'reconnecting' || connection === 'idle') {
      return TV_CONNECTION_STATUS.Connecting;
    }
    return TV_CONNECTION_STATUS.Error;
  }

  async accountsMetainfo(): Promise<AccountMetainfo[]> {
    const { accounts } = useSessionStore.getState();
    return accounts.map((account) => ({
      id: account.login as AccountId,
      name: account.name,
    }));
  }

  currentAccount(): AccountId {
    return (useSessionStore.getState().activeLogin ?? '') as AccountId;
  }

  async setCurrentAccount(): Promise<void> {
    // Account switching is owned by the application shell, which must also
    // tear down subscriptions and advance the session generation. Letting the
    // chart switch accounts independently would leave the two out of step.
  }

  async isTradable(symbol: string): Promise<boolean> {
    void symbol;
    const readOnly = useSessionStore.getState().readOnly;
    const connection = overallConnection(useTradingStore.getState());
    const tradable = !readOnly && connection === 'connected';

    // The library hides every trading affordance when this is false, with no
    // visible explanation. Report the inputs on the transition so a dead
    // Order Ticket is diagnosable from the console; recovery clears the key
    // so a later degradation reports again.
    if (!tradable) {
      warnOnce('broker-not-tradable', 'TradingView reports non-tradable', {
        readOnly,
        connection,
      });
    } else {
      clearDiagnostic('broker-not-tradable');
    }
    return tradable;
  }

  async symbolInfo(symbol: string): Promise<InstrumentInfo> {
    const resolved = await this.resolveWithBudget(symbol, SYMBOL_INFO_RESOLVE_BUDGET_MS);
    this.correctSeededQuantity(symbol, resolved);

    // The Order Ticket validates volume and price against this answer. When
    // the gateway record is missing, the permissive fallbacks below apply —
    // worth one console line, because a ticket validating against fallback
    // limits looks identical to one validating against real ones.
    if (!resolved) {
      warnOnce(`symbol-info-fallback:${symbol}`, 'symbolInfo using fallback contract limits', {
        symbol,
      });
    }

    // Prefer the instrument's own tick size; otherwise derive the MT5 point
    // (10^-digits), and only then fall back to the host's guess. The library
    // DIVIDES by this value — a zero minTick killed the whole trading surface
    // in production ("[big.js] Division by zero": dead Order Ticket, no chart
    // Trade actions). The mapper already normalises MT5's zero-means-absent
    // TickSize to null; this guard also refuses one arriving any other way.
    const reportedTick =
      resolved?.tickSize !== null && resolved?.tickSize !== undefined
        ? Number(resolved.tickSize)
        : null;
    const minTick =
      reportedTick !== null && Number.isFinite(reportedTick) && reportedTick > 0
        ? reportedTick
        : resolved && resolved.digits > 0
          ? Math.pow(10, -resolved.digits)
          : await this.host.getSymbolMinTick(symbol).catch(() => 0.00001);

    const pip = resolved ? pipSize(resolved) : null;

    return {
      qty: {
        min: resolved?.volumeMin ? Number(resolved.volumeMin) : FALLBACK_QTY.min,
        max: resolved?.volumeMax ? Number(resolved.volumeMax) : FALLBACK_QTY.max,
        step: resolved?.volumeStep ? Number(resolved.volumeStep) : FALLBACK_QTY.step,
        // Without a default the library supplies its OWN, which is 1 — one LOT
        // on a field whose step is 0.01, so a quick order that looked like a
        // minimum trade went in a hundred times larger. The smallest tradable
        // size is the only safe default for a control that can place a trade
        // in one click.
        default: resolved?.volumeMin ? Number(resolved.volumeMin) : FALLBACK_QTY.min,
        uiStep: resolved?.volumeStep ? Number(resolved.volumeStep) : FALLBACK_QTY.step,
      },
      // The quantity field is in LOTS. Left unset, the library labels it
      // "Units", which is what made the same value read as units on the chart
      // ticket and as lots in every panel beside it.
      units: 'Lots',
      // Value of one pip per lot, derived from the instrument's real tick data.
      // Reported as 1 only when the gateway supplied neither, which the risk
      // calculator surfaces as unavailable rather than silently trusting.
      pipValue:
        pip !== null && resolved?.tickSize && resolved?.tickValue && Number(resolved.tickSize) !== 0
          ? (Number(pip) / Number(resolved.tickSize)) * Number(resolved.tickValue)
          : 1,
      // Same zero-divisor rule as minTick: a non-positive pip falls back to
      // the tick rather than reaching the library's price math.
      pipSize: pip !== null && Number(pip) > 0 ? Number(pip) : minTick,
      minTick,
      description: resolved?.description || symbol,
      currency: resolved?.currencyCode ?? undefined,
    } as InstrumentInfo;
  }

  /**
   * The symbol record inside a hard time budget, or undefined.
   *
   * Everything the library asks this adapter about a symbol sits on its
   * position/bracket render path, and the library wraps those calls in its
   * own 10-second limit ("formatter not received"). A gateway that is slow or
   * reconnecting — exactly the state observed seconds after a fill in the
   * 2026-08-24 wedge — must degrade these answers, never stall them: a
   * timely fallback keeps the chart alive, an unresolved promise kills it.
   */
  private resolveWithBudget(
    symbol: string,
    budgetMs: number = SYMBOL_RESOLVE_BUDGET_MS,
  ): Promise<TradingSymbol | undefined> {
    const resolve = this.deps.resolveSymbol(symbol).catch(() => undefined);
    const budget = new Promise<undefined>((settle) =>
      setTimeout(() => settle(undefined), budgetMs),
    );
    return Promise.race([resolve, budget]);
  }

  /**
   * Price formatter for the library's position/order lines and trading UI.
   *
   * Implemented HERE so the trading surface never waits on the library's
   * `defaultFormatter`, which resolves through a datafeed round-trip: with the
   * gateway reconnecting moments after a fill, that round-trip blew the
   * library's 10s limit, `_updateSymbolData` rejected with "formatter not
   * received", and the position line render path died (2026-08-24 wedge).
   * This one answers from the shared symbol cache and falls back to the
   * symbol's displayed digits, so it ALWAYS resolves quickly.
   */
  async formatter(symbol: string, _alignToMinMove: boolean): Promise<INumberFormatter> {
    const resolved = await this.resolveWithBudget(symbol);
    const digits = resolved && resolved.digits > 0 ? resolved.digits : FALLBACK_PRICE_DIGITS;
    return {
      // Grouped like the library's own default ("2,400.25", not "2400.25") —
      // the DOM ladder and position lines render these strings, and the e2e
      // ladder lookup matches on the grouped form the library always used.
      format: (value?: number) =>
        value === undefined || !Number.isFinite(value)
          ? ''
          : value.toLocaleString('en-US', {
              minimumFractionDigits: digits,
              maximumFractionDigits: digits,
            }),
    };
  }

  /** Quantity (lots) formatter, from the symbol's volume step. */
  async quantityFormatter(symbol: string): Promise<INumberFormatter> {
    const resolved = await this.resolveWithBudget(symbol);
    const step = resolved?.volumeStep ? Number(resolved.volumeStep) : FALLBACK_QTY.step;
    const decimals = fractionDigitsOf(step);
    return {
      format: (value?: number) =>
        value === undefined || !Number.isFinite(value) ? '' : value.toFixed(decimals),
    };
  }

  /**
   * Active orders, INCLUDING the synthetic bracket orders that make SL/TP
   * cancellable.
   *
   * Position brackets are returned here too, not from `positions()`: the
   * library's `positions()` is typed `Position[]` and cannot carry orders, so a
   * bracket hanging off a position is an Order with `parentType: Position`.
   * This is the only place either kind of bracket enters the library.
   */
  async orders(): Promise<Order[]> {
    const { orders, positions } = useTradingStore.getState();
    return [
      ...orders.map(toLibraryOrder),
      ...orderBrackets(orders),
      ...positionBrackets(positions),
    ];
  }

  async positions(): Promise<Position[]> {
    return useTradingStore.getState().positions.map(toLibraryPosition);
  }

  /**
   * Per-fill executions for the chart's buy/sell arrows.
   *
   * The library asks per symbol and re-asks as the user pans, so the fetched
   * window is cached briefly rather than re-requested on every redraw. When the
   * deployment does not serve executions the dep is absent and this returns an
   * empty list — which is truthful, unlike synthesising fills from positions,
   * whose open price is an AVERAGE and would place arrows at prices that never
   * traded.
   */
  async executions(symbol: string): Promise<Execution[]> {
    const load = this.deps.loadExecutions;
    if (!load) return [];

    const now = Date.now();
    if (!this.executionsCache || now - this.executionsCache.fetchedAt > EXECUTIONS_CACHE_MS) {
      const promise = load().catch(() => [] as Execution[]);
      this.executionsCache = { fetchedAt: now, promise };
    }

    const all = await this.executionsCache.promise;
    return all.filter((execution) => execution.symbol === symbol);
  }

  /** Drops cached executions so the next request refetches. */
  invalidateExecutions(): void {
    this.executionsCache = null;
  }

  async placeOrder(preOrder: PreOrder): Promise<PlaceOrderResult> {
    const key = orderKey(preOrder);
    const inFlight = this.inFlightOrders.get(key);
    if (inFlight) return inFlight;

    const submission = this.submitOrder(preOrder).finally(() => {
      this.inFlightOrders.delete(key);
    });
    this.inFlightOrders.set(key, submission);
    return submission;
  }

  private async submitOrder(preOrder: PreOrder): Promise<PlaceOrderResult> {
    const volume = toDecimalString(preOrder.qty);
    if (volume === null) {
      throw new TradingError({
        kind: 'validation',
        message: 'Enter a valid volume.',
        code: 'trade.invalid-volume',
      });
    }

    const side = preOrder.side === TV_SIDE.Buy ? 'buy' : 'sell';
    const displaySymbol = preOrder.symbol;

    try {
      if (preOrder.type === TV_ORDER_TYPE.Market) {
        // The quote store is keyed by GATEWAY symbol (suffix included), so the
        // active account's suffix policy is applied at submission time — the
        // same lookup the order ticket performs. The bare display name is kept
        // as a fallback for quotes recorded under a no-suffix policy.
        const suffixPolicy = useSessionStore.getState().suffixPolicy;
        const quote =
          quoteStore.get(suffixPolicy.toGateway(displaySymbol)) ?? quoteStore.get(displaySymbol);
        const price =
          toDecimalString(preOrder.limitPrice) ??
          (quote ? (side === 'buy' ? quote.ask : quote.bid) : null);

        if (price === null) {
          throw new TradingError({
            kind: 'validation',
            message: 'No live price is available for this symbol.',
            code: 'trade.no-quote',
          });
        }

        const result = this.settle(
          await this.trading.openPosition({
            displaySymbol,
            side,
            volumeLots: volume,
            price,
            stopLoss: toDecimalString(preOrder.stopLoss),
            takeProfit: toDecimalString(preOrder.takeProfit),
          }),
          'Order outcome unknown',
          'Order placed',
        );
        return result.orderId ? { orderId: result.orderId } : {};
      }

      if (preOrder.type === TV_ORDER_TYPE.StopLimit) {
        // `supportStopLimitOrders` is not advertised, so the library should
        // never send one. Refusing is safer than filing it as a plain stop
        // that silently drops one of its two prices.
        throw new TradingError({
          kind: 'validation',
          message: 'Stop-limit orders are not supported on this account.',
          code: 'trade.unsupported-type',
        });
      }

      // A limit order's entry is its limitPrice; a stop's is its stopPrice.
      // Never fall back from one to the other — a stop filed at a limit price
      // is a different trade.
      const rawPrice =
        preOrder.type === TV_ORDER_TYPE.Limit ? preOrder.limitPrice : preOrder.stopPrice;
      const price = await this.normalizePendingPrice(displaySymbol, rawPrice);

      const result = this.settle(
        await this.trading.placePendingOrder({
          displaySymbol,
          side,
          kind: preOrder.type === TV_ORDER_TYPE.Limit ? 'limit' : 'stop',
          volumeLots: volume,
          price,
          stopLoss: toDecimalString(preOrder.stopLoss),
          takeProfit: toDecimalString(preOrder.takeProfit),
        }),
        'Order outcome unknown',
        'Order placed',
      );
      return result.orderId ? { orderId: result.orderId } : {};
    } catch (error) {
      this.notifyError('Order rejected', error);
      throw error;
    }
  }

  /**
   * Modifies a whole pending order, or moves a single bracket leg.
   *
   * Brackets render as draggable chart lines now that they are first-class
   * orders, and dragging one arrives here under its synthetic id. Real orders
   * are matched first, exactly as in `cancelOrder`.
   */
  async modifyOrder(order: Order): Promise<void> {
    const existing = useTradingStore.getState().ordersById.get(order.id);
    if (!existing) {
      const bracket = parseBracketId(order.id);
      if (bracket) {
        // A bracket leg carries its new level as its own price: the stop leg is
        // a Stop order, the target leg a Limit.
        const price = bracket.leg === 'sl' ? order.stopPrice : order.limitPrice;
        return this.modifyBracket(bracket.parentId, bracket.leg, price);
      }
      throw new TradingError({ kind: 'validation', message: 'Order not found.' });
    }

    const price = toDecimalString(order.limitPrice ?? order.stopPrice) ?? undefined;
    const stopLoss = toDecimalString(order.stopLoss);
    const takeProfit = toDecimalString(order.takeProfit);
    const nextVolume = toDecimalString(order.qty);

    // A size change is not a modify on this server and cannot be sent as one:
    // MT5 applies the rest of the request and silently drops the volume. It
    // goes down the cancel-and-replace path instead, which the trader is asked
    // about first because it changes the order's ticket.
    if (nextVolume !== null && !dec(nextVolume).equals(dec(existing.volume))) {
      return this.resizeOrder(existing, nextVolume, { price, stopLoss, takeProfit });
    }

    try {
      this.settle(
        await this.trading.modifyOrder(existing, {
          price,
          volumeLots: nextVolume ?? undefined,
          stopLoss,
          takeProfit,
        }),
        'Modification outcome unknown',
        'Order modified',
      );
    } catch (error) {
      this.notifyError('Could not modify order', error);
      throw error;
    }
  }

  /**
   * Resizes a pending order by cancelling it and placing its replacement.
   *
   * Confirmed first, and never silently: the order leaves the book and returns
   * under a new ticket, which is not what someone typing into a Qty field
   * asked for. Declining leaves the order exactly as it was, and says so —
   * the library has already closed its dialog by this point, so silence would
   * read as "done".
   */
  private async resizeOrder(
    existing: TradingOrder,
    volumeLots: DecimalString,
    changes: {
      price?: DecimalString;
      stopLoss?: DecimalString | null;
      takeProfit?: DecimalString | null;
    },
  ): Promise<void> {
    const confirmed = await useResizeConfirm.getState().ask({
      orderId: existing.id,
      displaySymbol: existing.displaySymbol,
      from: existing.volume,
      to: volumeLots,
    });

    if (!confirmed) {
      this.deps.onNotification?.(
        'Order unchanged',
        `Order ${existing.id} still has ${existing.volume} lots.`,
        false,
      );
      // The library optimistically redrew the order at the size that was
      // typed. Republishing the real one snaps its view back to the truth.
      this.republishOrder(existing.id);
      return;
    }

    try {
      const result = await this.trading.resizePendingOrder(existing, volumeLots, changes);
      this.settle(result.cancelled, 'Cancellation outcome unknown', 'Order cancelled');
      this.settle(
        result.placed,
        'Replacement outcome unknown',
        `Order resized to ${volumeLots} lots`,
      );
      if (result.placed.state === 'accepted' && result.placed.orderId) {
        this.deps.onNotification?.(
          'Order ID changed',
          `${result.previousOrderId} was replaced by ${result.placed.orderId}.`,
          false,
        );
      }
    } catch (error) {
      // `trade.resize-orphaned` is the one that matters: the original is gone
      // and its replacement never arrived. It carries its own full explanation.
      this.notifyError('Could not resize order', error);
      this.republishOrder(existing.id);
      throw error;
    }
  }

  /**
   * Re-sends one order, and its bracket legs, exactly as the store holds them.
   *
   * The library redraws an order optimistically the moment its dialog is
   * submitted. When the submission does not go through — a declined resize, a
   * failed one — that optimistic view shows a size the trader does not have,
   * and nothing else would correct it until the next unrelated update.
   */
  private republishOrder(orderId: string): void {
    const current = useTradingStore.getState().ordersById.get(orderId);
    if (!current) return;
    this.host.orderUpdate(toLibraryOrder(current));
    for (const leg of orderBrackets([current])) this.host.orderUpdate(leg);
  }

  /**
   * Cancels a whole pending order, or a single bracket leg.
   *
   * The chart's close button, the chart context menu, the Account Manager's
   * Cancel button and its context menu all arrive here with an id. A REAL order
   * id is looked up first, so an id that merely looks synthetic can never be
   * misread as a bracket. A synthetic bracket id is routed to a modify on the
   * PARENT with that leg cleared — it must never reach the gateway's
   * `cancel-pending` intent, which knows only real tickets.
   */
  async cancelOrder(orderId: string): Promise<void> {
    const existing = useTradingStore.getState().ordersById.get(orderId);
    if (!existing) {
      const bracket = parseBracketId(orderId);
      if (bracket) return this.cancelBracket(bracket.parentId, bracket.leg);
      throw new TradingError({ kind: 'validation', message: 'Order not found.' });
    }

    try {
      this.settle(
        await this.trading.cancelOrder(existing),
        'Cancellation outcome unknown',
        'Order canceled',
      );
    } catch (error) {
      this.notifyError('Could not cancel order', error);
      throw error;
    }
  }

  /**
   * Clears ONE bracket leg by modifying its parent.
   *
   * The sibling leg is deliberately explicit in both branches. The pending-order
   * path has an "unchanged" sentinel (`undefined` leaves the stored value
   * alone), but the position path has none — `modifyPositionBrackets` sends BOTH
   * levels on every call, and `null` there means "clear this level". Passing
   * `undefined` for the sibling would therefore not preserve it; it would put
   * `NaN` on the wire. So the position branch re-sends the sibling's current
   * value read from the store.
   */
  private cancelBracket(parentId: string, leg: BracketLeg): Promise<void> {
    return this.setBracketLeg(parentId, leg, null, {
      success: leg === 'sl' ? 'Stop loss canceled' : 'Take profit canceled',
      unknown: 'Cancellation outcome unknown',
      failure: 'Could not cancel bracket',
    });
  }

  /** Moves one bracket leg to a new level. */
  private modifyBracket(
    parentId: string,
    leg: BracketLeg,
    price: number | undefined,
  ): Promise<void> {
    const level = toDecimalString(price);
    if (level === null) {
      const error = new TradingError({
        kind: 'validation',
        message: 'Enter a valid price for this bracket.',
        code: 'trade.no-price',
      });
      this.notifyError('Could not modify bracket', error);
      throw error;
    }

    return this.setBracketLeg(parentId, leg, level, {
      success: leg === 'sl' ? 'Stop loss updated' : 'Take profit updated',
      unknown: 'Modification outcome unknown',
      failure: 'Could not modify bracket',
    });
  }

  /**
   * Writes ONE bracket leg on a parent, leaving its sibling exactly as it was.
   * `null` clears the leg, which is how a bracket cancellation is expressed to
   * a trading server that has no concept of a standalone bracket order.
   *
   * Clearing routes through `TradingService.cancelBracketLeg`, which the
   * Positions/Orders dock also calls — the sibling-preservation rule differs
   * between the two parent kinds and must not be restated per call site.
   */
  private async setBracketLeg(
    parentId: string,
    leg: BracketLeg,
    level: DecimalString | null,
    messages: { success: string; unknown: string; failure: string },
  ): Promise<void> {
    const state = useTradingStore.getState();
    const order = state.ordersById.get(parentId);
    const position = order ? undefined : state.positionsById.get(parentId);

    if (!order && !position) {
      throw new TradingError({ kind: 'validation', message: 'Order not found.' });
    }
    const parent = order
      ? ({ kind: 'order', order } as const)
      : ({ kind: 'position', position: position! } as const);

    try {
      const result =
        level === null
          ? await this.trading.cancelBracketLeg(parent, leg)
          : parent.kind === 'order'
            ? await this.trading.modifyOrder(parent.order, {
                stopLoss: leg === 'sl' ? level : undefined,
                takeProfit: leg === 'tp' ? level : undefined,
              })
            : await this.trading.modifyPositionBrackets(parent.position, {
                stopLoss: leg === 'sl' ? level : parent.position.stopLoss,
                takeProfit: leg === 'tp' ? level : parent.position.takeProfit,
              });
      this.settle(result, messages.unknown, messages.success);
    } catch (error) {
      this.notifyError(messages.failure, error);
      throw error;
    }
  }

  async closePosition(positionId: string): Promise<void> {
    const position = useTradingStore.getState().positionsById.get(positionId);
    if (!position) throw new TradingError({ kind: 'validation', message: 'Position not found.' });

    try {
      this.settle(
        await this.trading.closePosition(position),
        'Close outcome unknown',
        'Position closed',
      );
    } catch (error) {
      this.notifyError('Could not close position', error);
      throw error;
    }
  }

  /** Drag-to-modify on the chart lands here. */
  async editPositionBrackets(positionId: string, brackets: Brackets): Promise<void> {
    const position = useTradingStore.getState().positionsById.get(positionId);
    if (!position) throw new TradingError({ kind: 'validation', message: 'Position not found.' });

    // MT5 cannot resize a position through an SLTP modification, and the
    // library's `Brackets` carry no quantity — but typings can lag reality
    // and a future dialog could smuggle one in. If a size change ever reaches
    // this handler, refuse the whole edit loudly: applying the brackets while
    // dropping the resize would leave the trader believing a trade happened.
    const requestedQty = (brackets as { qty?: unknown }).qty;
    if (
      typeof requestedQty === 'number' &&
      Number.isFinite(requestedQty) &&
      requestedQty > 0 &&
      requestedQty !== Number(position.volume)
    ) {
      const error = new TradingError({
        kind: 'validation',
        message: 'Position size cannot be changed here — use a partial close.',
        code: 'trade.no-position-resize',
      });
      this.notifyError('Could not modify position', error);
      throw error;
    }

    try {
      this.settle(
        await this.trading.modifyPositionBrackets(position, {
          stopLoss: toDecimalString(brackets.stopLoss),
          takeProfit: toDecimalString(brackets.takeProfit),
        }),
        'Modification outcome unknown',
        'Position brackets updated',
      );
    } catch (error) {
      this.notifyError('Could not modify position', error);
      throw error;
    }
  }

  // ── Leverage ───────────────────────────────────────────────────────────────

  /**
   * Account leverage, for the library's own "Adjust leverage" dialog.
   *
   * Leverage in MT5 belongs to the ACCOUNT, not to a symbol or an order — the
   * library asks per order because some brokers vary it that way; this one does
   * not, so the same answer is given whatever is being ordered.
   *
   * `min`/`max`/`step` describe a CONTINUOUS range to the library, but a broker
   * offers a discrete list. The range is reported as the list's bounds with the
   * tightest step that lands on every value, so the dialog cannot produce a
   * number the gateway will refuse.
   */
  async leverageInfo(): Promise<LeverageInfo> {
    const state = await this.requireLeverage();
    return {
      title: 'Adjust leverage',
      leverage: state.leverage,
      min: state.min,
      max: state.max,
      step: stepOverChoices(state.choices),
    };
  }

  /**
   * Previews a value WITHOUT writing it.
   *
   * The library calls this as the trader moves the control, so it must not
   * touch the account. It only reports whether the broker offers the value.
   */
  async previewLeverage(params: { leverage: number }): Promise<LeveragePreviewResult> {
    const state = await this.requireLeverage();
    if (state.choices.length > 0 && !state.choices.includes(params.leverage)) {
      return {
        errors: [
          `This account is offered ${state.choices.map((choice: number) => `1:${choice}`).join(', ')}.`,
        ],
      };
    }
    return {
      infos: [`Leverage applies to the whole account, not to this order alone.`],
    };
  }

  /** Writes it, and reports what the SERVER holds afterwards. */
  async setLeverage(params: { leverage: number }): Promise<LeverageSetResult> {
    const login = useSessionStore.getState().activeLogin;
    if (!login || !this.deps.leverage) {
      throw new TradingError({
        kind: 'validation',
        message: 'Leverage cannot be changed on this account.',
        code: 'leverage.unavailable',
      });
    }
    try {
      const state = await this.deps.leverage.set(login, params.leverage);
      this.deps.onNotification?.('Leverage updated', `Now 1:${state.leverage}.`, false);
      return { leverage: state.leverage };
    } catch (error) {
      this.notifyError('Could not change leverage', error);
      throw error;
    }
  }

  private async requireLeverage(): Promise<LeverageState> {
    const login = useSessionStore.getState().activeLogin;
    if (!login || !this.deps.leverage) {
      throw new TradingError({
        kind: 'validation',
        message: 'Leverage is not available on this account.',
        code: 'leverage.unavailable',
      });
    }
    return this.deps.leverage.get(login);
  }

  /**
   * Chart right-click → the library's own default trading actions.
   *
   * Returning an empty array here is documented to REMOVE the Trade button and
   * every trading action from the chart context menu, which is exactly the
   * regression this method previously shipped. The host's defaults honour the
   * user's "Instant orders placement" setting: with it off they open the Order
   * Ticket, with it on they call `placeOrder` once, at the price where the
   * menu was opened (`context.value`, passed through untouched).
   *
   * That is also why the actions are withheld while the chart's symbol and the
   * application's differ. Switching symbol swaps the series asynchronously, and
   * for as long as that takes the chrome around the chart already names the new
   * instrument while the plot, its price scale and this menu still describe the
   * old one. The order the library would build is self-consistent — it comes
   * from the chart context — but it is not the instrument the trader is being
   * shown everywhere else, and instant placement turns that gap into a filled
   * order with one click. No Trade menu until the two agree.
   */
  chartContextMenuActions(
    context: TradeContext,
    options?: DefaultContextMenuActionsParams,
  ): Promise<ActionMetaInfo[]> {
    const tradingSymbol = selectActiveSymbol(useWorkspace.getState());
    if (context.symbol && tradingSymbol && context.symbol !== tradingSymbol) {
      warnOnce('context-menu-symbol-lag', 'trade actions withheld while the chart catches up', {
        chartSymbol: context.symbol,
        tradingSymbol,
      });
      // A disabled line rather than an empty array. Returning nothing reads as
      // a broken right-click — the trader cannot tell "blocked on purpose"
      // from "the app is stuck" — and it takes the menu's non-trading entries
      // down with it.
      return Promise.resolve([
        {
          text: `Loading ${tradingSymbol}…`,
          tooltip: `Trading is paused while the chart still shows ${context.symbol}.`,
          enabled: false,
          action: () => undefined,
        } as ActionMetaInfo,
      ]);
    }
    clearDiagnostic('context-menu-symbol-lag');
    return this.host.defaultContextMenuActions(context, options);
  }

  /**
   * Corrects the quantity the library SEEDS a symbol with, during the window
   * in which it seeds it.
   *
   * The library asks itself for a quantity before this adapter has told it the
   * instrument's minimum, so it falls back to its own default of 1 — one LOT
   * where the step is 0.01 — and persists that. Deleting the stored value at
   * boot fixes every symbol except the one being loaded, which is re-seeded
   * immediately afterwards and is exactly the symbol the trader is looking at.
   *
   * So the seed is corrected for a few seconds after the symbol resolves, and
   * only while the stored value is still the library's own 1 against an
   * instrument that trades smaller. A quantity the trader types — then, or
   * ever after — is outside the window and is never touched.
   */
  private correctSeededQuantity(symbol: string, resolved: TradingSymbol | undefined): void {
    if (!resolved?.volumeMin) return;
    const min = Number(resolved.volumeMin);
    if (!Number.isFinite(min) || min <= 0 || min >= LIBRARY_SEED_QTY) return;
    if (this.seedCorrected.has(symbol)) return;
    this.seedCorrected.add(symbol);

    let attempts = 0;
    const correct = async () => {
      attempts += 1;
      if (this.disposed || attempts > SEED_CORRECTION_ATTEMPTS) return;
      try {
        if ((await this.host.getQty(symbol)) === LIBRARY_SEED_QTY) {
          this.host.setQty(symbol, min);
        }
      } catch {
        return; // an older library without the qty API
      }
      setTimeout(() => void correct(), SEED_CORRECTION_INTERVAL_MS);
    };
    setTimeout(() => void correct(), SEED_CORRECTION_INTERVAL_MS);
  }

  /**
   * Validates and tick-normalizes a pending entry price.
   *
   * A context-menu or DOM price is a raw chart/book coordinate: it can sit
   * between ticks, and a poisoned context can carry NaN, Infinity, zero, or a
   * negative. Anything non-positive or non-finite is refused outright; a valid
   * price is snapped to the instrument's tick grid and digits so the order the
   * server books equals the price the trader saw.
   */
  private async normalizePendingPrice(
    displaySymbol: string,
    rawPrice: number | undefined,
  ): Promise<DecimalString> {
    if (typeof rawPrice !== 'number' || !Number.isFinite(rawPrice) || rawPrice <= 0) {
      throw new TradingError({
        kind: 'validation',
        message: 'Enter a valid entry price for this order.',
        code: 'trade.no-price',
      });
    }

    let price = toDecimalString(rawPrice);
    if (price === null) {
      throw new TradingError({
        kind: 'validation',
        message: 'Enter a valid entry price for this order.',
        code: 'trade.no-price',
      });
    }

    const resolved = await this.deps.resolveSymbol(displaySymbol).catch(() => undefined);
    if (resolved?.tickSize) price = snapPriceToTick(price, resolved.tickSize);
    if (resolved && Number.isFinite(resolved.digits)) {
      price = roundToDigits(price, resolved.digits);
    }
    return price;
  }

  // ── Depth of Market ────────────────────────────────────────────────────────

  /**
   * The library calls this when its DOM widget opens for a symbol; data flows
   * back through `host.domUpdate`. The gateway serves depth over REST only, so
   * the adapter polls — recursive setTimeout, with the next request scheduled
   * only after the previous one settles, so two polls can never overlap.
   * Repeat subscriptions for a symbol join the existing loop.
   */
  subscribeDOM(displaySymbol: string): void {
    if (!this.deps.loadMarketDepth) return;
    if (this.domSubscriptions.has(displaySymbol)) return;

    const subscription: DomSubscription = {
      abort: new AbortController(),
      timer: null,
      stopped: false,
      reportedUnits: new Set(),
      delay: DOM_POLL_MS,
    };
    this.domSubscriptions.set(displaySymbol, subscription);
    // The first snapshot goes out immediately; the widget opens empty otherwise.
    void this.pollDom(displaySymbol, subscription);
  }

  unsubscribeDOM(displaySymbol: string): void {
    const subscription = this.domSubscriptions.get(displaySymbol);
    if (subscription) this.stopDomSubscription(displaySymbol, subscription);
  }

  private stopDomSubscription(displaySymbol: string, subscription: DomSubscription): void {
    subscription.stopped = true;
    if (subscription.timer !== null) clearTimeout(subscription.timer);
    subscription.timer = null;
    subscription.abort.abort();
    this.domSubscriptions.delete(displaySymbol);
  }

  private stopAllDomPolling(): void {
    for (const [displaySymbol, subscription] of [...this.domSubscriptions]) {
      this.stopDomSubscription(displaySymbol, subscription);
    }
  }

  private async pollDom(displaySymbol: string, subscription: DomSubscription): Promise<void> {
    const load = this.deps.loadMarketDepth;
    if (!load || subscription.stopped) return;

    // Session context is read at REQUEST time, never captured at construction:
    // the account (and with it the symbol suffix) can change while the chart
    // stays mounted. A response that raced an account switch is detected below
    // by comparing against the then-current session and discarded.
    const session = useSessionStore.getState();
    const requestLogin = session.activeLogin;
    const requestSuffix = session.suffixPolicy.suffix;
    const abort = subscription.abort;

    if (requestLogin !== null) {
      try {
        const depth = await load(session.suffixPolicy.toGateway(displaySymbol), abort.signal);

        const current = useSessionStore.getState();
        const stale =
          subscription.stopped ||
          this.domSubscriptions.get(displaySymbol) !== subscription ||
          abort.signal.aborted ||
          current.activeLogin !== requestLogin ||
          current.suffixPolicy.suffix !== requestSuffix;

        if (!stale) {
          // Pacing follows the BOOK, not the mapped ladder: a book with levels
          // this adapter refuses to display (unknown volume unit, crossed) is
          // still a live feed, and slowing down would delay noticing it
          // recovered.
          subscription.delay = nextDepthPollDelay(subscription.delay, depth);
          this.host.domUpdate(displaySymbol, this.toDomData(depth, subscription));
        }
      } catch (error) {
        // An abort is this adapter's own teardown/switch, not a failure. Real
        // failures go to the sanitized diagnostic sink; the loop itself keeps
        // running, because a transient depth error must not kill the DOM.
        if (!subscription.stopped && !abort.signal.aborted) {
          // A failing endpoint deserves the same restraint as an empty one.
          subscription.delay = nextDepthPollDelay(subscription.delay, undefined);
          this.deps.onDepthError?.(error);
        }
      }
    }

    if (subscription.stopped) return;
    subscription.timer = setTimeout(() => {
      subscription.timer = null;
      void this.pollDom(displaySymbol, subscription);
    }, subscription.delay);
  }

  /**
   * Converts the gateway book into the library's DOMData.
   *
   * Anything that could turn a click into a wrong order yields an EMPTY
   * snapshot instead: a crossed book, an unknown volume unit, or a book with
   * no usable levels. An empty ladder offers nothing to click, whereas leaving
   * the previous snapshot on screen invites an order at a price that no longer
   * exists.
   */
  private toDomData(depth: MarketDepthDto, subscription: DomSubscription): DOMData {
    const empty: DOMData = { snapshot: true, asks: [], bids: [] };

    if (!DOM_PASSTHROUGH_VOLUME_UNITS.has(depth.volumeUnit)) {
      if (!subscription.reportedUnits.has(depth.volumeUnit)) {
        subscription.reportedUnits.add(depth.volumeUnit);
        this.deps.onDepthError?.(
          new TradingError({
            kind: 'validation',
            message: `The trading server reports depth volume in "${depth.volumeUnit}", which this terminal cannot convert.`,
            code: 'depth.unknown-volume-unit',
          }),
        );
      }
      return empty;
    }

    if (depth.crossed) return empty;

    const bids = toDomLevels(depth.bids);
    const asks = toDomLevels(depth.asks);
    if (bids.length === 0 && asks.length === 0) return empty;
    // Belt and braces: the gateway flags crossed books, but a book that IS
    // crossed after filtering must not be offered either. Both sides are
    // ascending, so best bid is last and best ask is first.
    if (bids.length > 0 && asks.length > 0 && bids[bids.length - 1]!.price >= asks[0]!.price) {
      return empty;
    }
    return { snapshot: true, asks, bids };
  }

  // `subscribeRealtime`/`unsubscribeRealtime` are DELIBERATELY not implemented.
  // Implementing them tells the library this broker will push its own trading
  // quotes through `host.realtimeUpdate` — and an implementation that stays
  // silent starves the trading quote snapshot, which hides every chart
  // context-menu Buy/Sell action and DOM price. Omitting them makes the
  // library source trading quotes from the datafeed's quotes API, which serves
  // the same gateway stream the rest of the terminal uses.

  /**
   * REQUIRED Broker API method — the library constructs its Account Manager
   * machinery whenever trading is enabled and throws a TypeError on every
   * boot and account switch when this is absent (observed live; it was the
   * only console error a healthy session produced).
   *
   * The panel itself is deliberately suppressed (`open_account_manager` is in
   * disabled_features — the app's own bottom dock is the account surface),
   * but the contract still has to be honoured, and if the panel is ever
   * enabled it should show the truth: a live summary row and the standard
   * Positions/Orders tables, bracket columns included.
   */
  accountManagerInfo(): AccountManagerInfo {
    const summary = this.ensureSummaryValues();
    const std = (name: string) => name as StandardFormatterName;

    const positionColumns = [
      { id: 'symbol', label: 'Symbol', dataFields: ['symbol'], formatter: std('symbol') },
      { id: 'side', label: 'Side', dataFields: ['side'], formatter: std('positionSide') },
      { id: 'qty', label: 'Qty', dataFields: ['qty'], alignment: 'right' },
      {
        id: 'avgPrice',
        label: 'Avg fill price',
        dataFields: ['avgPrice'],
        formatter: std('formatPrice'),
        alignment: 'right',
      },
      {
        id: 'stopLoss',
        label: 'Stop loss',
        dataFields: ['stopLoss'],
        formatter: std('formatPrice'),
        alignment: 'right',
      },
      {
        id: 'takeProfit',
        label: 'Take profit',
        dataFields: ['takeProfit'],
        formatter: std('formatPrice'),
        alignment: 'right',
      },
      {
        id: 'profit',
        label: 'P/L',
        dataFields: ['profit'],
        formatter: std('profit'),
        alignment: 'right',
      },
    ];

    const orderColumns = [
      { id: 'symbol', label: 'Symbol', dataFields: ['symbol'], formatter: std('symbol') },
      { id: 'side', label: 'Side', dataFields: ['side'], formatter: std('side') },
      { id: 'type', label: 'Type', dataFields: ['type'], formatter: std('type') },
      { id: 'qty', label: 'Qty', dataFields: ['qty'], alignment: 'right' },
      // Two columns, because an order has at most one of these and the
      // standard price formatter reads only the FIRST of a column's
      // dataFields. Declaring both on one column looked like a fallback and
      // was not: a stop order — including every `-sl` bracket leg — rendered
      // an empty Price cell, with its level visible only in the parent row's
      // Stop loss column (2026-08-21 QA). Naming them separately is also more
      // truthful: a stop's number is a trigger, not a price it will fill at.
      {
        id: 'limitPrice',
        label: 'Price',
        dataFields: ['limitPrice'],
        formatter: std('formatPrice'),
        alignment: 'right',
      },
      {
        id: 'stopPrice',
        label: 'Trigger',
        dataFields: ['stopPrice'],
        formatter: std('formatPrice'),
        alignment: 'right',
      },
      {
        id: 'stopLoss',
        label: 'Stop loss',
        dataFields: ['stopLoss'],
        formatter: std('formatPrice'),
        alignment: 'right',
      },
      {
        id: 'takeProfit',
        label: 'Take profit',
        dataFields: ['takeProfit'],
        formatter: std('formatPrice'),
        alignment: 'right',
      },
      { id: 'status', label: 'Status', dataFields: ['status'], formatter: std('status') },
    ];

    return {
      accountTitle: 'OpoTrade',
      summary: [
        { text: 'Balance', wValue: summary.balance, formatter: std('fixed'), isDefault: true },
        { text: 'Equity', wValue: summary.equity, formatter: std('fixed'), isDefault: true },
        { text: 'P/L', wValue: summary.profit, formatter: std('profit'), isDefault: true },
        { text: 'Margin', wValue: summary.margin, formatter: std('fixed') },
        { text: 'Free margin', wValue: summary.freeMargin, formatter: std('fixed') },
      ],
      marginUsed: summary.margin,
      orderColumns: orderColumns as OrderTableColumn[],
      positionColumns: positionColumns as AccountManagerInfo['positionColumns'],
      pages: [],
    };
  }

  /** Creates the summary watched values once, seeded from the current store. */
  private ensureSummaryValues(): NonNullable<GatewayBrokerAdapter['summaryValues']> {
    if (!this.summaryValues) {
      this.summaryValues = {
        balance: this.host.factory.createWatchedValue(0),
        equity: this.host.factory.createWatchedValue(0),
        profit: this.host.factory.createWatchedValue(0),
        margin: this.host.factory.createWatchedValue(0),
        freeMargin: this.host.factory.createWatchedValue(0),
      };
      this.refreshSummaryValues();
    }
    return this.summaryValues;
  }

  private refreshSummaryValues(): void {
    if (!this.summaryValues) return;
    const account = useTradingStore.getState().account;
    if (!account) return;
    this.summaryValues.balance.setValue(Number(account.balance));
    this.summaryValues.equity.setValue(Number(account.equity));
    this.summaryValues.profit.setValue(Number(account.profit));
    this.summaryValues.margin.setValue(Number(account.margin));
    this.summaryValues.freeMargin.setValue(Number(account.marginFree));
  }

  subscribeEquity(): void {
    const account = useTradingStore.getState().account;
    if (account) this.host.equityUpdate(Number(account.equity));
  }

  unsubscribeEquity(): void {
    /* the store subscription covers this for the adapter's lifetime */
  }

  subscribePipValue(): void {
    /* pip value requires per-symbol tick value; surfaced in our own ticket */
  }

  unsubscribePipValue(): void {
    /* no-op */
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of this.reinforceTimers) clearTimeout(timer);
    this.reinforceTimers.clear();
    this.stopAllDomPolling();
    this.unsubscribeStore?.();
    this.unsubscribeStore = null;
    this.unsubscribeSession?.();
    this.unsubscribeSession = null;
  }

  /**
   * Teardown hook the library probes for when it tears the broker down.
   *
   * It is not part of the published `IBrokerTerminal` interface, but the
   * library's connection adapter calls it and logs "Failed to disconnect" when
   * it is absent. Our own React cleanup already calls `dispose()`; this alias
   * makes the library's path succeed too, and is safe to call twice.
   */
  disconnect(): void {
    this.dispose();
  }

  private notifyError(title: string, error: unknown): void {
    const message =
      error instanceof TradingError ? error.message : 'The request could not be completed.';
    this.deps.onNotification?.(title, message, true);
  }

  /**
   * Surfaces a chart-originated submission's outcome.
   *
   * The order ticket shows its own banners, but a trade placed or modified
   * from the CHART returns through this adapter, and the library shows
   * nothing of its own — so both endings need a voice here. An undecided
   * outcome is the dangerous silence (it reads as success and invites a
   * duplicate); a confirmed one deserves the toast QA rightly expects —
   * "bracket edited" with no feedback is indistinguishable from a dropped
   * request.
   */
  private settle(
    result: TradeSubmissionResult,
    unknownTitle: string,
    successMessage: string,
  ): TradeSubmissionResult {
    if (result.state === 'unknown') {
      this.deps.onNotification?.(
        unknownTitle,
        result.message ?? 'The outcome is unknown — reconciling. Check Positions before retrying.',
        true,
      );
    } else if (result.state === 'accepted') {
      this.deps.onNotification?.(successMessage, result.message ?? '', false);
    }
    return result;
  }
}

/**
 * Identity of one order submission, for IN-FLIGHT dedupe only. Every field
 * that distinguishes one order from another participates; two orders that
 * differ in any of them are never merged.
 */
function orderKey(preOrder: PreOrder): string {
  return [
    preOrder.symbol,
    preOrder.side,
    preOrder.type,
    preOrder.qty,
    preOrder.limitPrice ?? '',
    preOrder.stopPrice ?? '',
    preOrder.stopLoss ?? '',
    preOrder.takeProfit ?? '',
  ].join('|');
}

/**
 * One side of the book → library levels, sorted by price ASCENDING as the
 * vendored `DOMData` type requires (the gateway sends bids best-first, i.e.
 * descending). Market-only entries carry liquidity but no real price —
 * offering one as a clickable level would convert "no price" into a
 * limit/stop price, so they are dropped, as is anything non-finite or
 * non-positive after string→number conversion.
 */
function toDomLevels(levels: MarketDepthDto['bids']): DOMLevel[] {
  const out: DOMLevel[] = [];
  for (const level of levels) {
    if (level.market) continue;
    const price = Number(level.price);
    const volume = Number(level.volume);
    if (!Number.isFinite(price) || price <= 0) continue;
    if (!Number.isFinite(volume) || volume <= 0) continue;
    out.push({ price, volume });
  }
  out.sort((a, b) => a.price - b.price);
  return out;
}

// ── model translation ────────────────────────────────────────────────────────

// Brackets are ALWAYS present as keys, carrying `undefined` when cleared.
// The library's positions/orders cache replaces the stored object wholesale,
// and every downstream reader (bracket lines, Account Manager cells) must see
// a cleared bracket as an explicit absence — leaving the key out entirely
// would make the intent depend on undocumented cache semantics, and one
// merge-style consumer anywhere in the pipeline would keep a deleted SL line
// on the chart forever.

export function toLibraryPosition(position: DomainPosition): Position {
  return {
    id: position.id,
    symbol: position.displaySymbol,
    qty: Number(position.volume),
    side: tvSideOf(position.side),
    avgPrice: Number(position.openPrice),
    stopLoss: position.stopLoss !== null ? Number(position.stopLoss) : undefined,
    takeProfit: position.takeProfit !== null ? Number(position.takeProfit) : undefined,
    ...(position.profit !== null ? { profit: Number(position.profit) } : {}),
  } as Position;
}

export function toLibraryOrder(order: TradingOrder): Order {
  return {
    id: order.id,
    symbol: order.displaySymbol,
    qty: Number(order.volume),
    side: tvSideOf(order.side),
    type: tvTypeOf(order.kind),
    status: toLibraryStatus(order.status),
    stopLoss: order.stopLoss !== null ? Number(order.stopLoss) : undefined,
    takeProfit: order.takeProfit !== null ? Number(order.takeProfit) : undefined,
    ...(order.price !== null && order.kind === 'limit' ? { limitPrice: Number(order.price) } : {}),
    ...(order.price !== null && order.kind === 'stop' ? { stopPrice: Number(order.price) } : {}),
    ...(order.filledVolume !== null ? { filledQty: Number(order.filledVolume) } : {}),
    ...(order.createdAt !== null ? { updateTime: order.createdAt } : {}),
  } as Order;
}

// ── bracket orders ───────────────────────────────────────────────────────────

/**
 * Which leg of a bracket pair a synthetic order represents.
 *
 * `sl` is the protective stop, `tp` the profit target. The two are always
 * handled independently: cancelling one must never disturb the other.
 */
export type BracketLeg = 'sl' | 'tp';

/**
 * Separator between a parent id and its leg tag in a synthetic bracket id.
 *
 * MT5 tickets are numeric, so no real order or position id contains this
 * suffix. `parseBracketId` still parses from the END and every caller checks
 * the store for a REAL order first, so even an id that did end in `-sl` would
 * resolve to the real order rather than being mistaken for a bracket.
 */
const BRACKET_ID_SEPARATOR = '-';

/** Synthetic id for one leg of a parent's bracket pair. */
export function bracketId(parentId: string, leg: BracketLeg): string {
  return `${parentId}${BRACKET_ID_SEPARATOR}${leg}`;
}

/**
 * Splits a synthetic bracket id back into its parent and leg, or returns null
 * when the id is not one of ours.
 */
export function parseBracketId(id: string): { parentId: string; leg: BracketLeg } | null {
  for (const leg of ['sl', 'tp'] as const) {
    const suffix = `${BRACKET_ID_SEPARATOR}${leg}`;
    if (id.length > suffix.length && id.endsWith(suffix)) {
      return { parentId: id.slice(0, -suffix.length), leg };
    }
  }
  return null;
}

/**
 * The parent fields a bracket pair is derived from. Positions and pending
 * orders both satisfy this, which is why one synthesiser serves both.
 */
interface BracketParent {
  id: string;
  displaySymbol: string;
  side: DomainPosition['side'];
  volume: DecimalString;
  stopLoss: DecimalString | null;
  takeProfit: DecimalString | null;
}

/**
 * Expands a parent's non-null SL/TP into first-class bracket orders.
 *
 * The library materialises brackets as objects the user can click, right-click
 * and cancel ONLY when they arrive as orders carrying `parentId` +
 * `parentType`; as scalar `stopLoss`/`takeProfit` fields on the parent they are
 * just numbers in a cell. A cleared leg yields no order at all, which is what
 * removes its chart line and its Account Manager row.
 *
 * Both legs are protective, so they sit on the side OPPOSITE the parent: a long
 * is closed by selling. Their qty matches the parent's in full — MT5 brackets
 * are not partial.
 */
function bracketOrdersFor(parent: BracketParent, parentType: number): Order[] {
  const out: Order[] = [];
  const side = tvSideOf(parent.side) === TV_SIDE.Buy ? TV_SIDE.Sell : TV_SIDE.Buy;
  const common = {
    parentId: parent.id,
    parentType,
    symbol: parent.displaySymbol,
    side,
    qty: Number(parent.volume),
    // A bracket on an OPEN POSITION is live — it can trigger now. A bracket on
    // a PENDING order cannot: it only arms if and when its parent fills. Both
    // reported Working, which said the protective stop on an unfilled order was
    // already guarding something. Inactive is the library's own word for an
    // order that exists but is not yet in the market.
    status:
      parentType === TV_PARENT_TYPE.Position ? TV_ORDER_STATUS.Working : TV_ORDER_STATUS.Inactive,
  };

  if (parent.stopLoss !== null) {
    out.push({
      ...common,
      id: bracketId(parent.id, 'sl'),
      type: TV_ORDER_TYPE.Stop,
      stopPrice: Number(parent.stopLoss),
    } as unknown as Order);
  }
  if (parent.takeProfit !== null) {
    out.push({
      ...common,
      id: bracketId(parent.id, 'tp'),
      type: TV_ORDER_TYPE.Limit,
      limitPrice: Number(parent.takeProfit),
    } as unknown as Order);
  }
  return out;
}

/**
 * Every bracket the library should currently know about, from both kinds of
 * parent. A leg keeps its id across a fill (the position inherits the order's
 * ticket), so the two sets must be diffed together or the transfer reads as a
 * disappearance.
 */
function allBrackets(positions: DomainPosition[], orders: TradingOrder[]): Order[] {
  return [...positionBrackets(positions), ...orderBrackets(orders)];
}

/**
 * Every bracket order implied by a set of pending orders.
 *
 * Only WORKING parents contribute. A filled or cancelled pending order has no
 * live brackets of its own — the SL/TP that survive belong to the resulting
 * POSITION, and are emitted under `ParentType.Position` instead. Emitting both
 * would put two chart lines at the same price for one real stop.
 */
export function orderBrackets(orders: TradingOrder[]): Order[] {
  return orders
    .filter((order) => order.status === 'working')
    .flatMap((order) => bracketOrdersFor(order, TV_PARENT_TYPE.Order));
}

/** Every bracket order implied by a set of positions. */
export function positionBrackets(positions: DomainPosition[]): Order[] {
  return positions.flatMap((position) => bracketOrdersFor(position, TV_PARENT_TYPE.Position));
}

/** Domain status → the library's OrderStatus enum. */
function toLibraryStatus(status: TradingOrder['status']): Order['status'] {
  switch (status) {
    case 'canceled':
      return TV_ORDER_STATUS.Canceled as Order['status'];
    case 'filled':
      return TV_ORDER_STATUS.Filled as Order['status'];
    case 'placing':
      return TV_ORDER_STATUS.Placing as Order['status'];
    case 'rejected':
      return TV_ORDER_STATUS.Rejected as Order['status'];
    case 'working':
      return TV_ORDER_STATUS.Working as Order['status'];
    case 'expired':
      return TV_ORDER_STATUS.Inactive as Order['status'];
    default:
      // An ambiguous WebSocket status must NEVER be reported as filled.
      return TV_ORDER_STATUS.Working as Order['status'];
  }
}
