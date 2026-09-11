import type { GatewayHttpClient } from './http-client';
import {
  marketDepthSchema,
  mt5SymbolDetailSchema,
  serverTimeSchema,
  tvBarListSchema,
  tvQuoteListSchema,
  tvSymbolListSchema,
  type MarketDepthDto,
  type TvBarDto,
} from '../contracts/schemas';
import { mapTvQuote, mapTvSymbol } from '../mappers/to-domain';
import type { SymbolSuffixPolicy } from '../mappers/symbol-suffix';
import type { Quote, TradingSymbol } from '@/domain/common/models';

/**
 * The raw MT5 record is supplementary — it carries volume and tick limits, not
 * anything the chart needs to draw. It is kept off the chart's critical path.
 */
const SYMBOL_DETAIL_TIMEOUT_MS = 8_000;

/**
 * Server time sits on the chart-init critical path (the library asks for it in
 * its datafeed handshake) and its only consumer degrades gracefully to the
 * local clock. During the 2026-08-24 broker outage this call rode the default
 * 20s timeout and the chart's readiness watchdog fired first — a stalled clock
 * read must lose fast, not win slowly.
 */
const SERVER_TIME_TIMEOUT_MS = 4_000;

/**
 * History rode the 30 s default with two retries — a stalled gateway cost a
 * trader 90 s of spinner before anything visible happened. Healthy history
 * answers in 200–350 ms and a loaded-but-alive gateway in 2–4 s; 5 s with ONE
 * retry keeps every legitimate answer and converts a stall into a visible
 * "chart data unavailable" state within ~11 s worst case.
 */
const HISTORY_TIMEOUT_MS = 5_000;

/**
 * Cache-generation marker on history URLs. Closed-window history responses
 * are browser-cacheable (gateway sets max-age on fully-past windows), which
 * makes a bad cached answer sticky for up to a week. During the 2026-08-24
 * gateway body-drop hour some browsers cached EMPTY closed-window answers;
 * bumping this constant changes every history URL and orphans everything
 * cached under the previous generation. Bump it whenever a server-side bug
 * may have poisoned cached history.
 */
const HISTORY_CACHE_GENERATION = '2';

/**
 * Market data reads. Every route here is verified in
 * internal/httpapi/handlers/mount.go.
 */
export class MarketApi {
  constructor(private readonly http: GatewayHttpClient) {}

  /** GET /api/Test/getServerTime — NOT enveloped (returns a bare object). */
  async serverTimeSeconds(signal?: AbortSignal): Promise<number> {
    const response = await this.http.request({
      endpoint: 'server-time',
      path: '/api/Test/getServerTime',
      schema: serverTimeSchema,
      rawBody: true,
      timeoutMs: SERVER_TIME_TIMEOUT_MS,
      retries: 0,
      signal,
    });
    return response.data.unixTimestamp;
  }

  /**
   * Server time plus the broker's clock offset (broker_clock − UTC, seconds).
   * The offset is what turns "today" into the BROKER's trading day; a gateway
   * too old to report it yields null and the caller degrades to UTC days.
   */
  async brokerClock(
    signal?: AbortSignal,
  ): Promise<{ unixTimestamp: number; brokerOffsetSeconds: number | null }> {
    const response = await this.http.request({
      endpoint: 'server-time',
      path: '/api/Test/getServerTime',
      schema: serverTimeSchema,
      rawBody: true,
      timeoutMs: SERVER_TIME_TIMEOUT_MS,
      retries: 1,
      signal,
    });
    return {
      unixTimestamp: response.data.unixTimestamp,
      brokerOffsetSeconds: response.data.brokerOffsetSeconds ?? null,
    };
  }

  /**
   * GET /api/Symbol/getsymbolsbymask?mask=&source=tv
   * An empty or "*" mask makes the gateway substitute MT5_DEFAULT_SYMBOL_LIST.
   */
  async searchSymbols(
    mask: string,
    suffix: SymbolSuffixPolicy,
    signal?: AbortSignal,
  ): Promise<TradingSymbol[]> {
    const response = await this.http.request({
      endpoint: 'symbols-by-mask',
      path: '/api/Symbol/getsymbolsbymask',
      query: { mask: maskFromSearchInput(mask), source: 'tv' },
      schema: tvSymbolListSchema,
      signal,
    });
    return response.data.map((dto) => mapTvSymbol(dto, suffix));
  }

  /** GET /api/Symbol/getsymbolsbyname?symbol=&source=tv — returns a 1-element array. */
  async symbolInfo(
    gatewaySymbol: string,
    suffix: SymbolSuffixPolicy,
    signal?: AbortSignal,
  ): Promise<TradingSymbol | null> {
    // Both records are fetched CONCURRENTLY. They are independent GETs, and
    // awaiting them in turn put two full request timeouts on the critical path
    // of drawing a chart: nothing renders until the symbol resolves, so a slow
    // gateway left the pane blank — with no loading state, because the library
    // has not asked for bars yet — for as long as both took.
    const [response, detail] = await Promise.all([
      this.http.request({
        endpoint: 'symbol-by-name',
        path: '/api/Symbol/getsymbolsbyname',
        query: { symbol: gatewaySymbol, source: 'tv' },
        schema: tvSymbolListSchema,
        signal,
      }),
      // The TV shape drops volume/contract/tick limits, so the raw MT5 record
      // is fetched too. A failure here is non-fatal — the symbol is still
      // tradable, the order ticket simply reports those limits as unavailable
      // — so it also gets a shorter budget than the record the chart needs.
      this.symbolDetail(gatewaySymbol, signal, SYMBOL_DETAIL_TIMEOUT_MS).catch(() => undefined),
    ]);

    const dto = response.data[0];
    if (!dto) return null;
    return mapTvSymbol(dto, suffix, detail);
  }

