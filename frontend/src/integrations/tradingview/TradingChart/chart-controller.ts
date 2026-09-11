import type {
  IBrokerConnectionAdapterHost,
  IBrokerTerminal,
  IChartingLibraryWidget,
  IDatafeedChartApi,
  IDatafeedQuotesApi,
  IExternalDatafeed,
  IExternalSaveLoadAdapter,
  TradingTerminalFeatureset,
  TradingTerminalWidgetOptions,
} from '../types';

/** The datafeed surface the Trading Platform requires: charts + quotes. */
export type TerminalDatafeed = IDatafeedChartApi & IExternalDatafeed & IDatafeedQuotesApi;
import { loadTradingView, toResolution, toTradingViewTheme } from '../types';

/**
 * Imperative controller around one TradingView widget.
 *
 * The whole point of this class: the widget is created ONCE per chart pane and
 * then driven through method calls. Symbol changes, interval changes, theme
 * changes, sidebar collapses, layout restores, and quote ticks all go through
 * the widget's own API — none of them recreate it.
 *
 * Recreating the widget costs a full iframe reload plus the loss of the user's
 * drawings and studies, which is the single most visible way a trading terminal
 * can feel broken.
 */

export interface ChartControllerOptions {
  container: HTMLElement;
  libraryPath: string;
  symbol: string;
  interval: string;
  theme: 'dark' | 'light';
  timezone: string;
  datafeed: TerminalDatafeed;
  saveLoadAdapter: IExternalSaveLoadAdapter;
  /** Omitted when the account cannot trade — the chart still works. */
  brokerFactory?: (host: IBrokerConnectionAdapterHost) => IBrokerTerminal;
  enableTrading: boolean;
  /** True only when the broker adapter can actually supply fills. */
  supportExecutions?: boolean;
  /**
   * True only when the authenticated gateway reports marketDepth.enabled and
   * this pane has a broker to feed the widget. Off, the library's DOM widget
   * stays in `disabled_features` — a DOM with no data source behind it would
   * render an empty ladder and imply the book itself is empty.
   */
  enableMarketDepth?: boolean;
  /**
   * Whether this broker lets a trader change their own account leverage.
   * Kept in step with the gateway's `leverage` capability.
   */
  enableLeverage?: boolean;
  debug: boolean;
  onReady: (controller: ChartController) => void;
  onSymbolChange?: (symbol: string) => void;
  onIntervalChange?: (interval: string) => void;
  onAutoSave?: () => void;
  /**
   * FATAL only: the widget could not be constructed. The host may replace the
   * pane with an error state on this.
   */
  onError: (error: Error) => void;
  /**
   * A widget CALL failed on an otherwise live chart — a symbol apply, a price
   * reveal, a state load. Diagnostic, never fatal: routing these through
   * `onError` let one failed convenience call take down a chart that was
   * still drawing, and the pane's error card then detached the iframe under a
   * live controller, which turned a single throw into an endless
   * "Cannot read properties of null (reading 'tradingViewApi')" cascade
   * (2026-08-24 wedge report). Defaults to `onError` when absent.
   */
  onNonFatalError?: (error: Error) => void;
  /**
   * Fires when the widget was constructed but `onChartReady` never arrived
   * within the watchdog window. Observed in production: the library can wedge
   * its chart pipeline during init (data loads, quote strip runs, but the
   * series never paints and symbol changes are ignored) — with no exception
   * and no console error. Without this hook the wedge is a silently dead
   * chart; with it, the host can dispose and recreate once.
   */
  onReadyTimeout?: () => void;
  /** Watchdog window for onReadyTimeout. Exposed for tests. */
  readyTimeoutMs?: number;
}

/**
 * How hard the chart is held to the symbol it was last asked for. Rapid
 * switches can interleave inside the library, and a superseded one finishing
 * last leaves the pane labelled with a symbol nobody selected.
 */
const SYMBOL_CONVERGENCE_ATTEMPTS = 4;
const SYMBOL_CONVERGENCE_INTERVAL_MS = 1_500;

const BROKER_HOST_TIMEOUT_MS = 15_000;

