import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { env } from '@/app/config/env';
import { reportError, useServices } from '@/app/providers/services';
import { cn } from '@/components/ui/cn';
import { ErrorState } from '@/components/ui/primitives';
import { useSessionStore } from '@/stores/session-store';
import { useWorkspace } from '@/workspace/layout/workspace-store';
import { GatewayBrokerAdapter } from '../broker/broker-adapter';
import { warnOnce } from '../diagnostics';
import { executionsCursorSeconds, toLibraryExecutions } from '../broker/executions';
import { useCapabilities } from '@/stores/capabilities-store';
import { GatewayDatafeed } from '../datafeed/gateway-datafeed';
import { createSaveLoadAdapter } from '../persistence/save-load-adapter';
import type { IBrokerTerminal } from '../types';
import { TV_NOTIFICATION_TYPE } from '../types';
import { ChartController } from './chart-controller';
import { useTradingStore } from '@/stores/trading-store';
import { retireLegacyChartQuantities } from '@/integrations/tradingview/retire-legacy-quantities';

/**
 * The centre region: one or more TradingView chart panes.
 *
 * The critical property, enforced by the dependency arrays below: each
 * `TradingChartPane` creates its widget ONCE. Symbol, interval, and theme
 * changes are pushed through the controller's methods. Nothing about a layout
 * change, a dock resize, or a quote tick can cause a remount.
 */

/** How long a pane may render nothing before it says so and offers a retry. */
const CHART_STALL_TIMEOUT_MS = 20_000;

/**
 * How often a pane checks what it is actually showing, and how long an
 * unpainted pane is given before it is nudged to re-measure.
 *
 * The nudge is free and fixes the common cause (a pane laid out at zero whose
 * measurement the library already took), so it comes early, repeatedly, and
 * long before the trader is told anything. Only when every free attempt has
 * failed does the pane escalate to the recovery ladder, where each rung costs
 * the trader something they would rather keep.
 */
/**
 * The stored keys under a prefix, read through the standard Storage API.
 *
 * `Object.keys(localStorage)` happens to work in a browser because Storage
 * exposes its entries as own properties, but that is incidental — the portable
 * API is `length` and `key(i)`. Collected before anything is removed, since
 * deleting during an indexed walk shifts every later index and silently skips
 * half the keys.
 */
function storedKeys(prefix: string): string[] {
  const keys: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key !== null && key.startsWith(prefix)) keys.push(key);
    }
  } catch {
    /* storage can be blocked entirely */
  }
  return keys;
}

const CHART_PAINT_POLL_MS = 1_000;
const CHART_PAINT_NUDGE_MS = 2_500;
const CHART_PAINT_NUDGE_ATTEMPTS = 3;
/**
 * How long after the LAST delivered history page the series must have applied
 * it. Application is normally sub-second; the margin covers a slow machine
 * mid-boot. Short enough that the recovery lands well inside the ~10 s a
 * trader plausibly waits before distrusting the pane (2026-08-24 empty-chart
 * regression: bars delivered at 1.7 s, pane blank for 82+ s with no recovery).
 */
const SERIES_APPLY_CHECK_MS = 8_000;

export function ChartWorkspace() {
  const layout = useWorkspace((s) => s.workspace.chartLayout);
  const panes = useWorkspace((s) => s.workspace.chartPanes);

  if (layout === 'single' || panes.length === 1) {
    const pane = panes[0];
    if (!pane) return null;
    return (
      <div className="h-full min-h-0 bg-[var(--background-primary)]">
        <TradingChartPane
          paneId={pane.id}
          symbol={pane.symbol}
          interval={pane.interval}
          isPrimary
        />
      </div>
    );
  }

  const direction = layout === 'two-horizontal' ? 'vertical' : 'horizontal';

  if (layout === 'two-vertical' || layout === 'two-horizontal') {
    return (
      <PanelGroup direction={direction} className="h-full min-h-0">
        {panes.slice(0, 2).map((pane, index) => (
          <PaneSlot key={pane.id} index={index} direction={direction}>
            <TradingChartPane
              paneId={pane.id}
              symbol={pane.symbol}
              interval={pane.interval}
              isPrimary={index === 0}
            />
          </PaneSlot>
        ))}
      </PanelGroup>
    );
  }

  // Three- and four-chart grids: a vertical group of horizontal rows.
  const rows =
    layout === 'three'
      ? [panes.slice(0, 1), panes.slice(1, 3)]
      : [panes.slice(0, 2), panes.slice(2, 4)];

  return (
    <PanelGroup direction="vertical" className="h-full min-h-0">
      {rows.map((row, rowIndex) => (
        <PaneSlot key={`row-${rowIndex}`} index={rowIndex} direction="vertical">
          <PanelGroup direction="horizontal" className="h-full min-h-0">
            {row.map((pane, index) => (
              <PaneSlot key={pane.id} index={index} direction="horizontal">
                <TradingChartPane
                  paneId={pane.id}
                  symbol={pane.symbol}
                  interval={pane.interval}
                  isPrimary={rowIndex === 0 && index === 0}
                />
              </PaneSlot>
            ))}
          </PanelGroup>
        </PaneSlot>
      ))}
    </PanelGroup>
  );
}

