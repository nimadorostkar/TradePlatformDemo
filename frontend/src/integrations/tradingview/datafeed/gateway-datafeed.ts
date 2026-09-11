import type { MarketApi } from '@/integrations/gateway/api/market-api';
import type { SymbolSuffixPolicy } from '@/integrations/gateway/mappers/symbol-suffix';
import type { Quote, TradingSymbol } from '@/domain/common/models';
import { symbolLogoUrls } from '@/domain/market/symbol-logos';
import type { GatewaySubscriptionPool } from '@/integrations/gateway/websocket/subscription-pool';
import { tvBarListSchema, tvQuoteListSchema } from '@/integrations/gateway/contracts/schemas';
import { quoteStore } from '@/stores/quote-store';
import { mapTvQuote } from '@/integrations/gateway/mappers/to-domain';
import { warnOnce } from '../diagnostics';
import type {
  Bar,
  DatafeedConfiguration,
  DatafeedErrorCallback,
  HistoryCallback,
  IDatafeedQuotesApi,
  LibrarySymbolInfo,
  OnReadyCallback,
  PeriodParams,
  QuoteData,
  QuotesCallback,
  QuotesErrorCallback,
  ResolutionString,
  ResolveCallback,
  SearchSymbolResultItem,
  SearchSymbolsCallback,
  ServerTimeCallback,
  SubscribeBarsCallback,
} from '../types';

/**
 * TradingView datafeed backed by the Go gateway.
 *
 * All bars and quotes come from the broker's own MT5 feed — never from public
 * TradingView market data. A retail terminal that charts a different price than
 * it executes on is a support incident waiting to happen.
 *
 * Symbol names cross this boundary in DISPLAY form (no suffix) and are
 * converted to gateway form on every outbound call.
 */

const DAILY_RESOLUTIONS = new Set(['1D', '1W', '1M', 'D', 'W', 'M']);

/**
 * How long the library may be left without an answer about a symbol. Generous
 * — it exists to break a wedge, not to fail a merely slow gateway.
 */
const RESOLVE_SYMBOL_TIMEOUT_MS = 25_000;

/**
 * Whether this tab was asked to withhold bars, so the stall banner can be
 * exercised. Read per call rather than cached, so it can be turned off by
 * navigating without the flag.
 */
function withholdingBars(): boolean {
  try {
    return new URLSearchParams(window.location.search).get('withhold-bars') === '1';
  } catch {
    return false;
  }
}

const CONFIGURATION: DatafeedConfiguration = {
  exchanges: [{ value: '', name: 'All', desc: 'All exchanges' }],
  supported_resolutions: [
    '1',
    '2',
    '3',
    '5',
    '10',
    '15',
    '30',
    '60',
    '120',
    '240',
    '360',
    '480',
    '720',
    '1D',
    '1W',
    '1M',
  ] as ResolutionString[],
  // `value` is what searchSymbols gets back and matches against the GATEWAY's
  // type strings, which come from MT5 symbol paths: "Forex", "Spot Metals",
  // "Indices", "Cryptocurrencies"… The old values ("FX", "Indexes",
  // "Crypto-Currency") were TradingView-catalogue words the gateway never
  // says, so every filtered search strict-compared its way to "No symbols
  // match your criteria" (2026-08-24 QA). Matching is a substring test — see
  // matchesSymbolType — so "Metals" also catches "Spot Metals" and the
  // group-suffixed "Spot Metals#" of other account groups.
  symbols_types: [
    { name: 'All Types', value: '' },
    { name: 'Forex', value: 'Forex' },
    { name: 'Metals', value: 'Metals' },
    { name: 'Commodities', value: 'Commodities' },
    { name: 'Indices', value: 'Indices' },
    { name: 'Cryptocurrencies', value: 'Crypto' },
    { name: 'Shares', value: 'Shares' },
  ],
  supports_marks: false,
  supports_time: true,
  supports_timescale_marks: false,
};

/**
 * Whether a symbol's gateway-reported type falls under a search filter.
 *
 * A substring test, not equality: MT5 types are path stems ("Spot Metals",
 * and "Spot Metals#" for a symbol of another account group whose suffix the
 * active policy does not strip), while the filter carries one representative
 * word from CONFIGURATION.symbols_types.
 */
export function matchesSymbolType(type: string, filter: string): boolean {
  if (filter === '') return true;
  return type.toLowerCase().includes(filter.toLowerCase());
}

export interface GatewayDatafeedDeps {
  market: MarketApi;
  pool: GatewaySubscriptionPool;
  /** Read lazily — the policy changes on every account switch. */
  getSuffixPolicy: () => SymbolSuffixPolicy;
  /**
   * Called with the full symbol record whenever the chart resolves one.
   *
   * The chart is usually the FIRST thing to look a symbol up, and it already
   * fetches the complete record. Publishing it into the shared cache is what
   * lets the order ticket, the risk calculator, and the Broker API use real
   * contract limits instead of falling back to guesses.
   */
  onSymbolResolved?: (symbol: TradingSymbol) => void;
  onError?: (scope: string, error: unknown) => void;
  /**
   * Called with the number of history requests currently in flight.
   *
   * A long-range preset (5y of weekly bars) is a multi-second load, and the
   * report that motivated this showed the half-loaded chart being read as a
   * data gap. The host renders an unmistakable "loading history" state while
   * this is non-zero.
   */
  onHistoryLoading?: (pending: number) => void;
  /**
   * Called with the bars handed to the library, once per answered history
   * request. Distinct from `onHistoryLoading`, which also counts symbol
   * resolution: a pane that has resolved a symbol has still drawn nothing, and
   * treating the two as the same signal is what silenced the stall guard in
   * exactly the case it exists for.
   */
  onBarsDelivered?: (symbol: string, count: number) => void;
  /**
   * Called when the FIRST history page for a symbol fails definitively
   * (timeout + bounded retry exhausted). The library's own response to that
   * is a silent empty pane; the host owes the trader an explicit "chart data
   * unavailable" state with a way to retry. Non-first pages never fire this —
   * their failure keeps the drawn series and merely stops pagination.
   */
  onFirstPageFailed?: (displaySymbol: string) => void;
}

