/**
 * Typed access to the licensed TradingView library.
 *
 * The library is loaded as a classic script from `library_path` (it is not a
 * bundleable module — it fetches its own chunks relative to that path), so it
 * arrives on `window.TradingView`. This module is the ONE place that reaches
 * for the global; everywhere else consumes the typed facade.
 *
 * Types come from vendor/tradingview/types, populated by `npm run tv:sync`.
 * They are re-exported here so no feature file imports from a vendor path.
 */

import type {
  ChartingLibraryWidgetOptions,
  IChartingLibraryWidget,
  IExternalSaveLoadAdapter,
  LanguageCode,
  ResolutionString,
  ThemeName,
  TradingTerminalWidgetOptions,
} from '@tv/types/charting_library';

export type {
  Bar,
  ChartingLibraryWidgetOptions,
  IDatafeedChartApi,
  IExternalDatafeed,
  TradingTerminalWidgetOptions,
  DatafeedConfiguration,
  DatafeedErrorCallback,
  HistoryCallback,
  IBasicDataFeed,
  IChartingLibraryWidget,
  IDatafeedQuotesApi,
  IExternalSaveLoadAdapter,
  INumberFormatter,
  LeverageInfo,
  LeveragePreviewResult,
  LeverageSetResult,
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
  ThemeName,
  TradingTerminalFeatureset,
} from '@tv/types/charting_library';

/**
 * Broker types come from `charting_library.d.ts`, NOT from `broker-api.d.ts`.
 *
 * Both files declare the same shapes, but as separate nominal declarations —
 * mixing them makes `broker_factory` fail to typecheck because the two
 * `IBrokerConnectionAdapterHost` types are considered unrelated. Sourcing every
 * broker type from the one file the widget options also reference keeps them
 * identical.
 */
export type {
  AccountId,
  AccountManagerColumn,
  AccountManagerInfo,
  AccountManagerSummaryField,
  AccountMetainfo,
  ActionMetaInfo,
  BracketOrder,
  Brackets,
  IWatchedValue,
  OrderTableColumn,
  StandardFormatterName,
  DefaultContextMenuActionsParams,
  DOMData,
  DOMLevel,
  Execution,
  IBrokerConnectionAdapterHost,
  IBrokerTerminal,
  InstrumentInfo,
  NotificationType,
  Order,
  OrderStatus,
  OrderType,
  ParentType,
  PlaceOrderResult,
  Position,
  PreOrder,
  Side,
  TradeContext,
} from '@tv/types/charting_library';

/**
 * Numeric values for the library's enums.
 *
 * The enums are `declare enum` inside a .d.ts, so they exist only at type level
 * — there is no runtime module to import them from. These constants mirror the
 * declared values and are the single place they appear.
 */
export const TV_SIDE = { Buy: 1, Sell: -1 } as const;
export const TV_ORDER_TYPE = { Limit: 1, Market: 2, Stop: 3, StopLimit: 4 } as const;
export const TV_ORDER_STATUS = {
  Canceled: 1,
  Filled: 2,
  Inactive: 3,
  Placing: 4,
  Rejected: 5,
  Working: 6,
} as const;
export const TV_NOTIFICATION_TYPE = { Error: 0, Success: 1 } as const;
export const TV_CONNECTION_STATUS = { Connected: 1, Connecting: 2, Error: 3 } as const;
/**
 * What a bracket order hangs off. A bracket carrying `parentId` plus one of
 * these is what makes the library render it as a first-class object — its own
 * chart line with a close button, its own Account Manager row, its own Cancel
 * action. Without both fields SL/TP stay invisible scalars on the parent.
 */
export const TV_PARENT_TYPE = { Order: 1, Position: 2, IndividualPosition: 3 } as const;

/**
 * The library's own constructor signature, as exposed on the global.
 * `TradingTerminalWidgetOptions` is the Trading Platform variant — it is the
 * one that accepts `broker_factory`, and its featureset union is wider than the
 * Advanced Charts one.
 */
export interface TradingViewGlobal {
  widget: new (
    options: ChartingLibraryWidgetOptions | TradingTerminalWidgetOptions,
  ) => IChartingLibraryWidget;
  version?: () => string;
}

declare global {
  interface Window {
    TradingView?: TradingViewGlobal;
  }
}

export class TradingViewNotLoadedError extends Error {
  constructor(libraryPath: string) {
    super(
      `The TradingView library did not load from "${libraryPath}". ` +
        'Run `npm run tv:sync` to copy the licensed package into public/charting_library.',
    );
    this.name = 'TradingViewNotLoadedError';
  }
}

let loadPromise: Promise<TradingViewGlobal> | null = null;

/**
 * Loads the library script once and resolves with the global.
 *
 * Deliberately NOT bundled: the library resolves its own chunk URLs against
 * `library_path` at runtime, so it must be served as static assets. There is
 * no fallback to a public TradingView widget — an unlicensed widget would show
 * the wrong (non-broker) prices, which is worse than showing an error.
 */
export function loadTradingView(libraryPath: string): Promise<TradingViewGlobal> {
  if (window.TradingView) return Promise.resolve(window.TradingView);
  if (loadPromise) return loadPromise;

  const scriptSrc = `${libraryPath.replace(/\/+$/, '')}/charting_library.standalone.js`;

  const pending = new Promise<TradingViewGlobal>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${scriptSrc}"]`);
    if (existing) {
      existing.addEventListener(
        'load',
        () => {
          if (window.TradingView) resolve(window.TradingView);
          else {
            existing.remove();
            reject(new TradingViewNotLoadedError(libraryPath));
          }
        },
        { once: true },
      );
      existing.addEventListener(
        'error',
        () => {
          existing.remove();
          reject(new TradingViewNotLoadedError(libraryPath));
        },
        { once: true },
      );
      return;
    }

    const script = document.createElement('script');
    script.src = scriptSrc;
    script.async = true;
    script.onload = () => {
      if (window.TradingView) resolve(window.TradingView);
      else {
        script.remove();
        reject(new TradingViewNotLoadedError(libraryPath));
      }
    };
    script.onerror = () => {
      script.remove();
      reject(new TradingViewNotLoadedError(libraryPath));
    };
    document.head.appendChild(script);
  });

  // A transient CDN/origin/network failure must not poison the loader for the
  // rest of the page lifetime. The failed element is removed above, and the
  // cached promise is cleared here so a reconnect can try again.
  loadPromise = pending.catch((error: unknown) => {
    loadPromise = null;
    throw error;
  });

  return loadPromise;
}

/** Maps our theme preference onto the library's ThemeName. */
export function toTradingViewTheme(theme: 'dark' | 'light'): ThemeName {
  return theme as ThemeName;
}

export function toResolution(interval: string): ResolutionString {
  return interval as ResolutionString;
}

export type SaveLoadAdapter = IExternalSaveLoadAdapter;
export type LibraryLanguage = LanguageCode;
