import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineStyle,
  createChart,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type LogicalRange,
  type UTCTimestamp,
} from 'lightweight-charts';
import { cn } from '@/components/ui/cn';
import { ErrorState } from '@/components/ui/primitives';
import { formatPrice } from '@/domain/market/price-format';
import { useSymbolMetadata } from '@/features/order-ticket/useSymbolMetadata';
import { useTradingStore } from '@/stores/trading-store';
import { useWorkspace } from '@/workspace/layout/workspace-store';
import { INTERVALS, INTERVAL_LABELS, isInterval, type Bar, type Interval } from './bars';
import { useChartSeries } from './use-chart-series';

/**
 * One chart pane, drawn with TradingView's open-source Lightweight Charts.
 *
 * The library draws; everything it draws comes from the gateway through
 * `useChartSeries`. There is no vendor datafeed, no licence, and no code that
 * reaches any third party — a chart that disagreed with execution would be
 * worse than no chart, so prices on it are the broker's or nothing.
 *
 * Open positions and working orders on the pane's symbol are drawn as price
 * lines (entry, stop loss, take profit). Trading itself stays in the order
 * ticket, which already owns confirmation and validation.
 */

interface ChartPaneProps {
  paneId: string;
  symbol: string;
  interval: string;
  /** The primary pane drives the workspace's active interval. */
  isPrimary: boolean;
}

/** When the visible range's left edge comes within this many bars, page back. */
const LOAD_EARLIER_THRESHOLD = 30;

interface Palette {
  background: string;
  text: string;
  muted: string;
  grid: string;
  border: string;
  up: string;
  down: string;
  brand: string;
}

function readPalette(): Palette {
  const css = getComputedStyle(document.documentElement);
  const token = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    background: token('--background-primary', '#0b0e14'),
    text: token('--text-primary', '#e6e8eb'),
    muted: token('--text-muted', '#8b93a1'),
    grid: token('--border-default', '#1f2733'),
    border: token('--border-strong', '#2b3442'),
    up: token('--positive', '#22c55e'),
    down: token('--negative', '#ef4444'),
    brand: token('--brand-primary', '#3366ee'),
  };
}

function toSeconds(bar: Bar): UTCTimestamp {
  return bar.time as UTCTimestamp;
}