interface BarSubscription {
  displaySymbol: string;
  resolution: ResolutionString;
  onTick: SubscribeBarsCallback;
  /** The library's cache-reset hook, invoked when the underlying symbol moves. */
  onResetCacheNeeded: (() => void) | undefined;
  unsubscribe: () => void;
  /**
   * The newest bar handed to the library.
   *
   * Serves two jobs: it is the anchor the forming candle extends, and it is the
   * `from` used to backfill after an interruption. Null until history seeds it.
   */
  newestBar: Bar | null;
  /**
   * Set when the stream has dropped since the last successful heal.
   *
   * A reconnect only needs a backfill if something was actually missed, so a
   * first connect does not trigger one.
   */
  needsBackfill: boolean;
  /** Guards against two overlapping backfills for one subscription. */
  backfilling: boolean;
}

interface QuoteSubscription {
  displaySymbols: string[];
  onRealtime: QuotesCallback;
  unsubscribers: Array<() => void>;
}

export class GatewayDatafeed implements IDatafeedQuotesApi {
  private readonly deps: GatewayDatafeedDeps;
  /**
   * Live subscriptions, keyed by listenerGUID.
   *
   * The PARAMETERS are retained, not just the unsubscribe handle, because an
   * account switch changes the symbol suffix and every stream has to be
   * re-pointed at the new account group's symbol.
   */
  private readonly barSubscriptions = new Map<string, BarSubscription>();
  private readonly quoteSubscriptions = new Map<string, QuoteSubscription>();
  /**
   * Per (symbol, resolution): the active candle's constituent M1 bars plus the
   * bucket grid anchor.
   *
   * The gateway's live stream intentionally sends only a short trailing
   * window. Keeping the constituent M1 bars lets us update a 5m–12h candle
   * exactly without polling an entire 12-hour window from MT5 every three
   * seconds.
   *
   * `anchor` is a bucket-start time taken from a SERVER bar. The server cuts
   * intraday buckets on the broker's day (matching MT5 desktop), so on a UTC+3
   * server a 2h bucket starts at odd UTC hours — `Math.floor(time / bucketMs)`
   * would put the forming candle on a different grid than the history under
   * it. Every bucket boundary here is therefore computed as
   * `anchor + k * bucketMs`, which tiles the server's own grid whatever its
   * alignment.
   */
  private readonly liveIntradayM1 = new Map<string, { anchor: number; bars: Map<number, Bar> }>();
  private searchAbort: AbortController | null = null;
  private visibilityHandler: (() => void) | null = null;
  private pendingHistoryRequests = 0;

  constructor(deps: GatewayDatafeedDeps) {
    this.deps = deps;
  }

  onReady(callback: OnReadyCallback): void {
    // The library requires this to be asynchronous.
    setTimeout(() => callback(CONFIGURATION), 0);
  }

  async getServerTime(callback: ServerTimeCallback): Promise<void> {
    try {
      callback(await this.deps.market.serverTimeSeconds());
    } catch (error) {
      this.deps.onError?.('datafeed.serverTime', error);
      // No callback on failure: the library falls back to local time, which is
      // better than asserting a wrong server time.
    }
  }

  async searchSymbols(
    userInput: string,
    _exchange: string,
    symbolType: string,
    onResult: SearchSymbolsCallback,
  ): Promise<void> {
    // Cancel the previous keystroke's request so results cannot arrive stale
    // and overwrite a newer search.
    this.searchAbort?.abort();
    const controller = new AbortController();
    this.searchAbort = controller;

    try {
      const symbols = await this.deps.market.searchSymbols(
        userInput,
        this.deps.getSuffixPolicy(),
        controller.signal,
      );
      const results: SearchSymbolResultItem[] = symbols
        .filter((s) => matchesSymbolType(s.type, symbolType))
        .map((s) => ({
          symbol: s.displayName,
          ticker: s.displayName,
          description: s.description,
          exchange: s.exchange,
          type: s.type,
          full_name: s.displayName,
          logo_urls: symbolLogoUrls(s.displayName),
        }));
      onResult(results);
    } catch (error) {
      if (controller.signal.aborted) return;
      this.deps.onError?.('datafeed.searchSymbols', error);
      onResult([]);
    }
  }

  async resolveSymbol(
    symbolName: string,
    onResolve: ResolveCallback,
    onError: DatafeedErrorCallback,
  ): Promise<void> {
    // Nothing is drawn until this answers, and the library asks for bars only
    // after it does — so while this is outstanding the pane is blank AND the
    // history spinner cannot appear. Count it as loading, and never let it run
    // unbounded: an answer that never comes leaves a chart showing the
    // PREVIOUS symbol's series under the new symbol's name, with every later
    // setSymbol queued behind it. An error at least says so and can be retried.
    this.pendingHistoryRequests += 1;
    this.deps.onHistoryLoading?.(this.pendingHistoryRequests);
    let settled = false;
    const answer = (fn: () => void) => {
      if (settled) return;
      settled = true;
      this.pendingHistoryRequests -= 1;
      this.deps.onHistoryLoading?.(this.pendingHistoryRequests);
      fn();
    };
    const watchdog = setTimeout(() => {
      answer(() => {
        this.deps.onError?.(
          'datafeed.resolveSymbol',
          new Error(`resolveSymbol timed out for ${symbolName}`),
        );
        onError('The trading server did not describe this symbol in time.');
      });
    }, RESOLVE_SYMBOL_TIMEOUT_MS);

    try {
      const policy = this.deps.getSuffixPolicy();
      const gatewaySymbol = policy.toGateway(symbolName);
      const symbol = await this.deps.market.symbolInfo(gatewaySymbol, policy);

      if (!symbol) {
        answer(() => onError('unknown_symbol'));
        return;
      }

      this.deps.onSymbolResolved?.(symbol);

      const resolved = {
        ticker: symbol.displayName,
        name: symbol.displayName,
        description: symbol.description,
        type: symbol.type,
        session: symbol.session,
        timezone: symbol.timezone as LibrarySymbolInfo['timezone'],
        exchange: symbol.exchange,
        listed_exchange: symbol.exchange,
        format: 'price',
        minmov: symbol.minMove,
        pricescale: symbol.pricescale,
        has_intraday: true,
        has_daily: true,
        has_weekly_and_monthly: true,
        // The gateway aggregates M1 into any of these server-side (broker-day
        // aligned, matching MT5 desktop candles). Advertising only "1" would
        // make the library build 2h from M1 itself — which means shipping the
        // raw M1 over the wire: ~8 MB for a 6-month 2h window.
        intraday_multipliers: [
          '1',
          '2',
          '3',
          '5',
          '10',
          '15',
          '30',
          '60',
          '120',
          '240',
          '360',
          '480',
          '720',
        ],
        daily_multipliers: ['1'],
        supported_resolutions: CONFIGURATION.supported_resolutions ?? [],
        has_empty_bars: false,
        visible_plots_set: 'ohlcv',
        currency_code: symbol.currencyCode ?? undefined,
        volume_precision: 2,
        data_status: 'streaming',
        sector: symbol.sector ?? undefined,
        industry: symbol.industry ?? undefined,
        logo_urls: symbolLogoUrls(symbol.displayName),
        delay: 0,
      } as LibrarySymbolInfo;
      answer(() => onResolve(resolved));
    } catch (error) {
      this.deps.onError?.('datafeed.resolveSymbol', error);
      answer(() => onError('unknown_symbol'));
    } finally {
      clearTimeout(watchdog);
    }
  }