  /**
   * GET /api/Symbol/getsymbolsbyname with source=mt5 — the raw MT5 record,
   * which is the only place volume min/max/step and tick value are exposed.
   */
  async symbolDetail(gatewaySymbol: string, signal?: AbortSignal, timeoutMs?: number) {
    const response = await this.http.request({
      endpoint: 'symbol-detail',
      path: '/api/Symbol/getsymbolsbyname',
      query: { symbol: gatewaySymbol, source: 'mt5' },
      schema: mt5SymbolDetailSchema,
      unwrapAnswer: true,
      signal,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
    return response.data;
  }

  /** GET /api/Tick/last?symbol=&id=&source=tv */
  async lastQuotes(gatewaySymbol: string, signal?: AbortSignal): Promise<Quote[]> {
    const response = await this.http.request({
      endpoint: 'tick-last',
      path: '/api/Tick/last',
      query: { symbol: gatewaySymbol, id: 1, source: 'tv' },
      schema: tvQuoteListSchema,
      signal,
    });
    // Keyed by the symbol this request ASKED for — a single-symbol query whose
    // answer must land under the key the caller will read it back with,
    // whatever name MT5 echoed on the tick.
    return response.data
      .map((dto) => mapTvQuote(dto, undefined, response.receivedAt, gatewaySymbol))
      .filter((quote): quote is Quote => quote !== null);
  }

  /**
   * Intraday bars. GET /api/Tick/get?symbol=&from=&to=&data=dhloc&resolution=
   * `data=dhloc` is the gateway's DefaultChartData and is required.
   *
   * `resolution` ("5", "60", "120", …) asks the gateway to aggregate M1 into
   * that timeframe server-side — a 6-month 2h window is a few hundred bars
   * instead of ~8 MB of M1. "1" (or a gateway too old to know the parameter)
   * returns raw M1; the datafeed detects that shape and folds it client-side,
   * so the two deployments can roll out in either order.
   */
  async intradayBars(
    params: { symbol: string; from: number; to: number; resolution: string },
    signal?: AbortSignal,
  ): Promise<TvBarDto[]> {
    const response = await this.http.request({
      endpoint: 'bars-intraday',
      path: '/api/Tick/get',
      query: {
        symbol: params.symbol,
        from: params.from,
        to: params.to,
        data: 'dhloc',
        resolution: params.resolution,
        cg: HISTORY_CACHE_GENERATION,
      },
      schema: tvBarListSchema,
      signal,
      timeoutMs: HISTORY_TIMEOUT_MS,
      retries: 1,
    });
    return response.data;
  }

  /** Daily/weekly/monthly bars. GET /api/Tick/getHistoryby1Dresolution */
  async dailyBars(
    params: { symbol: string; from: number; to: number; resolution: string },
    signal?: AbortSignal,
  ): Promise<TvBarDto[]> {
    const response = await this.http.request({
      endpoint: 'bars-daily',
      path: '/api/Tick/getHistoryby1Dresolution',
      query: {
        symbol: params.symbol,
        from: params.from,
        to: params.to,
        resolution: params.resolution,
        data: 'dhloc',
        cg: HISTORY_CACHE_GENERATION,
      },
      schema: tvBarListSchema,
      signal,
      timeoutMs: HISTORY_TIMEOUT_MS,
      retries: 1,
    });
    return response.data;
  }

  /**
   * GET /api/Tick/get_marketdepth — the classified order book.
   *
   * The gateway splits the raw MT5 book into bids and asks and declares its own
   * volume unit, so the ladder reports depth rather than inferring it.
   */
  async marketDepth(gatewaySymbol: string, signal?: AbortSignal): Promise<MarketDepthDto> {
    const response = await this.http.request({
      endpoint: 'market-depth',
      path: '/api/Tick/get_marketdepth',
      query: { symbol: gatewaySymbol },
      schema: marketDepthSchema,
      signal,
      timeoutMs: 10_000,
    });
    return response.data;
  }
}

/**
 * Turns what a trader TYPED into the mask MT5 expects.
 *
 * The gateway hands the mask verbatim to MT5's /api/symbol/get, and MT5 masks
 * are wildcard PATTERNS, not substring searches: "USD" matches only a symbol
 * literally named USD, which is why searching "USD" or "XAU" returned "No
 * symbols match your criteria" for symbols sitting right in the watchlist
 * (2026-08-24 QA). Plain text is therefore wrapped as *TEXT*.
 *
 * Input that already uses MT5's pattern language — '*' wildcards, ','-separated
 * lists, '!' exclusions — passes through untouched, as does the empty/"*" mask
 * the gateway replaces with its default list.
 */
export function maskFromSearchInput(input: string): string {
  const trimmed = input.trim().toUpperCase();
  if (trimmed === '' || trimmed === '*') return trimmed;
  if (/[*,!]/.test(trimmed)) return trimmed;
  return `*${trimmed}*`;
}