function PaneSlot({
  index,
  direction,
  children,
}: {
  index: number;
  direction: 'horizontal' | 'vertical';
  children: React.ReactNode;
}) {
  return (
    <>
      {index > 0 && (
        <PanelResizeHandle
          className={cn(
            'shrink-0 bg-[var(--border-default)] transition-colors hover:bg-[var(--brand-primary)]',
            direction === 'horizontal' ? 'w-px cursor-col-resize' : 'h-px cursor-row-resize',
          )}
          aria-label="Resize chart"
        />
      )}
      <Panel minSize={15} className="min-h-0">
        {children}
      </Panel>
    </>
  );
}

interface TradingChartPaneProps {
  paneId: string;
  symbol: string;
  interval: string;
  /** The primary pane owns the broker connection and chart trading. */
  isPrimary: boolean;
}

function TradingChartPane({ paneId, symbol, interval, isPrimary }: TradingChartPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<ChartController | null>(null);
  const brokerRef = useRef<GatewayBrokerAdapter | null>(null);
  const datafeedRef = useRef<GatewayDatafeed | null>(null);

  const [error, setError] = useState<Error | null>(null);
  const [retryToken, setRetryToken] = useState(0);
  // Automatic recoveries attempted for a chart that never became ready.
  // One self-heal, then the visible error state — never a recreate loop.
  const readyRecoveriesRef = useRef(0);
  // True while any history request is in flight. A 5y preset is a
  // multi-second load, and without this the half-populated chart reads as a
  // data gap rather than as loading (2026-08-13 chart report, defect 2).
  const [historyLoading, setHistoryLoading] = useState(false);
  // The symbol whose FIRST history page failed definitively (timeout plus
  // bounded retry, both spent). While set, the pane owes the trader an
  // explicit "unavailable" state — the library's own answer is a silent
  // empty canvas. Cleared by any delivered bars and by a retry.
  const [historyFailed, setHistoryFailed] = useState<string | null>(null);
  // True from widget construction until onChartReady. A first paint can be
  // legitimately slow (cold caches, a long history load), and a silent blank
  // pane is indistinguishable from the dead pane this file spends most of its
  // lines guarding against — say which one it is (2026-08-24 QA, minor).
  const [booting, setBooting] = useState(true);

  const services = useServices();
  const config = env();

  const theme = useWorkspace((s) => s.workspace.theme);
  const setActiveSymbol = useWorkspace((s) => s.setActiveSymbol);
  const setActiveInterval = useWorkspace((s) => s.setActiveInterval);
  const setPaneSymbol = useWorkspace((s) => s.setPaneSymbol);
  const setPaneChartState = useWorkspace((s) => s.setPaneChartState);

  const resolvedTheme = useResolvedTheme(theme);
  const themeRef = useRef(resolvedTheme);
  themeRef.current = resolvedTheme;

  // Capability discovery starts at "nothing optional available" and resolves
  // once per session. The widget must not be created before the answer
  // arrives: features like the DOM are burned into `disabled_features` at
  // construction, and a chart initialised against the not-yet-loaded defaults
  // would keep them off for its whole lifetime. `loaded` flips false→true
  // exactly once per session, so this delays creation; it does not recreate
  // the iframe on ordinary updates.
  const capabilitiesLoaded = useCapabilities((s) => s.loaded);

  // Symbol/interval/theme are held in refs so the creation effect below can
  // read them WITHOUT depending on them — an ordinary change must drive the
  // live widget, never rebuild it.
  //
  // They track the current value rather than freezing the first one. A frozen
  // capture was right for the pane's first boot and wrong for every recreation
  // after it: a recovery recreate rebuilt the widget on the symbol the pane had
  // booted with, so the ticket said GBPUSD while the series, OHLC and price
  // scale were still EURUSD, and it stayed one symbol behind on every switch
  // after that (2026-08-20 retest, BUG-C).
  const symbolRef = useRef(symbol);
  symbolRef.current = symbol;
  const intervalRef = useRef(interval);
  intervalRef.current = interval;

  const saveLoadAdapter = useMemo(() => createSaveLoadAdapter(), []);

  /**
   * The last symbol bars arrived for. Diagnostic context only: whether the
   * data reached the pane is no longer allowed to decide whether the pane has
   * drawn, but it is the first thing anyone diagnosing a wedge wants to know —
   * "history answered for EURUSD and nothing was painted" took a session of
   * manual work to establish the first time.
   */
  const barsForSymbolRef = useRef<string | null>(null);

  /**
   * The recovery ladder for a pane that is not working, whichever way it
   * failed: never reported ready, or reported ready and then painted nothing.
   *
   * One self-heal, then a harder one, then the visible error state — never a
   * recreate loop. Each rung is strictly costlier than the last, so the cheap
   * fix is always tried first and the trader's saved layout is only sacrificed
   * when nothing else has worked.
   */
  const escalateRecovery = useCallback(
    (reason: string, description: string) => {
      warnOnce(`chart-recover-${reason}`, `${description}; recovering`, {
        paneId,
        recoveries: readyRecoveriesRef.current,
        barsLastArrivedFor: barsForSymbolRef.current,
      });
      if (readyRecoveriesRef.current >= 2) {
        setError(new Error('The chart did not finish initialising.'));
        return;
      }
      readyRecoveriesRef.current += 1;
      try {
        // The library's OWN persistence keys (verified against its settings
        // storage). Only touched on a wedged boot — a healthy session never
        // loses its panel state.
        localStorage.setItem('tradingview.trading.tradingPanelOpened', 'false');

        // And the RIGHT-HAND panel, which is what the evidence actually points
        // at: both wedged loads in the 2026-08-20 retest came back with the
        // Object tree widget panel restored open, and the one clean load did
        // not. That panel is persisted under `tradingview.widgetbar.*`, which
        // this rung previously left alone — it disarmed the bottom trading
        // panel and hoped, then only reached the widgetbar on the next rung,
        // which deletes the trader's drawings along with it. Forgetting which
        // side panel was open is a far cheaper thing to spend.
        for (const key of storedKeys('tradingview.widgetbar')) localStorage.removeItem(key);

        // Second attempt: drop the library's SAVED CHART STATE too. A stale
        // one wedges it outright — the pane lays out, the datafeed answers,
        // and nothing is ever painted; every canvas sits at its 300×150
        // default inside a full-size pane. Confirmed against the live
        // terminal, where clearing these keys turned a chart that had been
        // blank for minutes into a drawn one immediately. Costly enough
        // (saved layout and drawings go with it) to be the SECOND resort,
        // never the first.
        if (readyRecoveriesRef.current === 2) {
          for (const key of storedKeys('tradingview.')) localStorage.removeItem(key);
          warnOnce('chart-state-cleared', 'cleared saved chart state to recover a wedged chart', {
            paneId,
          });
        }
      } catch {
        /* storage can be blocked; the retry is still worth attempting */
      }
      setRetryToken((token) => token + 1);
    },
    [paneId],
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !capabilitiesLoaded) return;

    let cancelled = false;
    // Arms after each bars delivery; see onBarsDelivered below.
    let seriesCheckTimer: ReturnType<typeof setTimeout> | null = null;
    setBooting(true);

    // Before the widget exists, so nothing can restore what it removes.
    retireLegacyChartQuantities();

    const datafeed = new GatewayDatafeed({
      market: services.market,
      pool: services.pool,
      getSuffixPolicy: () => useSessionStore.getState().suffixPolicy,
      // The chart is usually the first thing to resolve a symbol; sharing the
      // record means the order ticket and Broker API get real contract limits.
      onSymbolResolved: (symbol) => services.symbolCache.set(symbol.displayName, symbol),
      onError: (scope, err) => reportError(scope, err),
      onHistoryLoading: (pending) => {
        if (!cancelled) setHistoryLoading(pending > 0);
      },
      // Recorded for the diagnostic log ONLY. Bars are no longer allowed to
      // arbitrate whether the pane has drawn: on the wedged loads history was
      // connected and answering perfectly, and the pane still painted nothing
      // (2026-08-20 retest, BUG-A). What is on the canvas decides that now.
      onBarsDelivered: (delivered, count) => {
        if (count <= 0) return;
        barsForSymbolRef.current = delivered;
        // Bars arriving refutes any standing "data unavailable" verdict —
        // a later page or a retried symbol switch can succeed on its own.
        if (!cancelled) setHistoryFailed(null);
        // Delivered is not applied. On the 2026-08-24 empty-chart regression
        // (~2 of 8 cold loads) every history request succeeded, bars were
        // handed to the library, and the series still stayed permanently
        // empty — no error, no further network, only a blank pane a trader
        // can misread as a dead market. So each delivery arms a check: if
        // the series the LIBRARY reports for this symbol is still empty well
        // after the bars went in, recover through the same bounded ladder a
        // wedged boot uses. Re-armed (not stacked) per delivery, so a long
        // pagination run checks once, after its last page.
        if (seriesCheckTimer !== null) clearTimeout(seriesCheckTimer);
        const verifySeriesApplied = () => {
          seriesCheckTimer = null;
          if (cancelled) return;
          // A HIDDEN tab legitimately defers applying bars (the library
          // throttles under a hidden document; confirmed live 2026-08-24:
          // a "blank" hidden pane filled instantly on first interaction with
          // zero network). Judging it empty would tear down a healthy widget
          // and burn the recovery budget — re-check when the tab is seen.
          if (document.visibilityState !== 'visible') {
            seriesCheckTimer = setTimeout(verifySeriesApplied, SERIES_APPLY_CHECK_MS);
            return;
          }
          const controller = controllerRef.current;
          if (!controller || controller.renderedSymbol() !== delivered) return;
          void controller.seriesState().then((state) => {
            if (cancelled || state !== 'empty') return;
            if (document.visibilityState !== 'visible') return;
            if (controllerRef.current?.renderedSymbol() !== delivered) return;
            escalateRecovery(
              'series-dropped',
              'history bars were delivered but the series stayed empty',
            );
          });
        };
        seriesCheckTimer = setTimeout(verifySeriesApplied, SERIES_APPLY_CHECK_MS);
      },
      onFirstPageFailed: (failedSymbol) => {
        if (!cancelled) setHistoryFailed(failedSymbol);
      },
    });
    datafeedRef.current = datafeed;

    /** Cached lookup, fetching once if the chart has not resolved it yet. */
    const resolveSymbol = async (displaySymbol: string) => {
      const cached = services.symbolCache.get(displaySymbol);
      if (cached) return cached;

      const policy = useSessionStore.getState().suffixPolicy;
      const fetched = await services.market.symbolInfo(policy.toGateway(displaySymbol), policy);
      if (fetched) services.symbolCache.set(fetched.displayName, fetched);
      return fetched ?? undefined;
    };

    const enableTrading = isPrimary && !useSessionStore.getState().readOnly;

    // Read once, after discovery has finished (this effect waits for it), so
    // the value is stable for the widget's lifetime. The DOM needs both the
    // gateway capability and a broker adapter to feed it.
    const marketDepth = useCapabilities.getState().capabilities.marketDepth;
    const marketDepthEnabled = marketDepth.enabled;
    const enableMarketDepth = enableTrading && marketDepthEnabled;

    // Leverage rewrites a property of the trading ACCOUNT, so the control only
    // exists where the gateway says the broker permits it.
    const enableLeverage =
      enableTrading && useCapabilities.getState().capabilities.leverage.enabled;

    // These values are burned into the widget at construction; when either
    // gate is closed, say so once, with the inputs — the widget itself renders
    // no explanation. Booleans and a capability reason only; never account
    // data.
    if (isPrimary && !enableTrading) {
      warnOnce('chart-trading-disabled', 'chart trading disabled at widget creation', {
        isPrimary,
        readOnly: useSessionStore.getState().readOnly,
      });
    }
    if (isPrimary && enableTrading && !enableMarketDepth) {
      warnOnce('chart-dom-disabled', 'built-in DOM disabled at widget creation', {
        marketDepthEnabled,
        capabilityReason: marketDepth.reason,
      });
    }

    // Only offered when the gateway reports per-fill executions. Leaving the
    // dep undefined is what makes `supportExecutions` false, so the chart never
    // advertises arrows it has no data for.
    const executionsEnabled = useCapabilities.getState().capabilities.executions.enabled;
    const loadExecutions = executionsEnabled
      ? async () => {
          const login = useSessionStore.getState().activeLogin;
          if (!login) return [];
          const policy = useSessionStore.getState().suffixPolicy;
          const dtos = await services.features.executionsSince(login, executionsCursorSeconds());
          return toLibraryExecutions(dtos, policy);
        }
      : undefined;

    void ChartController.create({
      container,
      libraryPath: config.tradingViewLibraryPath,
      symbol: symbolRef.current,
      interval: intervalRef.current,
      theme: themeRef.current,
      timezone: config.defaultTimezone,
      datafeed,
      saveLoadAdapter,
      enableTrading,
      supportExecutions: loadExecutions !== undefined,
      enableMarketDepth,
      enableLeverage,
      debug: !config.isProduction,
      brokerFactory: enableTrading
        ? (host) => {
            const adapter = new GatewayBrokerAdapter({
              host,
              trading: services.tradingService,
              resolveSymbol,
              loadExecutions,
              // Only wired when the gateway serves depth; without it the
              // adapter's subscribeDOM stays inert.
              loadMarketDepth: enableMarketDepth
                ? (gatewaySymbol, signal) => services.market.marketDepth(gatewaySymbol, signal)
                : undefined,
              onDepthError: (err) => reportError('market-depth', err),
              leverage: enableLeverage
                ? {
                    get: (login) => services.trading.leverage(login),
                    set: (login, value) => services.trading.setLeverage(login, value),
                  }
                : undefined,
              onNotification: (title, message, isError) => {
                host.showNotification(
                  title,
                  message,
                  isError ? TV_NOTIFICATION_TYPE.Error : TV_NOTIFICATION_TYPE.Success,
                );
              },
            });
            brokerRef.current = adapter;
            return adapter as unknown as IBrokerTerminal;
          }
        : undefined,
      onReady: (controller) => {
        if (cancelled) {
          controller.dispose();
          return;
        }
        controllerRef.current = controller;
        setError(null);
        setBooting(false);
        // A widget is built from the refs above, but a recreate can finish
        // after the trader has already moved on — and the effects that push
        // symbol/interval/theme only fire when those values CHANGE, so a fresh
        // widget would never be told about a selection made while it was being
        // rebuilt. Reconciling here is what stops a recovered pane plotting
        // the instrument it happened to boot with.
        controller.setSymbol(symbolRef.current);
        controller.setInterval(intervalRef.current);
        controller.setTheme(themeRef.current);
      },
      onSymbolChange: (nextSymbol) => {
        // The user changed symbol from inside the chart; mirror it outward so
        // the order ticket and watchlist follow.
        if (isPrimary) setActiveSymbol(nextSymbol);
        else setPaneSymbol(paneId, nextSymbol);
      },
      onIntervalChange: (nextInterval) => {
        if (isPrimary) setActiveInterval(nextInterval);
      },
      onAutoSave: () => {
        void controllerRef.current?.saveChartState().then((state) => {
          if (state) setPaneChartState(paneId, state);
        });
      },
      onError: (err) => {
        reportError('tradingview', err);
        setError(err);
      },
      // A failed widget CALL on a live chart is a diagnostic, not a death:
      // routing these into `setError` replaced a still-drawing chart with the
      // error card, which detached the iframe under a live controller and
      // turned one throw into the endless null-`tradingViewApi` cascade
      // (2026-08-24 wedge report).
      onNonFatalError: (err) => {
        reportError('tradingview', err);
      },
      onReadyTimeout: () => {
        if (cancelled) return;
        // Production wedge (2026-08-14): a widget booted with the library's
        // trading panel restored open could load its data yet never reach
        // onChartReady — silently dead chart, no error anywhere.
        escalateRecovery('never-ready', 'chart never became ready');
      },
    }).catch((err: unknown) => {
      const asError = err instanceof Error ? err : new Error(String(err));
      reportError('tradingview', asError);
      if (!cancelled) setError(asError);
    });

    return () => {
      cancelled = true;
      if (seriesCheckTimer !== null) clearTimeout(seriesCheckTimer);
      brokerRef.current?.dispose();
      brokerRef.current = null;
      controllerRef.current?.dispose();
      controllerRef.current = null;
      datafeedRef.current?.dispose();
      datafeedRef.current = null;
    };
    // Intentionally minimal: this effect creates the widget and must not re-run
    // for symbol, interval, or theme. `retryToken` is the explicit escape hatch
    // for a user-initiated retry after a load failure. `capabilitiesLoaded`
    // flips false→true once per session, delaying creation rather than
    // recreating anything.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneId, isPrimary, retryToken, capabilitiesLoaded]);

  // Showing the error card unmounts the container div, which tears the
  // widget's iframe out of the document — but the creation effect above does
  // not re-run on `error`, so its cleanup never fired and the controller,
  // broker and datafeed all stayed live against a dead iframe. Their timers
  // and store subscriptions then called into it forever: the repeating
  // "Cannot read properties of null (reading 'tradingViewApi')" of the
  // 2026-08-24 wedge, surviving until reload. A pane that shows the error
  // card must be DEAD, not undead — dispose everything the moment the card
  // goes up. Dispose is idempotent, so the creation effect's own cleanup
  // running later (on retry) is harmless.
  useEffect(() => {
    if (!error) return;
    brokerRef.current?.dispose();
    brokerRef.current = null;
    controllerRef.current?.dispose();
    controllerRef.current = null;
    datafeedRef.current?.dispose();
    datafeedRef.current = null;
  }, [error]);

  // An account switch changes the symbol SUFFIX, so every stream this datafeed
  // opened now points at the previous account group's instrument. The chart is
  // deliberately not remounted (that would reload the iframe), so the streams
  // are re-pointed in place and the library is told to drop its cached bars.
  const suffix = useSessionStore((s) => s.suffixPolicy.suffix);
  const previousSuffix = useRef(suffix);
  useEffect(() => {
    if (previousSuffix.current === suffix) return;
    previousSuffix.current = suffix;
    datafeedRef.current?.resubscribeForAccountChange();
  }, [suffix]);

  // Drive the live widget instead of recreating it.
  useEffect(() => {
    controllerRef.current?.setSymbol(symbol);
  }, [symbol]);

  useEffect(() => {
    controllerRef.current?.setInterval(interval);
  }, [interval]);

  useEffect(() => {
    controllerRef.current?.setTheme(resolvedTheme);
  }, [resolvedTheme]);

  // A pane that has drawn nothing must not stay blank AND silent. The failure
  // this catches renders no candles, no price scale and no time axis, so there
  // is nothing on screen for a trader to interpret and nothing to act on.
  //
  // It is judged from the CANVAS, which is the only thing that answers the
  // question actually being asked. Every other signal tried here was a proxy
  // for it and was wrong in both directions at once: keyed off history, the
  // alarm stayed silent over a pane whose canvases had never left 300×150
  // while its history channel sat connected and answering, and fired over a
  // fully drawn chart whose bars had merely arrived under a previous symbol
  // (2026-08-20 retest, BUG-A and BUG-B).
  const [stalled, setStalled] = useState(false);
  useEffect(() => {
    // Deliberately NOT cleared here. This effect re-runs as part of the very
    // recovery it triggers, and clearing on the way in would blink the banner
    // off the instant the pane escalated — leaving a still-blank chart silent
    // again. It stands until a poll below sees the pane actually paint, which
    // is also how it self-clears without anyone touching Retry.
    let blankSince: number | null = null;
    let nudges = 0;
    let escalated = false;

    const timer = setInterval(() => {
      // A hidden tab is not a wedged one. Chrome suspends requestAnimationFrame
      // in background tabs and the library paints — and sizes its canvases —
      // inside rAF, so a backgrounded pane is INDISTINGUISHABLE from the
      // production wedge: default-size canvases, empty legend, nothing drawn.
      // It paints the instant the tab is fronted.
      //
      // Escalating on that would be worse than the bug this watchdog exists
      // for: a trader who leaves the terminal in a background tab would come
      // back to a chart that had been torn down, rebuilt, and finally stripped
      // of its saved layout and drawings, none of which was ever wrong.
      // The clock is reset rather than paused, so a pane gets its full grace
      // period from the moment it is actually on screen.
      if (typeof document !== 'undefined' && document.hidden) {
        blankSince = null;
        nudges = 0;
        return;
      }

      const state = controllerRef.current?.paintState() ?? 'unknown';

      // `unknown` is the widget not up yet, or a document that cannot be read.
      // Never escalate on "I could not tell" — the ready watchdog covers a
      // widget that never arrives at all.
      if (state === 'unknown') return;

      if (state === 'painted') {
        blankSince = null;
        nudges = 0;
        setStalled(false);
        return;
      }

      const now = performance.now();
      if (blankSince === null) {
        blankSince = now;
        return;
      }
      const blankFor = now - blankSince;

      // Cheapest rung first, and silent: the usual cause is a pane that was
      // laid out at zero and never asked to measure again, which a re-measure
      // fixes outright. This is the same thing that made clicking another
      // watchlist symbol recover a wedged pane by hand.
      //
      // Tried more than once, and early. A re-measure costs a pixel of layout
      // and nothing else, whereas every rung past it costs the trader
      // something real — a rebuilt chart, then their saved panel state, then
      // their drawings. There is no reason to spend those while the free
      // remedy still has attempts left.
      if (nudges < CHART_PAINT_NUDGE_ATTEMPTS && blankFor >= CHART_PAINT_NUDGE_MS * (nudges + 1)) {
        nudges += 1;
        controllerRef.current?.forceRemeasure();
        return;
      }

      if (blankFor >= CHART_STALL_TIMEOUT_MS && !escalated) {
        escalated = true;
        setStalled(true);
        // The banner alone leaves the trader to do the recovering. The pane
        // knows how, so it also does it — the recreate that the manual
        // workaround was standing in for.
        escalateRecovery('never-painted', 'chart reported ready but painted nothing');
      }
    }, CHART_PAINT_POLL_MS);

    return () => clearInterval(timer);
  }, [symbol, retryToken, escalateRecovery]);

  // The widget is built as soon as its container exists, which can be before
  // the dock has given that container a size. A chart laid out at zero draws
  // nothing at all — no candles, but also no price scale and no time axis,
  // which is what distinguishes it from a chart merely waiting for data — and
  // it stays that way, because the library's own autosize observer has already
  // taken its measurement. The bars arrive fine; nobody ever asks the chart to
  // measure again. Resizing the browser window used to be the only cure.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === 'undefined') return;

    let last = { width: 0, height: 0 };
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      // A zero box is the dock still laying out; there is nothing to measure
      // yet. Any real change gets a nudge — the first one is the measurement
      // the library missed, the rest are the dock resizes this method was
      // written for and which nothing was calling.
      if (width <= 0 || height <= 0) return;
      if (width === last.width && height === last.height) return;
      last = { width, height };
      // `resize`, never `forceRemeasure`: this runs ON a box change, and a call
      // that changes the box would drive itself round this loop forever.
      controllerRef.current?.resize();
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  // An order placed a few pips away lands outside a 1-minute chart's visible
  // range, so its line is drawn where nobody can see it — which reads as the
  // line failing to draw at all. When an order APPEARS for this pane's symbol,
  // make room for it once. Only new ids qualify: re-revealing on every tick
  // would fight a zoom the trader chose.
  const revealedOrders = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!isPrimary) return;
    return useTradingStore.subscribe((state) => {
      const controller = controllerRef.current;
      if (!controller) return;
      for (const order of state.orders) {
        if (order.status !== 'working' || order.price === null) continue;
        if (order.displaySymbol !== symbol) continue;
        if (revealedOrders.current.has(order.id)) continue;
        revealedOrders.current.add(order.id);
        controller.revealPrice(Number(order.price));
      }
    });
  }, [isPrimary, symbol]);

  // Last line of defence for the failure that matters most: the chart showing
  // one instrument while the ticket is armed for another. The causes are fixed
  // upstream, but a trader must never be left reading the wrong chart with
  // nothing on screen saying so — so the pane checks what it is actually
  // plotting and says when that is not what was asked for.
  const [renderedMismatch, setRenderedMismatch] = useState<string | null>(null);
  useEffect(() => {
    if (!isPrimary) return;
    setRenderedMismatch(null);
    const check = () => {
      const rendered = controllerRef.current?.renderedSymbol();
      setRenderedMismatch(rendered && rendered !== symbol ? rendered : null);
    };
    // Symbol swaps are asynchronous, so a difference is normal for a moment;
    // only a difference that PERSISTS is worth telling the trader about.
    const timer = setInterval(check, 2_000);
    return () => clearInterval(timer);
  }, [isPrimary, symbol]);

  const handleRetry = useCallback(() => {
    setError(null);
    // A deliberate retry earns a fresh automatic-recovery budget.
    readyRecoveriesRef.current = 0;
    setRetryToken((token) => token + 1);
  }, []);

  if (error) {
    return (
      <div className="h-full bg-[var(--background-secondary)]">
        <ErrorState
          title="The chart could not be loaded"
          description={error.message}
          onRetry={handleRetry}
        />
      </div>
    );
  }

  return (
    <div className="relative h-full min-h-0 w-full">
      <div
        ref={containerRef}
        data-testid={`chart-pane-${paneId}`}
        className="h-full min-h-0 w-full bg-[var(--background-primary)]"
      />
      {renderedMismatch && (
        <div
          role="alert"
          className="absolute inset-x-0 top-0 z-20 flex items-center justify-center gap-2 bg-[var(--warning)] px-2 py-1 text-2xs font-medium text-black"
        >
          This chart is still showing {renderedMismatch}, not {symbol}. Do not read prices from it.
          <button
            onClick={() => controllerRef.current?.setSymbol(symbol)}
            className="rounded border border-black/30 px-1.5 py-0.5 hover:bg-black/10"
          >
            Retry
          </button>
        </div>
      )}
      {stalled && (
        <div
          role="alert"
          className="absolute inset-x-0 top-0 z-20 flex items-center justify-center gap-2 bg-[var(--warning)] px-2 py-1 text-2xs font-medium text-black"
        >
          The chart has not drawn yet.
          <button
            onClick={() => {
              // Re-measure first: the common cause is a pane that was laid out
              // at zero and never asked to measure again.
              controllerRef.current?.forceRemeasure();
              setStalled(false);
              setRetryToken((token) => token + 1);
            }}
            className="rounded border border-black/30 px-1.5 py-0.5 hover:bg-black/10"
          >
            Retry
          </button>
        </div>
      )}
      {historyFailed && !stalled && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-[var(--background-primary)]/85">
          <div className="flex flex-col items-center gap-2 rounded border border-[var(--border-default)] bg-[var(--surface-raised)] px-4 py-3 shadow-md">
            <span className="text-xs font-medium text-text-primary">
              Chart data unavailable for {historyFailed}
            </span>
            <span className="text-2xs text-text-muted">
              The trading server did not answer the history request.
            </span>
            <button
              onClick={() => {
                setHistoryFailed(null);
                // A fresh widget re-issues the first history request; a
                // deliberate retry also earns a fresh recovery budget.
                readyRecoveriesRef.current = 0;
                setRetryToken((token) => token + 1);
              }}
              className="rounded border border-[var(--border-default)] bg-[var(--background-tertiary)] px-2.5 py-1 text-2xs font-medium text-text-primary hover:bg-[var(--surface-raised)]"
            >
              Retry
            </button>
          </div>
        </div>
      )}
      {booting && !stalled && !historyFailed && (
        <div
          role="status"
          className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-[var(--background-primary)]/60"
        >
          <span className="rounded border border-[var(--border-default)] bg-[var(--surface-raised)]/95 px-3 py-1.5 text-xs text-text-secondary shadow-md">
            Starting chart…
          </span>
        </div>
      )}
      {/* Suppressed while the pane is accused of not drawing: a chart that has
          painted nothing is not "loading", and two banners saying different
          things about the same pane is worse than either alone. */}
      {historyLoading && !stalled && !historyFailed && (
        <div
          role="status"
          className="pointer-events-none absolute left-1/2 top-2 z-10 -translate-x-1/2 rounded border border-[var(--border-default)] bg-[var(--surface-raised)]/95 px-2 py-1 text-2xs text-text-secondary shadow-md"
        >
          Loading chart data…
        </div>
      )}
    </div>
  );
}

/** Resolves the `system` theme preference against the OS setting. */
function useResolvedTheme(theme: 'dark' | 'light' | 'system'): 'dark' | 'light' {
  const [systemTheme, setSystemTheme] = useState<'dark' | 'light'>(() =>
    typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches
      ? 'light'
      : 'dark',
  );

  useEffect(() => {
    if (theme !== 'system' || typeof matchMedia !== 'function') return;
    const query = matchMedia('(prefers-color-scheme: light)');
    const onChange = (event: MediaQueryListEvent) =>
      setSystemTheme(event.matches ? 'light' : 'dark');
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, [theme]);

  return theme === 'system' ? systemTheme : theme;
}