  /**
   * A time (ms) at or before `before` where bar data exists — or null when
   * none does within the lookback (genuinely no data, or a dead symbol
   * dialect).
   *
   * ALWAYS answered from DAILY bars, whatever the chart's resolution: a
   * 120-day daily window is a handful of rows, while a multi-day M1 window is
   * exactly the long request the gateway has to fan into many slow MT5 calls —
   * heavy enough that a paging chart could sit in "loading" for its whole
   * walk. The newest daily bar is projected to its day END (capped below
   * `before`) so a window ending there covers that day's intraday bars.
   *
   * The result is cached per symbol: one pagination walk performs one lookback,
   * not one per empty page. A cached hint that should have produced bars in a
   * later window (hint inside an empty window) is treated as stale and
   * refreshed.
   */
  private readonly previousBarHints = new Map<string, number | null>();

  private async findPreviousBarTime(gatewaySymbol: string, before: number): Promise<number | null> {
    const beforeMs = before * 1000;
    const cached = this.previousBarHints.get(gatewaySymbol);
    if (cached !== undefined && (cached === null || cached < beforeMs)) return cached;

    let hint: number | null = null;
    try {
      const raw = await this.deps.market.dailyBars({
        symbol: gatewaySymbol,
        from: before - 120 * 86_400,
        to: before,
        resolution: '1D',
      });

      const parsed = tvBarListSchema.safeParse(raw);
      if (parsed.success) {
        let newest: number | null = null;
        for (const bar of parsed.data) {
          if (bar.time <= before && (newest === null || bar.time > newest)) newest = bar.time;
        }
        if (newest !== null) {
          const dayEnd = newest + 86_399;
          hint = (dayEnd < before ? dayEnd : newest) * 1000;
        }
      }
    } catch {
      // The original window still answered cleanly; a failed lookback merely
      // ends pagination early rather than erroring a healthy chart. Not
      // cached: a transient failure must not silence a later walk.
      return null;
    }

    this.previousBarHints.set(gatewaySymbol, hint);
    return hint;
  }

