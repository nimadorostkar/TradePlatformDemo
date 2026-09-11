import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useServices } from '@/app/providers/services';
import { tvBarListSchema, tvQuoteListSchema } from '@/integrations/gateway/contracts/schemas';
import { mapTvQuote } from '@/integrations/gateway/mappers/to-domain';
import { quoteStore } from '@/stores/quote-store';
import { useSessionStore } from '@/stores/session-store';
import {
  aggregate,
  applyTick,
  formingPrice,
  fromDto,
  intervalSeconds,
  isDailyInterval,
  looksLikeRawM1,
  mergeStreamBar,
  normalize,
  type Bar,
  type Interval,
} from './bars';

/** Bars requested per history page, sized so the first paint fills a pane. */
const PAGE_BARS = 500;
/** Monthly history is capped: 30-day buckets × 500 would ask for 40 years. */
const MAX_MONTHLY_YEARS = 20;

export type SeriesStatus = 'loading' | 'ready' | 'empty' | 'error';

export interface ChartSeries {
  /** The full history, oldest first. Replaced (new array) when a page loads. */
  bars: readonly Bar[];
  /** The most recently changed candle, for incremental updates. */
  lastBar: Bar | null;
  status: SeriesStatus;
  error: Error | null;
  /** True once a page came back empty: there is nothing older to fetch. */
  exhausted: boolean;
  /** True while an earlier page is being fetched. */
  loadingEarlier: boolean;
  loadEarlier: () => void;
  retry: () => void;
}

interface Window {
  from: number;
  to: number;
}

function pageWindow(interval: Interval, to: number): Window {
  const span = Math.min(
    PAGE_BARS * intervalSeconds(interval),
    interval === '1M' ? MAX_MONTHLY_YEARS * 365 * 86_400 : Number.POSITIVE_INFINITY,
  );
  return { from: Math.max(0, to - span), to };
}

/**
 * Candles for one symbol at one interval: paged history from the gateway plus
 * the live bar stream and quote ticks that keep the forming candle moving.
 *
 * Suffix-aware: the gateway symbol depends on the active account's group, so an
 * account switch reloads the series for the same display symbol.
 */
