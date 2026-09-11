/**
 * Type-only stand-in for the licensed TradingView charting library types.
 *
 * WHY THIS EXISTS
 * ---------------
 * The real `.d.ts` files ship inside TradingView's licensed package and are
 * git-ignored (`/vendor/tradingview/`). CI restored them from the production
 * host using DEPLOY_SSH_KEY — a key with WRITE access to the production web
 * root — and deliberately withheld that fallback on `pull_request`, because a
 * pull request can edit the workflow and exfiltrate any secret it can reach.
 * The consequence was that no pull request could ever pass CI, so the only way
 * to ship was pushing straight to `main`. On a live-money trading terminal that
 * is the wrong trade-off: it removes the review gate entirely.
 *
 * This file is HAND-WRITTEN from how the application actually uses the library.
 * It is deliberately NOT a copy of the licensed declarations — nothing licensed
 * may enter this repository.
 *
 * WHAT IT IS AND IS NOT
 * ---------------------
 * It is a compile-time stand-in so `tsc`, `eslint` and `vitest` can run on an
 * untrusted pull request with no access to licensed material. It is NOT the
 * authority on the library's contract: `push` builds restore the real types and
 * typecheck against them, and that run is what may be trusted. CI also
 * typechecks against THIS file on `push`, so if the shim drifts far enough to
 * stop accepting the app, `main` says so instead of pull requests quietly
 * losing coverage.
 *
 * Fidelity is uneven on purpose. Shapes the app reads fields off — orders,
 * positions, brackets, depth, instrument info — are modelled properly, because
 * that is where a type error would actually cost something. Pure pass-through
 * tokens the app never inspects (theme names, resolutions, formatter names) are
 * opaque aliases; pretending to model them would be invention, not safety.
 *
 * The single import site is `src/integrations/tradingview/types.ts`. Everything
 * here exists to satisfy that file.
 */

// ── opaque pass-through tokens ───────────────────────────────────────────────
// The app forwards these to the library without ever inspecting them. Branded
// rather than bare `string` so an accidental raw assignment still fails, which
// is how the real declarations behave.

export type ResolutionString = string & { __resolution?: never };
export type ThemeName = 'light' | 'dark';
export type LanguageCode = string;
export type AccountId = string & { __accountId?: never };
export type StandardFormatterName = string & { __formatter?: never };
export type TradingTerminalFeatureset = string;
export type NotificationType = number;

// ── enums (declared enums in the real package: type-level only) ──────────────

export declare enum OrderType {
  Limit = 1,
  Market = 2,
  Stop = 3,
  StopLimit = 4,
}

export declare enum OrderStatus {
  Canceled = 1,
  Filled = 2,
  Inactive = 3,
  Placing = 4,
  Rejected = 5,
  Working = 6,
}

export declare enum Side {
  Buy = 1,
  Sell = -1,
}

export declare enum ParentType {
  Order = 1,
  Position = 2,
  IndividualPosition = 3,
}

// ── trading shapes ──────────────────────────────────────────────────────────

export interface Brackets {
  stopLoss?: number;
  takeProfit?: number;
  trailingStopPips?: number;
  guaranteedStop?: boolean;
}

export interface PreOrder {
  symbol: string;
  side: Side;
  type: OrderType;
  qty: number;
  limitPrice?: number;
  stopPrice?: number;
  stopLoss?: number;
  takeProfit?: number;
  trailingStopPips?: number;
  currentQuotes?: unknown;
}

export interface Order {
  id: string;
  symbol: string;
  qty: number;
  side: Side;
  type: OrderType;
  status: OrderStatus;
  limitPrice?: number;
  stopPrice?: number;
  stopLoss?: number;
  takeProfit?: number;
  filledQty?: number;
  avgPrice?: number;
  updateTime?: number;
  /** Present only on bracket orders. See ParentType. */
  parentId?: string;
  parentType?: ParentType;
  [custom: string]: unknown;
}

/** A bracket is an Order whose parent linkage is mandatory. */
export interface BracketOrder extends Order {
  parentId: string;
  parentType: ParentType;
}

export interface Position {
  id: string;
  symbol: string;
  qty: number;
  side: Side;
  avgPrice: number;
  stopLoss?: number;
  takeProfit?: number;
  profit?: number;
  [custom: string]: unknown;
}

export interface Execution {
  symbol: string;
  price: number;
  qty: number;
  side: Side;
  time: number;
}

export interface PlaceOrderResult {
  orderId?: string;
}

export interface INumberFormatter {
  format(value?: number, options?: unknown): string;
  formatChange?(currentPrice: number, prevPrice: number, options?: unknown): string;
  parse?(value: string, options?: unknown): unknown;
}

export interface InstrumentInfo {
  qty: { min: number; max: number; step: number; default?: number; uiStep?: number };
  pipValue: number;
  pipSize: number;
  minTick: number;
  description: string;
  currency?: string;
  /** Label for the quantity field; ours is in lots. */
  units?: string;
  [custom: string]: unknown;
}