  async getBars(
    symbolInfo: LibrarySymbolInfo,
    resolution: ResolutionString,
    periodParams: PeriodParams,
    onHistory: HistoryCallback,
    onError: DatafeedErrorCallback,
  ): Promise<void> {
    const { from, to, firstDataRequest } = periodParams;

    // QA hook. The "chart has not drawn yet" banner exists for a pane that
    // never receives bars, which is exactly the state a tester cannot produce
    // on demand — blocking the socket does not do it, because history rides an
    // already-open multiplexed connection. With `?withhold-bars=1` the datafeed
    // simply never answers the first request, which is that state precisely.
    // Deliberately query-string-only and per-tab: it cannot be set by accident
    // and does not survive a fresh URL.
    if (withholdingBars()) {
      warnOnce('bars-withheld', 'withholding bars: ?withhold-bars=1 is set', {
        symbol: symbolInfo.name,
        resolution,
      });
      return;
    }

    if (from < 0) {
      this.deps.onBarsDelivered?.(symbolInfo.name, 0);
      onHistory([], { noData: true });
      return;
    }

    this.pendingHistoryRequests += 1;
    this.deps.onHistoryLoading?.(this.pendingHistoryRequests);
    try {
      const gatewaySymbol = this.deps
        .getSuffixPolicy()
        .toGateway(symbolInfo.ticker ?? symbolInfo.name);
      const isDaily = DAILY_RESOLUTIONS.has(resolution);

      const raw = isDaily
        ? await this.deps.market.dailyBars({ symbol: gatewaySymbol, from, to, resolution })
        : await this.deps.market.intradayBars({ symbol: gatewaySymbol, from, to, resolution });

      const parsed = tvBarListSchema.safeParse(raw);
      if (!parsed.success) {
        // A malformed response is an ERROR, never "history ends here":
        // answering noData tells the library to stop asking for older bars
        // forever, which turns one bad response into a permanent gap.
        onError('history response malformed');
        return;
      }

      let bars: Bar[] = parsed.data
        .map((bar) => ({
          time: bar.time * 1000, // the library wants milliseconds
          open: Number(bar.open),
          high: Number(bar.high),
          low: Number(bar.low),
          close: Number(bar.close),
          volume: bar.volume === null ? undefined : Number(bar.volume),
        }))
        // The gateway can return bars outside the window (it buckets from a
        // wider M1 range); the library requires them strictly inside it.
        .filter((bar) => bar.time / 1000 >= from && bar.time / 1000 <= to)
        .sort((a, b) => a.time - b.time);

      if (!isDaily) {
        // The gateway aggregates when asked, but an older gateway ignores the
        // `resolution` parameter and returns raw M1. Folding here keeps the
        // chart correct through a mixed deploy; on an aggregating gateway the
        // shape check makes this a no-op.
        if (looksLikeRawM1(bars, resolution)) {
          bars = aggregateIntradayBars(bars, resolution);
        }
        if (firstDataRequest) {
          this.seedLiveIntraday(gatewaySymbol, resolution, bars, to);
        }
      }

      if (bars.length === 0) {
        // An empty WINDOW is not the end of history. Over a weekend the
        // library's first request covers only closed-market hours; answering
        // noData would tell it to stop asking forever, and every intraday
        // chart would open onto "No data here" with Friday's bars sitting
        // just outside the window. Look back once (bounded) for the previous
        // bar and point the library at it; only a confirmed-empty lookback
        // ends pagination.
        const nextTime = await this.findPreviousBarTime(gatewaySymbol, from);
        this.deps.onBarsDelivered?.(symbolInfo.name, 0);
        if (nextTime !== null) {
          onHistory([], { noData: false, nextTime });
          return;
        }
        onHistory([], { noData: true });
        return;
      }

      // countBack is a FLOOR, not a ceiling: the library documents it as "the
      // exact amount of bars to load, higher priority than `from`" — meaning
      // reach FURTHER back than `from` if that is what it takes, never trim a
      // full-range answer down. This used to slice to countBack, and since
      // countBack scales with pane width (~one bar per pixel), a 6-month
      // range button on a 1600px pane got exactly 1600 bars (~133 days of
      // 2h) and the library clamped the visible window to the data edge —
      // the "range buttons open short" bug, reproduced byte-exact in e2e.
      this.deps.onBarsDelivered?.(symbolInfo.name, bars.length);
      // History goes STRAIGHT to the library, bypassing the subscription's
      // `newestBar` — which is also the backfill's replay anchor. Left
      // behind, that anchor lets a reconnect backfill replay bars from
      // before the library's own cache tail, which the library answers with
      // a "time violation" and rejects (observed on every reconnect during
      // the 2026-08-24 outage cycles). The delivered history is the truth
      // about where the series ends; the anchor follows it.
      const newest = bars[bars.length - 1];
      if (newest) this.raiseSubscriptionFloor(symbolInfo.name, resolution, newest);
      onHistory(bars, { noData: false });
    } catch (error) {
      this.deps.onError?.('datafeed.getBars', error);
      // A failed OLDER-history page must not poison the series. The library
      // pages backward after the first answer, and it responds to an error on
      // any page by discarding everything already drawn — observed live
      // during the 2026-08-24 gateway outage: the first page served candles,
      // the 2014-2020 page failed, and the chart went from drawn to "No data
      // here". For a non-first page, "history ends here for now" keeps the
      // drawn series and merely stops pagination for this session; the error
      // above still reaches diagnostics. The FIRST page keeps failing
      // honestly — there is nothing on screen to protect, and noData there
      // would cache an empty chart against a symbol that has data.
      if (!firstDataRequest) {
        this.deps.onBarsDelivered?.(symbolInfo.name, 0);
        onHistory([], { noData: true });
        return;
      }
      this.deps.onFirstPageFailed?.(symbolInfo.name);
      onError(error instanceof Error ? error.message : 'Failed to load bars');
    } finally {
      this.pendingHistoryRequests -= 1;
      this.deps.onHistoryLoading?.(this.pendingHistoryRequests);
    }
  }

  /**
   * Lifts every matching subscription's `newestBar` to a bar the library has
   * already been given, so no later stream frame or backfill replay can hand
   * it anything older than its own cache tail.
   */
  private raiseSubscriptionFloor(
    displaySymbol: string,
    resolution: ResolutionString,
    bar: Bar,
  ): void {
    for (const subscription of this.barSubscriptions.values()) {
      if (subscription.displaySymbol !== displaySymbol) continue;
      if (subscription.resolution !== resolution) continue;
      if (subscription.newestBar === null || subscription.newestBar.time < bar.time) {
        subscription.newestBar = bar;
      }
    }
  }

  subscribeBars(
    symbolInfo: LibrarySymbolInfo,
    resolution: ResolutionString,
    onTick: SubscribeBarsCallback,
    listenerGuid: string,
    onResetCacheNeededCallback?: () => void,
  ): void {
    // Replace any existing subscription for this GUID; the library can
    // resubscribe the same id after a symbol change.
    this.unsubscribeBars(listenerGuid);

    const subscription: BarSubscription = {
      displaySymbol: symbolInfo.name,
      resolution,
      onTick,
      onResetCacheNeeded: onResetCacheNeededCallback,
      unsubscribe: () => {},
      newestBar: null,
      needsBackfill: false,
      backfilling: false,
    };
    subscription.unsubscribe = this.openBarStream(subscription);
    this.barSubscriptions.set(listenerGuid, subscription);
    this.attachVisibilityListener();
  }

