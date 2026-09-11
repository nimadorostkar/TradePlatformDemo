import { useCallback, useSyncExternalStore } from 'react';
import type { Quote } from '@/domain/common/models';
import { isQuoteStale, quoteAgeMs } from '@/domain/market/quote-staleness';

/**
 * Quote store.
 *
 * Deliberately NOT Zustand and NOT React context. Quotes tick several times a
 * second across dozens of symbols; a context provider would re-render every
 * consumer in the tree on every tick.
 *
 * Instead each SYMBOL has its own listener set, so a EURUSD tick notifies only
 * the components displaying EURUSD. `useQuote(symbol)` subscribes through
 * `useSyncExternalStore`, giving a single targeted re-render per affected cell.
 */

type Listener = () => void;

/**
 * Smallest gap between two fan-outs, in ms.
 *
 * One frame at 60Hz. Prices cannot be perceived faster than the screen paints,
 * so nothing is lost by rendering at most this often — and the store's map is
 * written synchronously regardless, so a component that renders for any other
 * reason still reads the newest price.
 */
const FLUSH_INTERVAL_MS = 16;

class QuoteStore {
  private quotes = new Map<string, Quote>();
  private listenersBySymbol = new Map<string, Set<Listener>>();
  private globalListeners = new Set<Listener>();
  /** Symbols changed since the last fan-out; see `scheduleFlush`. */
  private dirty = new Set<string>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private lastFlushAt = 0;

  get(symbol: string): Quote | undefined {
    return this.quotes.get(symbol);
  }

  snapshot(): ReadonlyMap<string, Quote> {
    return this.quotes;
  }

  /**
   * Applies a quote. Carries forward the previous value to compute the tick
   * direction used by the flash indicator.
   */
  apply(next: Omit<Quote, 'direction'>): void {
    const previous = this.quotes.get(next.symbol);

    let direction: Quote['direction'] = 'flat';
    if (previous) {
      const delta = Number(next.last) - Number(previous.last);
      // A tick with no price change keeps the previous arrow rather than
      // flickering to neutral.
      direction = delta > 0 ? 'up' : delta < 0 ? 'down' : previous.direction;

      // Skip the notify entirely when nothing a user can see has changed.
      if (previous.bid === next.bid && previous.ask === next.ask && previous.last === next.last) {
        // Still record both timestamps. A quiet market reprints the SAME price
        // with a newer broker time; dropping that would let a perfectly live
        // instrument decay into a false "stale" badge just for not moving.
        this.quotes.set(next.symbol, {
          ...previous,
          receivedAt: next.receivedAt,
          brokerTime: next.brokerTime,
        });
        return;
      }
    }

    this.quotes.set(next.symbol, { ...next, direction });
    this.scheduleFlush(next.symbol);
  }

  /** Drops every quote. Used on account switch so prices cannot leak across. */
  clear(): void {
    for (const symbol of this.quotes.keys()) this.dirty.add(symbol);
    this.quotes.clear();
    // Immediately, not on the throttle: the previous account's prices must
    // leave the screen the instant they stop being true.
    this.flush();
  }