/** Leverage: account-level, and only where the broker permits changing it. */
export interface LeverageInfo {
  title: string;
  leverage: number;
  min: number;
  max: number;
  step: number;
}

export interface LeveragePreviewResult {
  infos?: string[];
  warnings?: string[];
  errors?: string[];
}

export interface LeverageSetResult {
  leverage: number;
}

export interface TradeContext {
  symbol: string;
  last?: number;
  value?: number;
  formattedValue?: string;
}

export interface DefaultContextMenuActionsParams {
  disabledItems?: string[];
}

export type ActionMetaInfo = Record<string, unknown>;

// ── depth of market ─────────────────────────────────────────────────────────

export interface DOMLevel {
  price: number;
  volume: number;
}

export interface DOMData {
  snapshot: boolean;
  asks: DOMLevel[];
  bids: DOMLevel[];
}

// ── account manager ─────────────────────────────────────────────────────────

export interface IWatchedValue<T> {
  value(): T;
  setValue(value: T, forceUpdate?: boolean): void;
  subscribe(callback: (value: T) => void, options?: unknown): void;
  unsubscribe(callback?: (value: T) => void): void;
}

export interface AccountManagerColumn {
  id: string;
  label: string;
  dataFields: string[];
  formatter?: StandardFormatterName;
  alignment?: string;
  [custom: string]: unknown;
}

export type OrderTableColumn = AccountManagerColumn;

export interface AccountManagerSummaryField {
  text: string;
  wValue: IWatchedValue<number>;
  formatter?: StandardFormatterName;
  isDefault?: boolean;
}

export interface AccountManagerInfo {
  accountTitle: string;
  summary: AccountManagerSummaryField[];
  marginUsed?: IWatchedValue<number>;
  orderColumns: OrderTableColumn[];
  positionColumns?: AccountManagerColumn[];
  pages: unknown[];
  [custom: string]: unknown;
}

export interface AccountMetainfo {
  id: AccountId;
  name: string;
}

// ── broker host ─────────────────────────────────────────────────────────────

export interface IBrokerConnectionAdapterHost {
  factory: {
    createWatchedValue<T>(value: T): IWatchedValue<T>;
    createDelegate<T = unknown>(): T;
  };
  connectionStatusUpdate(status: number): void;
  currentAccountUpdate(): void;
  orderUpdate(order: Order): void;
  positionUpdate(position: Position): void;
  equityUpdate(equity: number): void;
  domUpdate(symbol: string, data: DOMData): void;
  realtimeUpdate(symbol: string, data: unknown): void;
  showNotification(title: string, text: string, type?: NotificationType): void;
  getSymbolMinTick(symbol: string): Promise<number>;
  setQty(symbol: string, quantity: number): void;
  getQty(symbol: string): Promise<number>;
  defaultContextMenuActions(
    context: TradeContext,
    params?: DefaultContextMenuActionsParams,
  ): Promise<ActionMetaInfo[]>;
  [custom: string]: unknown;
}

/**
 * Structural only. The app's adapter is checked against the REAL interface on
 * `push`; asserting the full member list here would just be a second, weaker
 * copy of it that drifts.
 */
export type IBrokerTerminal = Record<string, unknown>;

// ── datafeed ────────────────────────────────────────────────────────────────

export interface Bar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export interface QuoteData {
  s: 'ok' | 'error';
  n: string;
  v: Record<string, unknown>;
}

export interface LibrarySymbolInfo {
  name: string;
  full_name?: string;
  description: string;
  type: string;
  session: string;
  timezone: string;
  exchange: string;
  listed_exchange: string;
  format: 'price' | 'volume';
  pricescale: number;
  minmov: number;
  supported_resolutions: ResolutionString[];
  ticker?: string;
  has_intraday?: boolean;
  has_seconds?: boolean;
  has_daily?: boolean;
  has_weekly_and_monthly?: boolean;
  currency_code?: string;
  sector?: string;
  industry?: string;
  volume_precision?: number;
  data_status?: string;
  logo_urls?: [string] | [string, string];
  [custom: string]: unknown;
}

export interface SearchSymbolResultItem {
  symbol: string;
  full_name: string;
  description: string;
  exchange: string;
  ticker?: string;
  type: string;
  logo_urls?: [string] | [string, string];
}

export interface DatafeedConfiguration {
  supported_resolutions?: ResolutionString[];
  exchanges?: unknown[];
  symbols_types?: unknown[];
  supports_marks?: boolean;
  supports_time?: boolean;
  supports_timescale_marks?: boolean;
  [custom: string]: unknown;
}

export interface PeriodParams {
  from: number;
  to: number;
  countBack: number;
  firstDataRequest: boolean;
}