  /**
   * Opens the streams behind one bar subscription against the CURRENT account's
   * suffixed symbol: the bar window, and the quote feed that drives the forming
   * candle between bar pushes.
   */
  private openBarStream(subscription: BarSubscription): () => void {
    const gatewaySymbol = this.deps.getSuffixPolicy().toGateway(subscription.displaySymbol);
    const isDaily = DAILY_RESOLUTIONS.has(subscription.resolution);

    const unsubscribeBarWindow = this.deps.pool.subscribe(
      { family: isDaily ? 'daily-bar' : 'intraday-bar', symbol: gatewaySymbol },
      (frame) => {
        const parsed = tvBarListSchema.safeParse(frame);
        if (!parsed.success || parsed.data.length === 0) return;

        // Both bar streams return a window. Intraday upstream data is M1, so
        // roll it into the selected interval before publishing the current
        // candle; passing a raw M1 candle to a 15m chart corrupts its timeline.
        const normalized = parsed.data.map((bar) => ({
          time: bar.time * 1000,
          open: Number(bar.open),
          high: Number(bar.high),
          low: Number(bar.low),
          close: Number(bar.close),
          volume: bar.volume === null ? undefined : Number(bar.volume),
        }));
        if (isDaily) {
          const latest = normalized[normalized.length - 1];
          if (!latest) return;
          this.applyDailyStreamBar(subscription, latest);
          return;
        }
        const rolled = this.mergeLiveIntradayBars(
          gatewaySymbol,
          subscription.resolution,
          normalized,
        );
        const latest = rolled[rolled.length - 1];
        if (!latest) return;

        this.emitStreamBar(subscription, latest);
      },
      (status) => {
        // The pool reports every transition. A drop means the fixed live window
        // has almost certainly moved past whatever we missed, so mark the
        // subscription for a backfill and heal it once the socket is back.
        if (status.state === 'connected') {
          if (subscription.needsBackfill) void this.backfill(subscription);
          return;
        }
        if (status.state !== 'connecting') subscription.needsBackfill = true;
      },
    );

    // The forming candle is driven by quotes, not by the 3s bar poll. Daily
    // resolutions are deliberately excluded: their bucket boundary is a
    // broker-timezone question, and inventing that client-side is exactly the
    // timezone maths this datafeed leaves to the library and the gateway.
    const unsubscribeQuotes = isDaily
      ? () => {}
      : this.deps.pool.subscribe({ family: 'quote', symbol: gatewaySymbol }, (frame, meta) => {
          const parsed = tvQuoteListSchema.safeParse(frame);
          if (!parsed.success || parsed.data.length === 0) return;
          const dto = parsed.data[0];
          if (!dto) return;

          // Feed the shared quote store as well, so the watchlist and order
          // ticket see the same tick without opening a second socket.
          const quote = mapTvQuote(
            dto,
            quoteStore.get(gatewaySymbol),
            meta.receivedAt,
            gatewaySymbol,
          );
          // A priceless tick cannot move a bar either.
          if (quote === null) return;
          quoteStore.apply(quote);
          this.applyQuoteToFormingBar(subscription, quote);
        });

    return () => {
      unsubscribeBarWindow();
      unsubscribeQuotes();
    };
  }

  /**
   * Extends the forming candle from a quote.
   *
   * Bucketing is on the BROKER's timestamp. Using `Date.now()` would tie the
   * candle to the trader's own clock, so a machine a few minutes fast would
   * open the next candle early and leave the forming bar drifting away from the
   * bars underneath it.
   */
  private applyQuoteToFormingBar(subscription: BarSubscription, quote: Quote): void {
    const minutes = Number(subscription.resolution);
    if (!Number.isInteger(minutes) || minutes < 1) return;

    // No broker time means no trustworthy bucket. Stepping once per bar push is
    // a worse chart than ticking, but it is never a WRONG chart.
    if (quote.brokerTime === null) return;

    const price = formingPrice(quote);
    if (price === null) return;

    const current = subscription.newestBar;
    // Until history has seeded a bar there is nothing to extend, and inventing
    // one would put a candle on the chart with no open the server agrees with.
    if (!current) return;

    // The held bar's own time is a bucket start on the server's grid, so the
    // quote's bucket is found by stepping that grid — not by flooring against
    // UTC, which disagrees with the broker-aligned grid on 2h+ charts.
    const bucketMs = minutes * 60_000;
    const bucket =
      current.time + Math.floor((quote.brokerTime - current.time) / bucketMs) * bucketMs;

    if (bucket < current.time) return; // a late or replayed quote

    if (bucket === current.time) {
      this.emitBar(subscription, {
        ...current,
        high: Math.max(current.high, price),
        low: Math.min(current.low, price),
        close: price,
      });
      return;
    }

    // The bucket advanced: open the next candle at this price. Volume stays 0
    // until the bar stream delivers the broker's own count for the interval.
    this.emitBar(subscription, {
      time: bucket,
      open: price,
      high: price,
      low: price,
      close: price,
      volume: 0,
    });
  }

  /**
   * Applies a bar from the DAILY stream, which always carries the current
   * broker-DAY candle — while the subscription may be weekly or monthly.
   *
   * Two rules, both learned from the live weekly chart:
   *
   * - No push before history has seeded `newestBar`. The stream's frame can
   *   arrive while history is still loading, and a day-stamped bar delivered
   *   against the library's cache tail from an earlier epoch is rejected as a
   *   "time violation" — the residual once-per-boot burst of Issue 2. The
   *   stream repeats every few seconds, so waiting for the floor loses
   *   nothing.
   *
   * - A day bar must be FOLDED into the series' own bucket, not forwarded
   *   verbatim: on any day but the first of the bucket its day-start stamp
   *   falls INSIDE the current weekly/monthly candle, and the library would
   *   open a second bar mid-week. Weeks are a fixed grid, so the bucket is
   *   stepped from the held bar; a month's rollover candle is left to the
   *   next history refresh, because month lengths cannot be stepped from a
   *   single timestamp.
   */
  private applyDailyStreamBar(subscription: BarSubscription, bar: Bar): void {
    const current = subscription.newestBar;
    if (!current) return;
    if (bar.time < current.time) return;

    const resolution = subscription.resolution;
    if (resolution === '1W' || resolution === 'W') {
      const weekMs = 7 * 86_400_000;
      const bucket = current.time + Math.floor((bar.time - current.time) / weekMs) * weekMs;
      if (bucket === current.time) {
        this.emitBar(subscription, {
          time: current.time,
          open: current.open,
          high: Math.max(current.high, bar.high),
          low: Math.min(current.low, bar.low),
          close: bar.close,
        });
      } else {
        this.emitBar(subscription, { ...bar, time: bucket });
      }
      return;
    }
    if (resolution === '1M' || resolution === 'M') {
      this.emitBar(subscription, {
        time: current.time,
        open: current.open,
        high: Math.max(current.high, bar.high),
        low: Math.min(current.low, bar.low),
        close: bar.close,
      });
      return;
    }
    this.emitStreamBar(subscription, bar);
  }

  /**
   * Publishes an authoritative bar from the bar stream.
   *
   * When it lands in the bucket the forming candle has already been extending,
   * the quote-driven extremes are folded in. Without that the wick would
   * visibly shrink back on every poll, because the server's rolled M1 bar does
   * not know about the ticks that arrived between polls.
   */
  private emitStreamBar(subscription: BarSubscription, bar: Bar): void {
    const current = subscription.newestBar;
    if (current && current.time === bar.time) {
      this.emitBar(subscription, {
        ...bar,
        high: Math.max(bar.high, current.high),
        low: Math.min(bar.low, current.low),
      });
      return;
    }
    this.emitBar(subscription, bar);
  }