  subscribeSymbol(symbol: string, listener: Listener): () => void {
    let set = this.listenersBySymbol.get(symbol);
    if (!set) {
      set = new Set();
      this.listenersBySymbol.set(symbol, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
      if (set?.size === 0) this.listenersBySymbol.delete(symbol);
    };
  }

  subscribeAll(listener: Listener): () => void {
    this.globalListeners.add(listener);
    return () => this.globalListeners.delete(listener);
  }

  /**
   * Fans out at most once per FLUSH_INTERVAL_MS, for every symbol at once.
   *
   * Notifying synchronously per frame made every quote a separate synchronous
   * React render. Under a burst — a reconnect backlog, a fast broker, or
   * simply many symbols arriving together — those renders pile up faster than
   * React will accept and it aborts with "Maximum update depth exceeded",
   * which is a real exception in the production console on load.
   *
   * Coalescing per task was measured and was not enough: the frames arrive as
   * separate tasks, one message each, so there is nothing for a microtask to
   * merge. Only a gap measured in TIME collapses them, and this one collapses
   * a 200-frame burst into a handful of renders.
   *
   * A timer rather than requestAnimationFrame, deliberately: rAF does not run
   * in a hidden tab, and a backgrounded terminal must keep processing quotes
   * (the chart pane carries its own scars from exactly that).
   */
  private scheduleFlush(symbol: string): void {
    this.dirty.add(symbol);
    if (this.flushTimer !== null) return;
    const sinceLast = Date.now() - this.lastFlushAt;
    const delay = Math.max(0, FLUSH_INTERVAL_MS - sinceLast);
    this.flushTimer = setTimeout(() => this.flush(), delay);
  }

  private flush(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.lastFlushAt = Date.now();
    if (this.dirty.size === 0) return;

    const symbols = [...this.dirty];
    this.dirty.clear();
    for (const symbol of symbols) {
      const set = this.listenersBySymbol.get(symbol);
      if (set) for (const listener of set) listener();
    }
    for (const listener of this.globalListeners) listener();
  }
}

export const quoteStore = new QuoteStore();

/**
 * Subscribes one component to one symbol.
 *
 * `subscribe` and `getSnapshot` must keep their identity between renders —
 * React re-subscribes whenever `subscribe` changes. Inline closures handed it
 * a new one on every render, so every re-render tore the listener down and
 * registered it again, re-reading the snapshot as it went: pointless churn on
 * the hottest path in the product, repeated per quote cell per tick.
 */
export function useQuote(symbol: string | null): Quote | undefined {
  const subscribe = useCallback(
    (listener: Listener) => (symbol ? quoteStore.subscribeSymbol(symbol, listener) : () => {}),
    [symbol],
  );
  const getSnapshot = useCallback(() => (symbol ? quoteStore.get(symbol) : undefined), [symbol]);
  return useSyncExternalStore(subscribe, getSnapshot, noQuote);
}

/** Stable hydration snapshot — a fresh closure here defeats the point. */
function noQuote(): undefined {
  return undefined;
}

/**
 * Shared re-render tick for staleness.
 *
 * A quote going stale is the absence of an event, so nothing in the store will
 * ever announce it — only a clock can. One module-level interval serves every
 * subscriber: a virtualised watchlist can have dozens of price cells mounted,
 * and giving each its own timer would put dozens of wakeups on the main thread
 * to answer a question that changes at most once every few seconds.
 */
const STALENESS_TICK_MS = 5_000;
const stalenessListeners = new Set<Listener>();
let stalenessTimer: ReturnType<typeof setInterval> | null = null;

function subscribeStalenessTick(listener: Listener): () => void {
  stalenessListeners.add(listener);
  if (stalenessTimer === null) {
    stalenessTimer = setInterval(() => {
      for (const l of stalenessListeners) l();
    }, STALENESS_TICK_MS);
  }
  return () => {
    stalenessListeners.delete(listener);
    if (stalenessListeners.size === 0 && stalenessTimer !== null) {
      clearInterval(stalenessTimer);
      stalenessTimer = null;
    }
  };
}

/**
 * Re-renders the caller every few seconds.
 *
 * The snapshot is the tick BUCKET rather than the raw clock, so it stays stable
 * between ticks — `useSyncExternalStore` loops forever on a snapshot that
 * changes on every read.
 */
function useStalenessTick(): number {
  return useSyncExternalStore(
    subscribeStalenessTick,
    () => Math.floor(Date.now() / STALENESS_TICK_MS),
    () => 0,
  );
}

/**
 * Live quote plus whether the broker's timestamp says it has gone stale.
 *
 * Staleness never suppresses the price — a trader still needs to see the last
 * known number — it only marks it as not current.
 */
export function useQuoteWithStaleness(symbol: string | null): {
  quote: Quote | undefined;
  stale: boolean;
  ageMs: number | null;
} {
  const quote = useQuote(symbol);
  useStalenessTick();
  const now = Date.now();
  return { quote, stale: isQuoteStale(quote, now), ageMs: quoteAgeMs(quote, now) };
}

/** Spread in price units, or null when either side is missing. */
export function spreadOf(quote: Quote | undefined): number | null {
  if (!quote) return null;
  const spread = Number(quote.ask) - Number(quote.bid);
  return Number.isFinite(spread) ? spread : null;
}