export type OnReadyCallback = (configuration: DatafeedConfiguration) => void;
export type ResolveCallback = (symbolInfo: LibrarySymbolInfo) => void;
export type DatafeedErrorCallback = (reason: string) => void;
export type HistoryCallback = (bars: Bar[], meta?: { noData?: boolean; nextTime?: number }) => void;
export type SubscribeBarsCallback = (bar: Bar) => void;
export type SearchSymbolsCallback = (items: SearchSymbolResultItem[]) => void;
export type QuotesCallback = (data: QuoteData[]) => void;
export type QuotesErrorCallback = (reason: string) => void;
export type ServerTimeCallback = (serverTime: number) => void;

export interface IExternalDatafeed {
  onReady(callback: OnReadyCallback): void;
}

export interface IDatafeedChartApi {
  resolveSymbol(
    symbolName: string,
    onResolve: ResolveCallback,
    onError: DatafeedErrorCallback,
    extension?: unknown,
  ): void;
  getBars(
    symbolInfo: LibrarySymbolInfo,
    resolution: ResolutionString,
    periodParams: PeriodParams,
    onResult: HistoryCallback,
    onError: DatafeedErrorCallback,
  ): void;
  subscribeBars(
    symbolInfo: LibrarySymbolInfo,
    resolution: ResolutionString,
    onTick: SubscribeBarsCallback,
    listenerGuid: string,
    onResetCacheNeededCallback: () => void,
  ): void;
  unsubscribeBars(listenerGuid: string): void;
  searchSymbols?(
    userInput: string,
    exchange: string,
    symbolType: string,
    onResult: SearchSymbolsCallback,
  ): void;
  getServerTime?(callback: ServerTimeCallback): void;
}

export interface IDatafeedQuotesApi {
  getQuotes(symbols: string[], onData: QuotesCallback, onError: QuotesErrorCallback): void;
  subscribeQuotes(
    symbols: string[],
    fastSymbols: string[],
    onRealtimeCallback: QuotesCallback,
    listenerGuid: string,
  ): void;
  unsubscribeQuotes(listenerGuid: string): void;
}

export type IBasicDataFeed = IExternalDatafeed & IDatafeedChartApi;

// ── save/load ───────────────────────────────────────────────────────────────

export interface IExternalSaveLoadAdapter {
  getAllCharts(): Promise<unknown[]>;
  removeChart(id: string | number): Promise<void>;
  saveChart(chartData: unknown): Promise<string>;
  getChartContent(id: string | number): Promise<string>;
}

// ── widget ──────────────────────────────────────────────────────────────────

export interface IChartingLibraryWidget {
  onChartReady(callback: () => void): void;
  headerReady(): Promise<void>;
  remove(): void;
  changeTheme(theme: ThemeName): Promise<void>;
  activeChart(): {
    setSymbol(symbol: string, callback?: () => void): void;
    setResolution(resolution: ResolutionString, callback?: () => void): void;
    symbol(): string;
    resolution(): ResolutionString;
    onSymbolChanged(): { subscribe(obj: unknown, callback: (symbol: string) => void): void };
    onIntervalChanged(): {
      subscribe(obj: unknown, callback: (interval: ResolutionString) => void): void;
    };
    getPanes(): {
      getMainSourcePriceScale(): {
        getVisiblePriceRange(): { from: number; to: number } | null;
        setVisiblePriceRange(range: { from: number; to: number }): void;
      } | null;
    }[];
    // The delivered-vs-applied watchdog asks the series whether it actually
    // holds bars. Only `data.length` is read; the library returns one typed
    // array per bar, so that is what is modelled.
    exportData(options?: {
      from?: number;
      to?: number;
      includeTime?: boolean;
      includeUserTime?: boolean;
      includeSeries?: boolean;
      includeDisplayedValues?: boolean;
      includedStudies?: readonly string[] | 'all';
    }): Promise<{ data: Float64Array[] }>;
    [custom: string]: unknown;
  };
  subscribe(event: string, callback: (...args: unknown[]) => void): void;
  takeClientScreenshot(): Promise<HTMLCanvasElement>;
  save(callback: (state: unknown) => void): void;
  load(state: unknown): void;
  crash?(): void;
  [custom: string]: unknown;
}

export interface ChartingLibraryWidgetOptions {
  container: HTMLElement | string;
  library_path: string;
  symbol?: string;
  interval?: ResolutionString;
  locale?: LanguageCode;
  theme?: ThemeName;
  timezone?: string;
  datafeed: IBasicDataFeed & Partial<IDatafeedQuotesApi>;
  autosize?: boolean;
  debug?: boolean;
  disabled_features?: TradingTerminalFeatureset[];
  enabled_features?: TradingTerminalFeatureset[];
  save_load_adapter?: IExternalSaveLoadAdapter;
  auto_save_delay?: number;
  load_last_chart?: boolean;
  [custom: string]: unknown;
}

/** The Trading Platform variant: it is the one that accepts broker wiring. */
export interface TradingTerminalWidgetOptions extends ChartingLibraryWidgetOptions {
  broker_factory?: (host: IBrokerConnectionAdapterHost) => IBrokerTerminal;
  broker_config?: { configFlags?: Record<string, unknown> };
  debug_broker?: 'normal' | 'broker-only' | 'all';
}