  /** Hands a bar to the library, never going backwards in time. */
  private emitBar(subscription: BarSubscription, bar: Bar): void {
    // TradingView accepts an update to the current bar or a new one after it.
    // A bar older than the last one corrupts the series, and the two producers
    // here (quotes and the bar poll) can genuinely race.
    if (subscription.newestBar && bar.time < subscription.newestBar.time) return;
    subscription.newestBar = bar;
    subscription.onTick(bar);
  }

  unsubscribeBars(listenerGuid: string): void {
    this.barSubscriptions.get(listenerGuid)?.unsubscribe();
    this.barSubscriptions.delete(listenerGuid);
    if (this.barSubscriptions.size === 0) this.detachVisibilityListener();
  }

  async getQuotes(
    symbols: string[],
    onData: QuotesCallback,
    onError: QuotesErrorCallback,
  ): Promise<void> {
    try {
      const policy = this.deps.getSuffixPolicy();
      const quotes = await Promise.all(
        symbols.map(async (symbol): Promise<QuoteData> => {
          try {
            const [quote] = await this.deps.market.lastQuotes(policy.toGateway(symbol));
            if (!quote) return errorQuote(symbol);
            quoteStore.apply(quote);
            return okQuote(symbol, quote.bid, quote.ask, quote.last, quote.volume);
          } catch {
            return errorQuote(symbol);
          }
        }),
      );
      onData(quotes);
    } catch (error) {
      this.deps.onError?.('datafeed.getQuotes', error);
      onError(error instanceof Error ? error.message : 'Failed to load quotes');
    }
  }

  subscribeQuotes(
    symbols: string[],
    fastSymbols: string[],
    onRealtime: QuotesCallback,
    listenerGuid: string,
  ): void {
    this.unsubscribeQuotes(listenerGuid);

    // BOTH lists are streamed. The library's trading side requests the traded
    // symbol through the general `symbols` list, not `fastSymbols`, and its
    // quote snapshot is what makes chart context-menu Buy/Sell actions and DOM
    // trading executable. Serving only the fast list starved that snapshot, so
    // every chart trading action was silently hidden. The pool deduplicates by
    // symbol and the gateway pushes on one fixed cadence, so there is no
    // cheaper "slow" stream to offer anyway.
    const displaySymbols = [...new Set([...symbols, ...fastSymbols])];

    this.quoteSubscriptions.set(listenerGuid, {
      displaySymbols,
      onRealtime,
      unsubscribers: this.openQuoteStreams(displaySymbols, onRealtime),
    });
  }

  /** Opens quote streams against the CURRENT account's suffixed symbols. */
  private openQuoteStreams(
    displaySymbols: readonly string[],
    onRealtime: QuotesCallback,
  ): Array<() => void> {
    const policy = this.deps.getSuffixPolicy();
    return displaySymbols.map((symbol) => {
      const gatewaySymbol = policy.toGateway(symbol);
      return this.deps.pool.subscribe({ family: 'quote', symbol: gatewaySymbol }, (frame, meta) => {
        const parsed = tvQuoteListSchema.safeParse(frame);
        if (!parsed.success || parsed.data.length === 0) return;
        const dto = parsed.data[0];
        if (!dto) return;

        // Feed the shared quote store as well, so the watchlist and order
        // ticket see the same tick without opening a second socket.
        const domainQuote = mapTvQuote(
          dto,
          quoteStore.get(gatewaySymbol),
          meta.receivedAt,
          gatewaySymbol,
        );
        if (domainQuote === null) return;
        quoteStore.apply(domainQuote);

        onRealtime([
          okQuote(symbol, domainQuote.bid, domainQuote.ask, domainQuote.last, domainQuote.volume),
        ]);
      });
    });
  }

  unsubscribeQuotes(listenerGuid: string): void {
    for (const unsubscribe of this.quoteSubscriptions.get(listenerGuid)?.unsubscribers ?? []) {
      unsubscribe();
    }
    this.quoteSubscriptions.delete(listenerGuid);
  }

  /**
   * Re-points every live stream at the current account's symbols.
   *
   * MUST be called after an account switch. The suffix is per account GROUP
   * (`EURUSD.` for ECN, `EURUSD!` for Standard), so without this the chart
   * would keep streaming the PREVIOUS group's instrument — a different book,
   * with a different spread, under the new account's name.
   *
   * Each bar stream also asks the library to drop its cached bars, because the
   * history it holds belongs to the old instrument.
   */
  resubscribeForAccountChange(): void {
    this.liveIntradayM1.clear();
    // The hints are keyed by gateway symbol, which the new account's suffix
    // changes anyway — but a switch is also the moment stale knowledge about
    // "where data ends" should die.
    this.previousBarHints.clear();
    for (const subscription of this.barSubscriptions.values()) {
      subscription.unsubscribe();
      subscription.onResetCacheNeeded?.();
      // The held bar belongs to the PREVIOUS account's instrument. Keeping it
      // would both anchor the forming candle to a different book's price and
      // make the next backfill ask for a window on the wrong series.
      subscription.newestBar = null;
      subscription.needsBackfill = false;
      subscription.unsubscribe = this.openBarStream(subscription);
    }

    for (const subscription of this.quoteSubscriptions.values()) {
      for (const unsubscribe of subscription.unsubscribers) unsubscribe();
      subscription.unsubscribers = this.openQuoteStreams(
        subscription.displaySymbols,
        subscription.onRealtime,
      );
    }
  }

  /** Releases every socket this datafeed opened. Call on account switch. */
  dispose(): void {
    for (const subscription of this.barSubscriptions.values()) subscription.unsubscribe();
    this.barSubscriptions.clear();
    for (const subscription of this.quoteSubscriptions.values()) {
      for (const unsubscribe of subscription.unsubscribers) unsubscribe();
    }
    this.quoteSubscriptions.clear();
    this.liveIntradayM1.clear();
    this.searchAbort?.abort();
    this.detachVisibilityListener();
  }