/**
 * What a pane is actually showing, judged from its canvases rather than from
 * the data channels feeding it.
 *
 * `blank` is the production wedge: the pane is laid out full-size, history is
 * connected and answering, and every canvas is still sitting at the HTML
 * default backing size because nothing ever painted into it. Keying the alarm
 * off the history channel could never see this — an empty history answer was
 * never the failure mode — so it stayed silent over a genuinely dead pane and
 * fired over a healthy one that had merely been switched quickly.
 */
export type ChartPaintState = 'painted' | 'blank' | 'unknown';

/**
 * How far a canvas's two backing-to-box ratios may differ and still be called
 * correctly sized.
 *
 * A canvas allocated for its box has the SAME ratio in both axes — the device
 * pixel ratio. `clientWidth`/`clientHeight` are rounded to integers, so a small
 * box makes that ratio slightly noisy; a tenth is far wider than the rounding
 * error and far tighter than any wedge.
 */
const CANVAS_RATIO_TOLERANCE = 0.1;

/**
 * The smallest box worth judging. Below this, integer rounding dominates the
 * ratio and the answer means nothing.
 */
const CANVAS_MIN_BOX_PX = 4;

/**
 * How long a constructed widget may take to report ready. First paint on a
 * cold cache with a multi-second history load stays well inside this; a
 * wedge never reports at all, so generosity costs one-off recovery latency
 * only.
 */
const CHART_READY_TIMEOUT_MS = 25_000;

export class ChartController {
  private widget: IChartingLibraryWidget | null = null;
  private disposed = false;
  private chartReady = false;
  /** True once the widget's iframe was found detached; see markDetached. */
  private detached = false;
  private currentSymbol: string;
  /** The symbol most recently ASKED for, which the chart is held to. */
  private desiredSymbol: string | null = null;
  private symbolConvergenceTimer: ReturnType<typeof setInterval> | null = null;
  private currentInterval: string;
  private currentTheme: 'dark' | 'light';
  private readonly options: ChartControllerOptions;

  /**
   * Resolves with the broker host once TradingView hands it over.
   *
   * This mirrors the race protection in the working integration's main.ts:
   * `broker_factory` and `onChartReady` fire in a different order locally than
   * on a server, so anything that needs the host must await this promise
   * instead of assuming it already exists.
   */
  private brokerHostPromise: Promise<IBrokerConnectionAdapterHost> | null = null;
  private brokerHostResolve: ((host: IBrokerConnectionAdapterHost) => void) | null = null;

  /** Undoes the one-pixel perturbation `resize` applies; see there. */
  private resizeRestore: (() => void) | null = null;
  private resizeRestoreTimer: ReturnType<typeof setTimeout> | null = null;

  private constructor(options: ChartControllerOptions) {
    this.options = options;
    this.currentSymbol = options.symbol;
    this.currentInterval = options.interval;
    this.currentTheme = options.theme;
  }

  static async create(options: ChartControllerOptions): Promise<ChartController> {
    const controller = new ChartController(options);
    await controller.initialise();
    return controller;
  }