export function ChartPane({ paneId, symbol, interval, isPrimary }: ChartPaneProps) {
  const resolvedInterval: Interval = isInterval(interval) ? interval : '1';
  const series = useChartSeries(symbol, resolvedInterval);
  const { symbol: meta } = useSymbolMetadata(symbol);
  const theme = useWorkspace((s) => s.workspace.theme);
  const setPaneInterval = useWorkspace((s) => s.setPaneInterval);
  const setActiveInterval = useWorkspace((s) => s.setActiveInterval);

  const positions = useTradingStore((s) => s.positions);
  const orders = useTradingStore((s) => s.orders);

  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candlesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const priceLinesRef = useRef<IPriceLine[]>([]);
  const appliedBarsRef = useRef<readonly Bar[] | null>(null);
  const [palette, setPalette] = useState<Palette | null>(null);
  const [hovered, setHovered] = useState<Bar | null>(null);

  const digits = meta?.digits ?? 5;
  // The gateway describes ticks the TradingView way — an integer `minmov` over
  // a `pricescale` — while Lightweight Charts wants the real tick size.
  const priceFormat = useMemo(() => {
    const fromMeta =
      meta && meta.minMove > 0 && meta.pricescale > 0 ? meta.minMove / meta.pricescale : null;
    return {
      type: 'price' as const,
      precision: digits,
      minMove: fromMeta ?? Number((10 ** -digits).toFixed(digits)),
    };
  }, [digits, meta]);

  // Tokens switch with the document theme; read them after the attribute flips.
  useEffect(() => {
    const frame = requestAnimationFrame(() => setPalette(readPalette()));
    return () => cancelAnimationFrame(frame);
  }, [theme]);

  // Create the chart once per mount. Data, colours and price format are pushed
  // through the API afterwards; nothing here depends on props that change.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const colors = readPalette();
    const chart = createChart(container, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: colors.background },
        textColor: colors.text,
        attributionLogo: true,
      },
      grid: {
        vertLines: { color: colors.grid },
        horzLines: { color: colors.grid },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: colors.border },
      timeScale: {
        borderColor: colors.border,
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 4,
      },
      localization: { locale: navigator.language },
    });
    const candles = chart.addSeries(CandlestickSeries, {
      upColor: colors.up,
      downColor: colors.down,
      wickUpColor: colors.up,
      wickDownColor: colors.down,
      borderVisible: false,
    });
    const volume = chart.addSeries(HistogramSeries, {
      priceScaleId: 'volume',
      priceFormat: { type: 'volume' },
      lastValueVisible: false,
      priceLineVisible: false,
    });
    chart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    // The library lays its canvases out with a <table>; it is layout, not data,
    // and must not read as one to assistive tech (or to anything counting the
    // terminal's real tables).
    for (const table of container.querySelectorAll('table'))
      table.setAttribute('role', 'presentation');

    chartRef.current = chart;
    candlesRef.current = candles;
    volumeRef.current = volume;

    const onCrosshair = (param: {
      point?: unknown;
      seriesData: Map<unknown, unknown>;
      time?: unknown;
    }) => {
      // `point` is set only while a pointer is over the chart. The library can
      // report a crosshair (e.g. after a layout pass) with no pointer at all;
      // without this guard the legend froze on that phantom bar.
      const data = param.seriesData.get(candles) as Partial<Bar> | undefined;
      if (!param.point || !data || typeof data.open !== 'number') {
        setHovered(null);
        return;
      }
      setHovered({
        time: Number(param.time),
        open: data.open,
        high: data.high ?? data.open,
        low: data.low ?? data.open,
        close: data.close ?? data.open,
      });
    };
    chart.subscribeCrosshairMove(onCrosshair);

    return () => {
      chart.unsubscribeCrosshairMove(onCrosshair);
      chart.remove();
      chartRef.current = null;
      candlesRef.current = null;
      volumeRef.current = null;
      priceLinesRef.current = [];
      appliedBarsRef.current = null;
    };
  }, []);

  // Colours follow the theme.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !palette) return;
    chart.applyOptions({
      layout: {
        background: { type: ColorType.Solid, color: palette.background },
        textColor: palette.text,
      },
      grid: { vertLines: { color: palette.grid }, horzLines: { color: palette.grid } },
      rightPriceScale: { borderColor: palette.border },
      timeScale: { borderColor: palette.border },
    });
    candlesRef.current?.applyOptions({
      upColor: palette.up,
      downColor: palette.down,
      wickUpColor: palette.up,
      wickDownColor: palette.down,
    });
  }, [palette]);

  useEffect(() => {
    candlesRef.current?.applyOptions({ priceFormat });
  }, [priceFormat]);

  // Full history → setData. Preserves what the trader is looking at when an
  // earlier page is prepended (logical indices shift; times do not).
  useEffect(() => {
    const chart = chartRef.current;
    const candles = candlesRef.current;
    const volume = volumeRef.current;
    if (!chart || !candles || !volume) return;
    if (appliedBarsRef.current === series.bars) return;
    const wasPrepend =
      appliedBarsRef.current !== null &&
      appliedBarsRef.current.length > 0 &&
      series.bars.length > appliedBarsRef.current.length;
    const visible = wasPrepend ? chart.timeScale().getVisibleRange() : null;

    candles.setData(
      series.bars.map((bar) => ({
        time: toSeconds(bar),
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
      })),
    );
    const up = palette?.up ?? '#22c55e';
    const down = palette?.down ?? '#ef4444';
    volume.setData(
      series.bars.map((bar) => ({
        time: toSeconds(bar),
        value: bar.volume ?? 0,
        color: (bar.close >= bar.open ? up : down) + '55',
      })),
    );
    appliedBarsRef.current = series.bars;
    if (visible) chart.timeScale().setVisibleRange(visible);
    else if (series.bars.length > 0) chart.timeScale().scrollToRealTime();
  }, [series.bars, palette]);

  // Live candle → update. The library refuses an update older than its last
  // bar, and the hook already guarantees monotonic time.
  useEffect(() => {
    const bar = series.lastBar;
    const candles = candlesRef.current;
    const volume = volumeRef.current;
    if (!bar || !candles || !volume) return;
    candles.update({
      time: toSeconds(bar),
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
    });
    const up = palette?.up ?? '#22c55e';
    const down = palette?.down ?? '#ef4444';
    volume.update({
      time: toSeconds(bar),
      value: bar.volume ?? 0,
      color: (bar.close >= bar.open ? up : down) + '55',
    });
  }, [series.lastBar, palette]);

  // Page back when the trader scrolls near the oldest bar.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const onRange = (range: LogicalRange | null) => {
      if (!range || series.exhausted || series.loadingEarlier) return;
      if (range.from < LOAD_EARLIER_THRESHOLD) series.loadEarlier();
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(onRange);
    return () => chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRange);
  }, [series.exhausted, series.loadingEarlier, series.loadEarlier]);

  // Positions and working orders on this symbol, as price lines.
  useEffect(() => {
    const candles = candlesRef.current;
    if (!candles || !palette) return;
    for (const line of priceLinesRef.current) candles.removePriceLine(line);
    priceLinesRef.current = [];

    const add = (
      price: string | number | null | undefined,
      color: string,
      title: string,
      style: LineStyle,
    ) => {
      const value = Number(price);
      if (!Number.isFinite(value) || value <= 0) return;
      priceLinesRef.current.push(
        candles.createPriceLine({
          price: value,
          color,
          lineWidth: 1,
          lineStyle: style,
          axisLabelVisible: true,
          title,
        }),
      );
    };

    for (const position of positions) {
      if (position.displaySymbol !== symbol) continue;
      const side = position.side === 'buy' ? 'Buy' : 'Sell';
      const color = position.side === 'buy' ? palette.up : palette.down;
      add(position.openPrice, color, `${side} ${position.volume}`, LineStyle.Solid);
      add(position.stopLoss, palette.down, 'SL', LineStyle.Dashed);
      add(position.takeProfit, palette.up, 'TP', LineStyle.Dashed);
    }
    for (const order of orders) {
      if (order.displaySymbol !== symbol || order.status !== 'working') continue;
      const side = order.side === 'buy' ? 'Buy' : 'Sell';
      add(order.price, palette.brand, `${side} ${order.kind} ${order.volume}`, LineStyle.Dotted);
    }
  }, [positions, orders, symbol, palette]);

  const chooseInterval = (next: Interval) => {
    setPaneInterval(paneId, next);
    if (isPrimary) setActiveInterval(next);
  };

  const legendBar = hovered ?? series.lastBar;
  const legend = legendBar
    ? (['open', 'high', 'low', 'close'] as const).map((key) => ({
        key,
        label: key[0]!.toUpperCase(),
        value: formatPrice(legendBar[key], digits) ?? '—',
      }))
    : [];
  const legendUp = legendBar ? legendBar.close >= legendBar.open : true;

  return (
    <section
      aria-label={`${symbol} chart`}
      className="flex h-full min-h-0 flex-col bg-[var(--background-primary)]"
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-[var(--border-default)] px-3 py-1.5 text-xs">
        <span className="font-semibold text-[var(--text-primary)]">{symbol}</span>
        {meta?.description && (
          <span className="truncate text-[var(--text-muted)]">{meta.description}</span>
        )}
        <span
          data-testid="chart-legend"
          data-last-bar-time={series.lastBar?.time ?? ''}
          data-last-bar-close={series.lastBar?.close ?? ''}
          className="flex items-center gap-2 font-mono tabular-nums text-[var(--text-secondary)]"
        >
          {legend.map((item) => (
            <span key={item.key}>
              <span className="text-[var(--text-muted)]">{item.label} </span>
              <span className={legendUp ? 'text-[var(--positive)]' : 'text-[var(--negative)]'}>
                {item.value}
              </span>
            </span>
          ))}
        </span>
        <div role="group" aria-label="Chart interval" className="ml-auto flex items-center gap-0.5">
          {INTERVALS.map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={option === resolvedInterval}
              onClick={() => chooseInterval(option)}
              className={cn(
                'rounded px-1.5 py-0.5 text-2xs font-medium transition-colors',
                option === resolvedInterval
                  ? 'bg-[var(--brand-primary)] text-[var(--brand-primary-contrast)]'
                  : 'text-[var(--text-muted)] hover:bg-[var(--surface-raised)] hover:text-[var(--text-primary)]',
              )}
            >
              {INTERVAL_LABELS[option]}
            </button>
          ))}
        </div>
      </header>

      <div className="relative min-h-0 flex-1">
        <div ref={containerRef} data-testid={`chart-pane-${paneId}`} className="absolute inset-0" />

        {series.status === 'loading' && (
          <div
            role="status"
            className="absolute inset-0 z-10 flex items-center justify-center bg-[var(--background-primary)]/70 text-sm text-[var(--text-muted)]"
          >
            Loading {symbol}…
          </div>
        )}
        {series.status === 'empty' && (
          <div
            role="status"
            className="absolute inset-0 z-10 flex items-center justify-center bg-[var(--background-primary)] text-sm text-[var(--text-muted)]"
          >
            No history for {symbol} at {INTERVAL_LABELS[resolvedInterval]}.
          </div>
        )}
        {series.status === 'error' && (
          <div className="absolute inset-0 z-10 bg-[var(--background-secondary)]">
            <ErrorState
              title="The chart could not be loaded"
              description={series.error?.message ?? 'The gateway did not return history.'}
              onRetry={series.retry}
            />
          </div>
        )}
        {series.loadingEarlier && (
          <div className="pointer-events-none absolute left-2 top-2 z-10 rounded bg-[var(--surface-overlay)] px-2 py-0.5 text-2xs text-[var(--text-muted)]">
            Loading earlier history…
          </div>
        )}
      </div>
    </section>
  );
}