  /**
   * Refetches the bars missed while a subscription was interrupted.
   *
   * The live bar stream only ever carries a short trailing window, and anything
   * older than that window is never re-sent — so a tab backgrounded for an hour
   * leaves a hole that no amount of waiting fills. This asks for `[newest held
   * bar, now]` over REST and replays it into the library in order.
   *
   * REST rather than a `fromtime=<T>` WebSocket subscription on purpose: the WS
   * subscription is STANDING, so a wide `fromtime` would re-push the entire
   * window every 3s for as long as the chart stayed open, growing with the size
   * of the gap. The heal is a one-shot, so it belongs on a one-shot transport.
   */
  private async backfill(subscription: BarSubscription): Promise<void> {
    if (subscription.backfilling) return;
    const anchor = subscription.newestBar;
    // With no bars held there is no gap to close — the library will request
    // history itself, which is a better source than a synthetic window.
    if (!anchor) {
      subscription.needsBackfill = false;
      return;
    }

    subscription.backfilling = true;
    try {
      const gatewaySymbol = this.deps.getSuffixPolicy().toGateway(subscription.displaySymbol);
      const isDaily = DAILY_RESOLUTIONS.has(subscription.resolution);
      const from = Math.floor(anchor.time / 1000);
      // Overshooting the upper bound is harmless — bars cannot exist in the
      // future — whereas a client clock running slow against the broker's would
      // silently truncate the newest candles from the heal.
      const to = Math.floor(Date.now() / 1000) + 3600;

      const raw = isDaily
        ? await this.deps.market.dailyBars({
            symbol: gatewaySymbol,
            from,
            to,
            resolution: subscription.resolution,
          })
        : await this.deps.market.intradayBars({
            symbol: gatewaySymbol,
            from,
            to,
            resolution: subscription.resolution,
          });

      const parsed = tvBarListSchema.safeParse(raw);
      if (!parsed.success) return;

      const normalized = parsed.data
        .map((bar) => ({
          time: bar.time * 1000,
          open: Number(bar.open),
          high: Number(bar.high),
          low: Number(bar.low),
          close: Number(bar.close),
          volume: bar.volume === null ? undefined : Number(bar.volume),
        }))
        .filter((bar) => bar.time >= anchor.time)
        .sort((a, b) => a.time - b.time);

      // Same mixed-deploy tolerance as getBars: an older gateway ignores the
      // resolution parameter and answers in raw M1.
      const bars =
        !isDaily && looksLikeRawM1(normalized, subscription.resolution)
          ? aggregateIntradayBars(normalized, subscription.resolution)
          : normalized;

      // Chronological order matters: the library treats each call as "this is
      // the newest bar", so replaying out of order would rewrite the series.
      for (const bar of bars) this.emitStreamBar(subscription, bar);

      if (!isDaily) this.seedLiveIntraday(gatewaySymbol, subscription.resolution, bars, to);
      subscription.needsBackfill = false;
    } catch (error) {
      // Leave `needsBackfill` set so the next reconnect or foreground retries.
      this.deps.onError?.('datafeed.backfill', error);
    } finally {
      subscription.backfilling = false;
    }
  }

  /**
   * Heals every bar subscription when the tab comes back to the foreground.
   *
   * Backgrounded tabs are throttled hard by browsers, and this is the common
   * way a chart loses bars — invisible in testing, because nobody backgrounds a
   * tab while watching a chart.
   */
  private attachVisibilityListener(): void {
    if (this.visibilityHandler || typeof document === 'undefined') return;
    this.visibilityHandler = () => {
      if (document.visibilityState !== 'visible') return;
      for (const subscription of this.barSubscriptions.values()) {
        void this.backfill(subscription);
      }
    };
    document.addEventListener('visibilitychange', this.visibilityHandler);
  }

  private detachVisibilityListener(): void {
    if (!this.visibilityHandler || typeof document === 'undefined') return;
    document.removeEventListener('visibilitychange', this.visibilityHandler);
    this.visibilityHandler = null;
  }

  private liveIntradayKey(symbol: string, resolution: ResolutionString): string {
    return `${symbol}\u0000${resolution}`;
  }

  /**
   * (Re)anchors the live-candle state from freshly loaded history and refills
   * the active bucket's true M1 constituents.
   *
   * `bars` are at the CHART's resolution now (the gateway aggregates), so the
   * newest one seeds the state immediately — correct open/high/low, and a grid
   * anchor for every later push — while the exact M1 constituents of that
   * bucket are fetched in the background. Until they land, merging the live
   * window can double-count at most the overlap's volume; after they land the
   * candle is exact. The fetch is small by construction: one bucket's worth of
   * M1, bounded by the largest resolution at 720 rows.
   */
  private seedLiveIntraday(
    symbol: string,
    resolution: ResolutionString,
    bars: readonly Bar[],
    toSeconds: number,
  ): void {
    const minutes = Number(resolution);
    if (!Number.isInteger(minutes) || minutes <= 1 || bars.length === 0) return;

    const last = bars[bars.length - 1]!;
    this.liveIntradayM1.set(this.liveIntradayKey(symbol, resolution), {
      anchor: last.time,
      bars: new Map([[last.time, { ...last }]]),
    });
    void this.fetchActiveBucketM1(symbol, resolution, last.time, toSeconds);
  }

  private async fetchActiveBucketM1(
    symbol: string,
    resolution: ResolutionString,
    anchorMs: number,
    toSeconds: number,
  ): Promise<void> {
    try {
      const raw = await this.deps.market.intradayBars({
        symbol,
        from: Math.floor(anchorMs / 1000),
        to: toSeconds,
        resolution: '1',
      });
      const parsed = tvBarListSchema.safeParse(raw);
      if (!parsed.success) return;

      const key = this.liveIntradayKey(symbol, resolution);
      const state = this.liveIntradayM1.get(key);
      // Superseded while in flight (bucket rollover, account switch): the
      // fetched constituents describe a bucket nobody is forming any more.
      if (!state || state.anchor !== anchorMs) return;

      const constituents = new Map<number, Bar>();
      for (const bar of parsed.data) {
        const time = bar.time * 1000;
        if (time < anchorMs) continue;
        constituents.set(time, {
          time,
          open: Number(bar.open),
          high: Number(bar.high),
          low: Number(bar.low),
          close: Number(bar.close),
          volume: bar.volume === null ? undefined : Number(bar.volume),
        });
      }
      // Live pushes that arrived while this fetch ran are fresher than it for
      // the same minutes; the seeded aggregate placeholder (keyed exactly at
      // the anchor) is the one entry the fetch exists to replace.
      for (const [time, bar] of state.bars) {
        if (time > anchorMs) constituents.set(time, bar);
      }
      if (constituents.size > 0) {
        this.liveIntradayM1.set(key, { anchor: anchorMs, bars: constituents });
      }
    } catch {
      // Best-effort: the placeholder seed keeps the candle correct enough
      // (exact OHLC, volume may briefly double-count the live overlap).
    }
  }