  private async initialise(): Promise<void> {
    const TradingView = await loadTradingView(this.options.libraryPath);
    if (this.disposed) return;

    if (this.options.enableTrading && this.options.brokerFactory) {
      this.brokerHostPromise = new Promise<IBrokerConnectionAdapterHost>((resolve, reject) => {
        this.brokerHostResolve = resolve;
        setTimeout(
          () => reject(new Error('TradingView broker host was not provided in time')),
          BROKER_HOST_TIMEOUT_MS,
        );
      });
      // The timeout rejection is handled by whoever awaits the host; attach a
      // no-op catch so it is never an unhandled rejection.
      this.brokerHostPromise.catch(() => undefined);
    }

    const disabledFeatures: TradingTerminalFeatureset[] = [
      'header_undo_redo',
      'header_quick_search',
      // Our own header owns fullscreen so it can also toggle our docks.
      'header_fullscreen_button',
      'adaptive_logo',
      // The account manager duplicates our bottom dock; ours is the one that
      // reads from the shared normalised store.
      'open_account_manager',
      // The right widgetbar (Object tree, watchlist, news…) duplicates this
      // terminal's own panels — and its RESTORE is the never-ready wedge's
      // known trigger: a widget booted with that panel persisted open loads
      // all of its data and never fires onChartReady (2026-08-14 production
      // wedge; reproduced repeatedly on 2026-08-24, every wedged boot showing
      // the Object tree restored while clean boots did not). The recovery
      // ladder clears the persisted state, but a wedged widget re-persists it
      // before dying, so the pane re-wedges on every recreate. No panel means
      // no restore, which retires the whole wedge class.
      'right_toolbar',
    ];
    if (!this.options.enableTrading) {
      disabledFeatures.push('trading_account_manager');
    }
    // The built-in DOM is offered only when the authenticated gateway reports
    // the market-depth capability (and this pane has a broker to feed it).
    // The caller waits for capability discovery before constructing this
    // controller, so the value is stable for the widget's lifetime.
    if (!this.options.enableMarketDepth) {
      disabledFeatures.push('dom_widget');
    }

    const widgetOptions: TradingTerminalWidgetOptions = {
      container: this.options.container,
      library_path: this.options.libraryPath,
      symbol: this.options.symbol,
      interval: toResolution(this.options.interval),
      locale: 'en',
      theme: toTradingViewTheme(this.options.theme),
      timezone: this.options.timezone as TradingTerminalWidgetOptions['timezone'],
      datafeed: this.options.datafeed,
      autosize: true,
      debug: this.options.debug,
      disabled_features: disabledFeatures,
      enabled_features: [
        'side_toolbar_in_fullscreen_mode',
        'seconds_resolution',
        // Currency-flag logos in the symbol search, watchlist and legend —
        // the datafeed supplies logo_urls from domain/market/symbol-logos.
        'show_symbol_logos',
        'show_symbol_logo_in_legend',
        // Serve the TradingView bootstrap from its dedicated same-origin page
        // instead of a blob iframe. Production gives only that page the
        // narrowly-scoped inline-script CSP permission the licensed library
        // requires; the application document keeps its strict policy.
        'iframe_loading_same_origin',
      ],
      // Hides the save button's "unsaved changes" second label, which
      // renders as a stacked "Save Save" on every untitled layout — and every
      // layout here is untitled, because the workspace store is the real
      // persistence (see public/tv-overrides.css for the full story).
      custom_css_url: '/tv-overrides.css',
      save_load_adapter: this.options.saveLoadAdapter,
      auto_save_delay: 3,
      load_last_chart: false,
      ...(this.options.enableTrading && this.options.brokerFactory
        ? {
            broker_factory: (host: IBrokerConnectionAdapterHost) => {
              this.brokerHostResolve?.(host);
              return this.options.brokerFactory!(host);
            },
            broker_config: {
              configFlags: {
                supportPositions: true,
                supportClosePosition: true,
                supportOrderBrackets: true,
                supportPositionBrackets: true,
                // The library renders its Qty input only with this on. This
                // server cannot resize a pending order in place, so a changed
                // qty is routed to a confirmed cancel-and-replace in the
                // adapter rather than sent as a modify — which MT5 would
                // accept, apply the rest of, and silently drop the size from.
                // Off, the field was simply absent with no explanation, and a
                // trader's only recourse was to work out cancel-and-replace
                // for themselves (2026-08-21 QA, blocker).
                supportEditAmount: true,
                // Kept in step with whether the adapter can actually supply
                // fills; advertising arrows with no data behind them leaves
                // the trader wondering why their trades never appear.
                supportExecutions: this.options.supportExecutions ?? false,
                supportMultiposition: true,
                // MT5 via this gateway has no native reverse; offering it would
                // produce an action the backend cannot honour.
                supportReversePosition: false,
                supportPartialClosePosition: true,
                supportModifyOrderPrice: true,
                // Lets the DOM widget request depth through subscribeDOM.
                // Kept in step with the market-depth capability, exactly like
                // supportExecutions above.
                supportLevel2Data: this.options.enableMarketDepth ?? false,
                // `supportLeverage` tells the library leverage exists on this
                // account, which is what its margin arithmetic needs. Kept in
                // step with the gateway capability, like depth and executions.
                supportLeverage: this.options.enableLeverage ?? false,
                // Its BUTTON stays off deliberately, so the app's own dialog is
                // the single place leverage changes. The library's dialog is a
                // generic one: it interpolates presets across a min/max range
                // (offering x125/x250/x375, which this broker refuses), its
                // input cannot be focused so no other value can be typed, its
                // validation message renders screen-reader-only, and it appears
                // on the Market tab alone. Worst of all it writes without
                // telling the app, so the panel kept showing the old value over
                // an account that had really changed — a trader reading 1:100
                // while margined at 1:500. Two controls where one is wrong is
                // worse than one that is right.
                supportLeverageButton: false,
              },
            },
            debug_broker: this.options.debug ? ('normal' as const) : undefined,
          }
        : {}),
    };

    try {
      this.widget = new TradingView.widget(widgetOptions);
    } catch (error) {
      this.options.onError(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    // Ready watchdog: a wedge inside the library is invisible from out here —
    // no throw, no console error, just a chart that never paints. If ready
    // does not arrive in time, hand the decision to the host.
    const readyWatchdog = setTimeout(() => {
      if (this.disposed || this.chartReady) return;
      this.options.onReadyTimeout?.();
    }, this.options.readyTimeoutMs ?? CHART_READY_TIMEOUT_MS);

    this.widget.onChartReady(() => {
      clearTimeout(readyWatchdog);
      if (this.disposed) return;
      this.chartReady = true;
      this.attachChartListeners();
      this.options.onReady(this);
    });
  }

  private attachChartListeners(): void {
    const widget = this.widget;
    if (!widget) return;

    try {
      const chart = widget.activeChart();

      // Report symbol/interval changes made from INSIDE the chart (the symbol
      // search, a keyboard shortcut) so our workspace stays in step.
      chart.onSymbolChanged().subscribe(null, () => {
        const symbol = chart.symbol();
        if (symbol === this.currentSymbol) return;
        this.currentSymbol = symbol;
        this.options.onSymbolChange?.(symbol);
      });

      chart.onIntervalChanged().subscribe(null, (interval) => {
        if (interval === this.currentInterval) return;
        this.currentInterval = interval;
        this.options.onIntervalChange?.(String(interval));
      });

      widget.subscribe('onAutoSaveNeeded', () => this.options.onAutoSave?.());
    } catch (error) {
      this.reportNonFatal(error);
    }
  }

  /** Awaits the broker host, or null when trading is disabled for this chart. */
  brokerHost(): Promise<IBrokerConnectionAdapterHost> | null {
    return this.brokerHostPromise;
  }

  /**
   * Whether the widget's iframe has been torn out of the document while this
   * controller still thinks it owns it. That happens when the pane unmounts
   * the container without disposing first — every widget method then reads
   * `contentWindow.tradingViewApi` off a null contentWindow. Detection here is
   * what turns that from a repeating cascade into one diagnostic and a set of
   * no-ops.
   */
  private widgetDetached(): boolean {
    if (this.detached) return true;
    try {
      const iframe = this.options.container.querySelector('iframe');
      return iframe !== null && iframe.contentWindow === null;
    } catch {
      return false;
    }
  }

  /** All method-level preconditions in one place. False means "do nothing". */
  private usable(): boolean {
    if (!this.widget || this.disposed) return false;
    if (this.widgetDetached()) {
      this.markDetached(
        new Error('The TradingView iframe is no longer in the document; chart calls are ignored.'),
      );
      return false;
    }
    return true;
  }

  private markDetached(cause: Error): void {
    if (this.detached) return;
    this.detached = true;
    this.stopSymbolConvergence();
    // The widget object now only leads to the null contentWindow; drop it so
    // every guard short-circuits instead of re-throwing on a timer.
    this.widget = null;
    this.reportNonFatal(cause, /* alreadyDetached */ true);
  }

  private static isDetachmentError(error: Error): boolean {
    return /tradingViewApi|contentWindow/.test(error.message);
  }

  /**
   * Routes a widget-call failure to the diagnostic channel — and collapses
   * the detached-iframe signature into the one-shot detached state instead of
   * reporting it once per timer tick.
   */
  private reportNonFatal(error: unknown, alreadyDetached = false): void {
    const err = error instanceof Error ? error : new Error(String(error));
    if (!alreadyDetached && ChartController.isDetachmentError(err)) {
      this.markDetached(err);
      return;
    }
    (this.options.onNonFatalError ?? this.options.onError)(err);
  }

  get isReady(): boolean {
    return this.widget !== null && !this.disposed;
  }

  setSymbol(symbol: string): void {
    if (!this.usable()) return;
    this.desiredSymbol = symbol;

    // Judged against what the chart is ACTUALLY plotting, not against the last
    // value we cached. The two drift apart precisely when it matters: the
    // library reports a symbol change, we record it, and then the swap does
    // not complete — after which a cached-equality guard makes every later
    // attempt, including the trader's own retry, a no-op.
    if ((this.renderedSymbol() ?? this.currentSymbol) === symbol) {
      this.currentSymbol = symbol;
      this.stopSymbolConvergence();
      return;
    }
    this.currentSymbol = symbol;
    this.applySymbol(symbol);
    // Switches issued faster than the library settles them can interleave, and
    // a superseded one finishing last leaves the chart labelled with a symbol
    // nobody asked for. Rather than trusting the last call to win, the
    // intended symbol is re-asserted until the chart agrees.
    this.startSymbolConvergence();
  }

  private applySymbol(symbol: string): void {
    if (!this.usable()) return;
    try {
      this.widget?.activeChart().setSymbol(symbol);
    } catch (error) {
      this.reportNonFatal(error);
    }
  }

  private startSymbolConvergence(): void {
    this.stopSymbolConvergence();
    let attempts = 0;
    this.symbolConvergenceTimer = setInterval(() => {
      attempts += 1;
      const desired = this.desiredSymbol;
      if (!this.usable() || desired === null || attempts > SYMBOL_CONVERGENCE_ATTEMPTS) {
        this.stopSymbolConvergence();
        return;
      }
      if (this.renderedSymbol() === desired) {
        this.stopSymbolConvergence();
        return;
      }
      this.applySymbol(desired);
    }, SYMBOL_CONVERGENCE_INTERVAL_MS);
  }

  private stopSymbolConvergence(): void {
    if (this.symbolConvergenceTimer !== null) {
      clearInterval(this.symbolConvergenceTimer);
      this.symbolConvergenceTimer = null;
    }
  }

  /**
   * Makes room on the price scale for a price that would otherwise be off
   * screen, and reports whether it had to.
   *
   * A 1-minute FX chart routinely shows four or five pips, so an order placed
   * even a few pips away has its line drawn outside the visible range: nothing
   * on the chart says the order exists, which reads exactly like the line
   * failing to draw. Called when an order APPEARS, so it follows the trader's
   * own action rather than fighting a zoom they chose.
   */
  revealPrice(price: number): boolean {
    if (!this.usable() || !Number.isFinite(price) || price <= 0) return false;
    try {
      const scale = this.widget!.activeChart().getPanes()[0]?.getMainSourcePriceScale();
      const range = scale?.getVisiblePriceRange();
      if (!scale || !range) return false;

      const low = Math.min(range.from, range.to);
      const high = Math.max(range.from, range.to);
      if (price >= low && price <= high) return false;

      // A tenth of the widened span as breathing room, so the line lands
      // inside the pane rather than exactly on its edge.
      const padding = (Math.max(high, price) - Math.min(low, price)) * 0.1;
      scale.setVisiblePriceRange({
        from: Math.min(low, price) - padding,
        to: Math.max(high, price) + padding,
      });
      return true;
    } catch (error) {
      // Never let a convenience take the chart down.
      this.reportNonFatal(error);
      return false;
    }
  }

  /** The symbol the chart is actually PLOTTING right now, not the one we asked for. */
  renderedSymbol(): string | null {
    if (!this.widget || this.disposed) return null;
    try {
      return this.widget.activeChart().symbol();
    } catch {
      return null;
    }
  }

  /**
   * Whether the main series currently HOLDS any bars, asked of the library
   * itself rather than inferred from what the datafeed handed over.
   *
   * The two can disagree: on the 2026-08-24 empty-chart regression report,
   * history requests succeeded and bars were delivered to the library, yet
   * the OHLC legend read ∅ indefinitely — the series never applied them. The
   * canvas paint check cannot catch that state (gridlines and price scale
   * paint fine over an empty series), so the delivered-vs-applied watchdog in
   * ChartWorkspace needs this direct answer. 'unknown' when the widget cannot
   * be asked — never treated as empty, because a recovery tears the widget
   * down and must only fire on evidence.
   */
  async seriesState(): Promise<'data' | 'empty' | 'unknown'> {
    if (!this.widget || !this.chartReady || this.disposed || this.widgetDetached()) {
      return 'unknown';
    }
    try {
      const exported = await this.widget.activeChart().exportData({
        includeTime: true,
        includedStudies: [],
      });
      return exported.data.length > 0 ? 'data' : 'empty';
    } catch {
      return 'unknown';
    }
  }

  /**
   * Whether this pane has actually PAINTED, judged from its canvas backing
   * stores.
   *
   * The library allocates each canvas's backing store from its laid-out box
   * before it draws anything into it, so a canvas whose backing is smaller
   * than its box has had nothing rendered to it and never will — the library's
   * own autosize observer has already taken its measurement and nobody will
   * ask it to measure again. On the wedged loads every canvas sat at the
   * 300x150 HTML default inside a 408x459 pane. That is the signal a stall
   * detector needs: true of the wedged pane, false of a chart that is merely
   * waiting for bars.
   *
   * `unknown` is returned generously — before the iframe exists, before the
   * dock has given the pane a box, and whenever the document cannot be read.
   * A detector must never escalate on "I could not tell".
   */
  paintState(): ChartPaintState {
    if (!this.widget || this.disposed) return 'unknown';
    let canvases: HTMLCanvasElement[];
    try {
      const root = this.chartRoot();
      if (!root) return 'unknown';
      canvases = Array.from(root.querySelectorAll('canvas'));
    } catch {
      // A torn-down iframe throws on access; that is not evidence of a wedge.
      return 'unknown';
    }
    if (canvases.length === 0) return 'unknown';

    let laidOut = 0;
    let sized = 0;
    for (const canvas of canvases) {
      const { clientWidth, clientHeight } = canvas;
      // A zero box is the dock still laying out — nothing to judge yet.
      if (clientWidth <= 0 || clientHeight <= 0) continue;
      if (clientWidth < CANVAS_MIN_BOX_PX || clientHeight < CANVAS_MIN_BOX_PX) continue;
      laidOut += 1;
      // A canvas allocated for its box has the same backing-to-box ratio in
      // both axes — the device pixel ratio the library rendered at. One that
      // was never allocated keeps the 300x150 default, whose two ratios agree
      // only by coincidence.
      //
      // Asking whether the backing merely COVERS the box is not enough, and
      // was wrong on the real thing: this pane's smallest canvas is laid out
      // at 66x28, which a 300x150 default covers comfortably — so on a
      // genuinely wedged pane that canvas read as healthy, one healthy canvas
      // was enough to call the pane painted, and the alarm stayed silent
      // exactly where it was needed. Comparing the ratios instead separates
      // them cleanly at any device pixel ratio, including the small pane that
      // really does measure 300x150.
      const ratioX = canvas.width / clientWidth;
      const ratioY = canvas.height / clientHeight;
      const consistent =
        Math.abs(ratioX - ratioY) <= CANVAS_RATIO_TOLERANCE * Math.max(ratioX, ratioY);
      if (consistent && ratioX >= 1 - CANVAS_RATIO_TOLERANCE) sized += 1;
    }

    if (laidOut === 0) return 'unknown';
    return sized === 0 ? 'blank' : 'painted';
  }

  /**
   * Where this pane's canvases live: the library's same-origin iframe, or the
   * container itself in the tests and hosts that render without one. Scoped to
   * the pane either way, so another widget's canvas can never answer for it.
   */
  private chartRoot(): ParentNode | null {
    const iframe = this.options.container.querySelector('iframe');
    if (!iframe) return this.options.container;
    // `iframe_loading_same_origin` is enabled, so this is readable; a
    // cross-origin host throws and is reported as unknown by the caller.
    return iframe.contentDocument;
  }

  setInterval(interval: string): void {
    if (!this.usable() || interval === this.currentInterval) return;
    this.currentInterval = interval;
    try {
      this.widget!.activeChart().setResolution(toResolution(interval));
    } catch (error) {
      this.reportNonFatal(error);
    }
  }

  setTheme(theme: 'dark' | 'light'): void {
    if (!this.widget || this.disposed || theme === this.currentTheme) return;
    this.currentTheme = theme;
    // changeTheme is asynchronous and rejects if called before ready; a theme
    // toggle must never be able to take down the chart.
    void this.widget.changeTheme(toTradingViewTheme(theme)).catch(() => undefined);
  }

  /**
   * Tells the library its box has changed, for a caller that already knows it
   * has — a dock resize, a collapsed sidebar.
   *
   * Deliberately does NOT perturb the container. This is what the pane's own
   * ResizeObserver calls, and perturbing from there would be a feedback loop:
   * the perturbation changes the box, the observer sees the change and calls
   * back, and the pane thrashes its own layout forever.
   */
  resize(): void {
    if (!this.widget || this.disposed) return;
    try {
      window.dispatchEvent(new Event('resize'));
    } catch {
      /* jsdom and other non-browser hosts */
    }
  }

  /**
   * Forces the library to re-measure a container it has ALREADY measured, and
   * measured wrongly.
   *
   * A window resize event cannot do this. The widget is created with
   * `autosize`, so the library observes the CONTAINER, and a window event
   * leaves that box exactly as it was: an observer that sees no change reports
   * none, and the stale measurement stands — which is the entire reason this
   * is ever called. The box is therefore perturbed by a pixel and put back,
   * which an autosize widget cannot ignore, and which is what the manual
   * workaround (clicking another watchlist symbol, re-laying the pane) was
   * really doing.
   *
   * Only for the recovery paths. Calling it from anything that runs on layout
   * changes would loop, which is why `resize` above exists separately.
   */
  forceRemeasure(): void {
    if (!this.usable()) return;
    this.resize();

    const container = this.options.container;
    if (!container.style || this.resizeRestore !== null) return;
    try {
      const previous = container.style.width;
      this.resizeRestore = () => {
        container.style.width = previous;
        this.resizeRestore = null;
      };
      container.style.width = 'calc(100% - 1px)';
      // A timer, not requestAnimationFrame: rAF is suspended in a background
      // tab, which would leave the container parked a pixel narrow.
      this.resizeRestoreTimer = setTimeout(() => this.resizeRestore?.(), 60);
    } catch {
      this.resizeRestore = null;
    }
  }

  async screenshot(): Promise<string | null> {
    if (!this.usable()) return null;
    try {
      const canvas = await this.widget!.takeClientScreenshot();
      return canvas.toDataURL('image/png');
    } catch {
      return null;
    }
  }

  async saveChartState(): Promise<unknown | null> {
    if (!this.usable()) return null;
    return new Promise((resolve) => {
      try {
        this.widget!.save((state) => resolve(state));
      } catch {
        resolve(null);
      }
    });
  }

  loadChartState(state: unknown): void {
    if (!this.usable() || !state) return;
    try {
      this.widget!.load(state as Parameters<IChartingLibraryWidget['load']>[0]);
    } catch (error) {
      this.reportNonFatal(error);
    }
  }

  /** Destroys the widget. After this the controller is unusable. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopSymbolConvergence();
    // Put the container back before letting go of it: a pane torn down
    // mid-perturbation would leave the next widget a pixel narrow forever.
    if (this.resizeRestoreTimer !== null) clearTimeout(this.resizeRestoreTimer);
    this.resizeRestore?.();
    this.brokerHostResolve = null;
    try {
      this.widget?.remove();
    } catch {
      // The library throws if it was already torn down by an iframe unload.
    }
    this.widget = null;
  }
}