export function useChartSeries(displaySymbol: string, interval: Interval): ChartSeries {
  const services = useServices();
  const suffixPolicy = useSessionStore((s) => s.suffixPolicy);
  const gatewaySymbol = useMemo(
    () => suffixPolicy.toGateway(displaySymbol),
    [suffixPolicy, displaySymbol],
  );

  const [bars, setBars] = useState<readonly Bar[]>([]);
  const [lastBar, setLastBar] = useState<Bar | null>(null);
  const [status, setStatus] = useState<SeriesStatus>('loading');
  const [error, setError] = useState<Error | null>(null);
  const [exhausted, setExhausted] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [attempt, setAttempt] = useState(0);

  // The series the live handlers mutate, kept in a ref so a tick does not
  // depend on React having flushed the last render.
  const barsRef = useRef<Bar[]>([]);
  const oldestRef = useRef<number | null>(null);
  const exhaustedRef = useRef(false);
  const earlierInFlight = useRef(false);

  const fetchPage = useCallback(
    async (window: Window, signal: AbortSignal): Promise<Bar[]> => {
      const params = {
        symbol: gatewaySymbol,
        from: window.from,
        to: window.to,
        resolution: interval,
      };
      const dtos = isDailyInterval(interval)
        ? await services.market.dailyBars(params, signal)
        : await services.market.intradayBars(params, signal);
      let page = normalize(dtos.map(fromDto).filter((bar): bar is Bar => bar !== null));
      if (looksLikeRawM1(page, interval)) page = aggregate(page, interval);
      return page;
    },
    [services.market, gatewaySymbol, interval],
  );

  // Initial history for this (symbol, interval, account) — and the live
  // streams, opened only once the first page is in so a stream frame never
  // races the history it must extend.
  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    let unsubscribe: (() => void) | null = null;

    barsRef.current = [];
    oldestRef.current = null;
    exhaustedRef.current = false;
    setBars([]);
    setLastBar(null);
    setStatus('loading');
    setError(null);
    setExhausted(false);
    setLoadingEarlier(false);

    const publish = (next: Bar) => {
      const series = barsRef.current;
      const last = series[series.length - 1];
      if (last && next.time === last.time) series[series.length - 1] = next;
      else series.push(next);
      setLastBar(next);
    };

    const openStreams = (): (() => void) => {
      const daily = isDailyInterval(interval);
      const stopBars = services.pool.subscribe(
        { family: daily ? 'daily-bar' : 'intraday-bar', symbol: gatewaySymbol },
        (frame) => {
          const parsed = tvBarListSchema.safeParse(frame);
          if (!parsed.success || parsed.data.length === 0) return;
          let incoming = normalize(
            parsed.data.map(fromDto).filter((bar): bar is Bar => bar !== null),
          );
          if (incoming.length === 0) return;
          // Intraday frames are an M1 window: roll them into the interval first.
          if (!daily) incoming = aggregate(incoming, interval);
          for (const bar of incoming) {
            const merged = mergeStreamBar(
              barsRef.current[barsRef.current.length - 1],
              bar,
              interval,
            );
            if (merged) publish(merged);
          }
        },
      );
      // The forming candle follows quotes between bar pushes (intraday only —
      // see applyTick). The frame also feeds the shared quote store so the
      // watchlist and ticket see the same tick without another socket.
      const stopQuotes = daily
        ? () => {}
        : services.pool.subscribe({ family: 'quote', symbol: gatewaySymbol }, (frame, meta) => {
            const parsed = tvQuoteListSchema.safeParse(frame);
            const dto = parsed.success ? parsed.data[0] : undefined;
            if (!dto) return;
            const quote = mapTvQuote(
              dto,
              quoteStore.get(gatewaySymbol),
              meta.receivedAt,
              gatewaySymbol,
            );
            if (quote === null) return;
            quoteStore.apply(quote);
            const price = formingPrice(quote);
            if (price === null) return;
            const at = quote.brokerTime !== null ? quote.brokerTime / 1000 : meta.receivedAt / 1000;
            const next = applyTick(
              barsRef.current[barsRef.current.length - 1],
              price,
              at,
              interval,
            );
            if (next) publish(next);
          });
      return () => {
        stopBars();
        stopQuotes();
      };
    };

    void fetchPage(pageWindow(interval, Math.floor(Date.now() / 1000)), controller.signal)
      .then((page) => {
        if (disposed) return;
        barsRef.current = page;
        oldestRef.current = page[0]?.time ?? null;
        setBars([...page]);
        setLastBar(page[page.length - 1] ?? null);
        setStatus(page.length === 0 ? 'empty' : 'ready');
        unsubscribe = openStreams();
      })
      .catch((err: unknown) => {
        if (disposed || controller.signal.aborted) return;
        setError(err instanceof Error ? err : new Error(String(err)));
        setStatus('error');
      });

    return () => {
      disposed = true;
      controller.abort();
      unsubscribe?.();
    };
  }, [fetchPage, services.pool, gatewaySymbol, interval, attempt]);

  const loadEarlier = useCallback(() => {
    if (earlierInFlight.current || exhaustedRef.current) return;
    const oldest = oldestRef.current;
    if (oldest === null) return;
    earlierInFlight.current = true;
    setLoadingEarlier(true);
    const controller = new AbortController();
    void fetchPage(pageWindow(interval, oldest - 1), controller.signal)
      .then((page) => {
        const older = page.filter((bar) => bar.time < oldest);
        if (older.length === 0) {
          exhaustedRef.current = true;
          setExhausted(true);
          return;
        }
        barsRef.current = [...older, ...barsRef.current];
        oldestRef.current = older[0]!.time;
        setBars([...barsRef.current]);
      })
      .catch(() => {
        // A failed back-page only stops pagination; the drawn series stands.
        exhaustedRef.current = true;
        setExhausted(true);
      })
      .finally(() => {
        earlierInFlight.current = false;
        setLoadingEarlier(false);
      });
  }, [fetchPage, interval]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  return { bars, lastBar, status, error, exhausted, loadingEarlier, loadEarlier, retry };
}