  private mergeLiveIntradayBars(
    symbol: string,
    resolution: ResolutionString,
    incoming: readonly Bar[],
  ): Bar[] {
    const minutes = Number(resolution);
    if (!Number.isInteger(minutes) || minutes <= 1 || incoming.length === 0) {
      return [...incoming];
    }

    const bucketMs = minutes * 60_000;
    const key = this.liveIntradayKey(symbol, resolution);
    const state = this.liveIntradayM1.get(key);
    const newest = incoming.reduce((latest, bar) => (bar.time > latest.time ? bar : latest));
    // Without a seeded anchor (live frame before any history) fall back to the
    // UTC grid; the next history load re-anchors the state.
    const anchor = state?.anchor ?? Math.floor(newest.time / bucketMs) * bucketMs;
    const bucketOf = (time: number) => anchor + Math.floor((time - anchor) / bucketMs) * bucketMs;
    const newestBucket = bucketOf(newest.time);
    const active = state?.bars ?? new Map<number, Bar>();

    // A new bucket makes every previous constituent obsolete.
    for (const [time] of active) {
      if (bucketOf(time) !== newestBucket) active.delete(time);
    }
    for (const bar of incoming) {
      if (bucketOf(bar.time) === newestBucket) {
        // Replace repeated M1 samples instead of double-counting their volume.
        active.set(bar.time, { ...bar });
      }
    }
    this.liveIntradayM1.set(key, { anchor: newestBucket, bars: active });

    const constituents = [...active.values()].sort((a, b) => a.time - b.time);
    const first = constituents[0];
    if (!first) return [];
    const folded: Bar = { ...first, time: newestBucket };
    for (const bar of constituents.slice(1)) {
      folded.high = Math.max(folded.high, bar.high);
      folded.low = Math.min(folded.low, bar.low);
      folded.close = bar.close;
      if (folded.volume !== undefined || bar.volume !== undefined) {
        folded.volume = (folded.volume ?? 0) + (bar.volume ?? 0);
      }
    }
    return [folded];
  }
}

/**
 * True when intraday history came back as raw M1 rather than aggregated to
 * `resolution` — the shape an older gateway (no `resolution` parameter)
 * returns. Any two bars closer together than one bucket cannot both be
 * bucket-starts, so one pass over the spacing decides it.
 */
export function looksLikeRawM1(bars: readonly Bar[], resolution: ResolutionString): boolean {
  const minutes = Number(resolution);
  if (!Number.isInteger(minutes) || minutes <= 1 || bars.length < 2) return false;
  const bucketMs = minutes * 60_000;
  for (let i = 1; i < bars.length; i += 1) {
    if (bars[i]!.time - bars[i - 1]!.time < bucketMs) return true;
  }
  return false;
}

/** Rolls chronologically ordered M1 broker bars into a TradingView interval. */
export function aggregateIntradayBars(bars: readonly Bar[], resolution: ResolutionString): Bar[] {
  const minutes = Number(resolution);
  if (!Number.isInteger(minutes) || minutes <= 1) return [...bars];

  const bucketMs = minutes * 60_000;
  const result: Bar[] = [];
  for (const bar of bars) {
    const time = Math.floor(bar.time / bucketMs) * bucketMs;
    const current = result[result.length - 1];
    if (!current || current.time !== time) {
      result.push({ ...bar, time });
      continue;
    }
    current.high = Math.max(current.high, bar.high);
    current.low = Math.min(current.low, bar.low);
    current.close = bar.close;
    if (current.volume !== undefined || bar.volume !== undefined) {
      current.volume = (current.volume ?? 0) + (bar.volume ?? 0);
    }
  }
  return result;
}

/**
 * The price a quote contributes to the forming candle, or null if it carries
 * none usable.
 *
 * MT5 leaves `lastprice` at 0 for most FX symbols — there is no "last trade" on
 * a quote-driven instrument — so taking it at face value would drag the candle
 * to zero. Bid is the correct stand-in, and it is what the bars are built from
 * upstream.
 */
function formingPrice(quote: Quote): number | null {
  const last = Number(quote.last);
  if (Number.isFinite(last) && last > 0) return last;
  const bid = Number(quote.bid);
  if (Number.isFinite(bid) && bid > 0) return bid;
  return null;
}

function okQuote(
  symbol: string,
  bid: string,
  ask: string,
  last: string,
  volume: string | null,
): QuoteData {
  // MT5 leaves `last` at 0 on quote-driven instruments (all of FX): there is
  // no last TRADE, only a two-sided quote. TradingView's quote widgets key on
  // `lp`, so a literal 0 renders as "no price" beside a live bid/ask — bid is
  // the same stand-in the bars are built from upstream (TV-001).
  const lastPrice = Number(last);
  const bidPrice = Number(bid);
  const lp = Number.isFinite(lastPrice) && lastPrice > 0 ? lastPrice : bidPrice;
  return {
    n: symbol,
    s: 'ok',
    v: {
      ch: 0,
      chp: 0,
      short_name: symbol,
      exchange: '',
      description: symbol,
      lp,
      ask: Number(ask),
      bid: bidPrice,
      // The gateway's quote shape carries no session open/high/low, and
      // inventing them from the last price would draw a wrong day range.
      volume: volume === null ? 0 : Number(volume),
    },
  };
}

function errorQuote(symbol: string): QuoteData {
  return {
    n: symbol,
    s: 'error',
    v: {
      ch: 0,
      chp: 0,
      short_name: symbol,
      exchange: '',
      description: 'No data',
      lp: 0,
      ask: 0,
      bid: 0,
      volume: 0,
    },
  };
}
