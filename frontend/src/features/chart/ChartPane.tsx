import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AreaSeries,
  BarSeries,
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  createChart,
  type IChartApi,
  type IPaneApi,
  type IPriceLine,
  type ISeriesApi,
  type LogicalRange,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import { cn } from '@/components/ui/cn';
import { ErrorState } from '@/components/ui/primitives';
import { formatPrice } from '@/domain/market/price-format';
import { useSymbolMetadata } from '@/features/order-ticket/useSymbolMetadata';
import { useTradingStore } from '@/stores/trading-store';
import { useWorkspace } from '@/workspace/layout/workspace-store';
import { INTERVALS, INTERVAL_LABELS, isInterval, type Bar, type Interval } from './bars';
import {
  CHART_STYLES,
  CHART_STYLE_LABELS,
  INDICATORS,
  INDICATOR_COLORS,
  INDICATOR_SPECS,
  parseChartSettings,
  type ChartStyle,
  type IndicatorId,
} from './chart-settings';
import { IndicatorMenu } from './IndicatorMenu';
import { bollinger, ema, macd, rsi, sma, withLiveBar } from './indicators';
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
 * lines (entry with its floating P/L, stop loss, take profit). Trading itself
 * stays in the order ticket, which already owns confirmation and validation.
 *
 * The chart style (candles, bars, line, area) and the moving-average overlays
 * are per pane and persist in the workspace's `chartState` slot. Overlays are
 * computed here from the same bars the chart draws, never fetched.
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

/** Empty bars kept to the right of the live candle. */
const RIGHT_OFFSET = 4;

const MACD_SIGNAL_COLOR = '#a78bfa';

/** The price pane is this many times the height of each indicator pane. */
const PRICE_PANE_STRETCH = 3;

type IndicatorSeries = ISeriesApi<'Line'> | ISeriesApi<'Histogram'>;
interface IndicatorPoint {
  time: UTCTimestamp;
  value: number;
  color?: string;
}
/** One drawn indicator: its series by role, and the pane they live in. */
interface MountedIndicator {
  series: Map<string, IndicatorSeries>;
  pane: IPaneApi<Time> | null;
}

type MainSeries = ISeriesApi<'Candlestick' | 'Bar' | 'Line' | 'Area'>;

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

function withAlpha(hex: string, alpha: string): string {
  return /^#[0-9a-f]{6}$/i.test(hex) ? hex + alpha : hex;
}

/** The main price series for a style; the volume histogram is separate. */
function createMainSeries(chart: IChartApi, style: ChartStyle, colors: Palette): MainSeries {
  switch (style) {
    case 'bars':
      return chart.addSeries(BarSeries, {
        upColor: colors.up,
        downColor: colors.down,
        thinBars: false,
      });
    case 'line':
      return chart.addSeries(LineSeries, { color: colors.brand, lineWidth: 2 });
    case 'area':
      return chart.addSeries(AreaSeries, {
        lineColor: colors.brand,
        lineWidth: 2,
        topColor: withAlpha(colors.brand, '66'),
        bottomColor: withAlpha(colors.brand, '05'),
      });
    default:
      return chart.addSeries(CandlestickSeries, {
        upColor: colors.up,
        downColor: colors.down,
        wickUpColor: colors.up,
        wickDownColor: colors.down,
        borderVisible: false,
      });
  }
}

function toPoint(style: ChartStyle, bar: Bar) {
  const time = toSeconds(bar);
  return style === 'line' || style === 'area'
    ? { time, value: bar.close }
    : { time, open: bar.open, high: bar.high, low: bar.low, close: bar.close };
}

/** Every series of an indicator, by role, over the given bars. */
function computeIndicator(
  id: IndicatorId,
  bars: readonly Bar[],
  colors: Palette,
): Record<string, IndicatorPoint[]> {
  const spec = INDICATOR_SPECS[id];
  const pts = (points: { time: number; value: number }[]) =>
    points.map((point) => ({ time: point.time as UTCTimestamp, value: point.value }));
  switch (spec.kind) {
    case 'sma':
      return { line: pts(sma(bars, spec.length)) };
    case 'ema':
      return { line: pts(ema(bars, spec.length)) };
    case 'bb': {
      const b = bollinger(bars, spec.length, spec.mult);
      return { upper: pts(b.upper), middle: pts(b.middle), lower: pts(b.lower) };
    }
    case 'rsi':
      return { line: pts(rsi(bars, spec.length)) };
    case 'macd': {
      const m = macd(bars, spec.fast, spec.slow, spec.signal);
      return {
        histogram: m.histogram.map((point) => ({
          time: point.time as UTCTimestamp,
          value: point.value,
          color: withAlpha(point.value >= 0 ? colors.up : colors.down, '99'),
        })),
        macd: pts(m.macd),
        signal: pts(m.signal),
      };
    }
    default:
      return {};
  }
}

/** Creates an indicator's series — over the price, or in a fresh pane below it. */
function mountIndicator(chart: IChartApi, id: IndicatorId): MountedIndicator {
  const spec = INDICATOR_SPECS[id];
  const quiet = { priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false };
  const series = new Map<string, IndicatorSeries>();
  if (spec.kind === 'bb') {
    // Bands solid, the middle dashed: three lines of one colour still read
    // as one indicator, and the dashed centre is not mistaken for the SMA.
    const color = INDICATOR_COLORS[id];
    for (const role of ['upper', 'lower'] as const)
      series.set(role, chart.addSeries(LineSeries, { color, lineWidth: 1, ...quiet }));
    series.set(
      'middle',
      chart.addSeries(LineSeries, {
        color: withAlpha(color, 'aa'),
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        ...quiet,
      }),
    );
    return { series, pane: null };
  }
  if (spec.placement === 'overlay') {
    series.set(
      'line',
      chart.addSeries(LineSeries, { color: INDICATOR_COLORS[id], lineWidth: 1, ...quiet }),
    );
    return { series, pane: null };
  }
  const pane = chart.addPane();
  const at = pane.paneIndex();
  if (spec.kind === 'rsi') {
    const line = chart.addSeries(
      LineSeries,
      {
        color: INDICATOR_COLORS[id],
        lineWidth: 1,
        ...quiet,
        lastValueVisible: true,
        // RSI is bounded; a scale that follows the data would hide how far
        // from the bands it sits.
        autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }),
      },
      at,
    );
    for (const level of [70, 30]) {
      line.createPriceLine({
        price: level,
        color: withAlpha(INDICATOR_COLORS[id], '66'),
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: '',
      });
    }
    series.set('line', line);
  } else {
    series.set(
      'histogram',
      chart.addSeries(
        HistogramSeries,
        { ...quiet, priceFormat: { type: 'price', precision: 2, minMove: 0.01 } },
        at,
      ),
    );
    series.set(
      'macd',
      chart.addSeries(
        LineSeries,
        { color: INDICATOR_COLORS[id], lineWidth: 1, ...quiet, lastValueVisible: true },
        at,
      ),
    );
    series.set(
      'signal',
      chart.addSeries(LineSeries, { color: MACD_SIGNAL_COLOR, lineWidth: 1, ...quiet }, at),
    );
  }
  return { series, pane };
}

function applyIndicatorData(mounted: MountedIndicator, data: Record<string, IndicatorPoint[]>) {
  for (const [role, points] of Object.entries(data)) mounted.series.get(role)?.setData(points);
}

/** Keep indicator panes in INDICATORS order under the price, at a fixed share of the height. */
function arrangePanes(chart: IChartApi, mounted: Map<IndicatorId, MountedIndicator>) {
  let target = 1;
  for (const id of INDICATORS) {
    const pane = mounted.get(id)?.pane;
    if (!pane) continue;
    if (pane.paneIndex() !== target) pane.moveTo(target);
    pane.setStretchFactor(1);
    target++;
  }
  chart.panes()[0]?.setStretchFactor(PRICE_PANE_STRETCH);
}

function formatSigned(value: number, digits: number): string {
  const sign = value > 0 ? '+' : value < 0 ? '−' : '';
  return sign + (formatPrice(Math.abs(value), digits) ?? '—');
}

function formatMoney(value: number): string {
  const sign = value > 0 ? '+' : value < 0 ? '−' : '';
  return sign + Math.abs(value).toFixed(2);
}

export function ChartPane({ paneId, symbol, interval, isPrimary }: ChartPaneProps) {
  const resolvedInterval: Interval = isInterval(interval) ? interval : '1';
  const series = useChartSeries(symbol, resolvedInterval);
  const { symbol: meta } = useSymbolMetadata(symbol);
  const theme = useWorkspace((s) => s.workspace.theme);
  const setPaneInterval = useWorkspace((s) => s.setPaneInterval);
  const setActiveInterval = useWorkspace((s) => s.setActiveInterval);
  const setPaneChartState = useWorkspace((s) => s.setPaneChartState);
  const chartState = useWorkspace(
    (s) => s.workspace.chartPanes.find((p) => p.id === paneId)?.chartState,
  );
  const settings = useMemo(() => parseChartSettings(chartState), [chartState]);
  const { style } = settings;

  const positions = useTradingStore((s) => s.positions);
  const orders = useTradingStore((s) => s.orders);

  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const mainRef = useRef<MainSeries | null>(null);
  const volumeRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const indicatorsRef = useRef(new Map<IndicatorId, MountedIndicator>());
  const priceLinesRef = useRef<IPriceLine[]>([]);
  const appliedBarsRef = useRef<readonly Bar[] | null>(null);
  // History plus every live bar since, mirroring the hook's own series so the
  // overlays are computed over exactly what is drawn.
  const allBarsRef = useRef<readonly Bar[]>([]);
  const [palette, setPalette] = useState<Palette | null>(null);
  const [hovered, setHovered] = useState<Bar | null>(null);
  // Bumped when the main series is recreated (style change) so the effects
  // that push data and price lines into it run again.
  const [mainVersion, setMainVersion] = useState(0);
  const [atLiveEdge, setAtLiveEdge] = useState(true);

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
      rightPriceScale: { borderColor: colors.border, scaleMargins: { top: 0.08, bottom: 0.22 } },
      timeScale: {
        borderColor: colors.border,
        timeVisible: true,
        secondsVisible: false,
        rightOffset: RIGHT_OFFSET,
      },
      localization: { locale: navigator.language },
    });
    const volume = chart.addSeries(HistogramSeries, {
      priceScaleId: 'volume',
      priceFormat: { type: 'volume' },
      lastValueVisible: false,
      priceLineVisible: false,
    });
    chart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });
    // The library lays its canvases out with a <table>; it is layout, not data,
    // and must not read as one to assistive tech (or to anything counting the
    // terminal's real tables).
    for (const table of container.querySelectorAll('table'))
      table.setAttribute('role', 'presentation');

    chartRef.current = chart;
    volumeRef.current = volume;

    const onCrosshair = (param: { point?: unknown; time?: unknown }) => {
      // `point` is set only while a pointer is over the chart. The library can
      // report a crosshair (e.g. after a layout pass) with no pointer at all;
      // without this guard the legend froze on that phantom bar. The bar is
      // looked up by time rather than read from the series so the legend shows
      // full OHLC whatever style is drawn.
      const time = Number(param.time);
      if (!param.point || !Number.isFinite(time)) {
        setHovered(null);
        return;
      }
      const bars = allBarsRef.current;
      let lo = 0;
      let hi = bars.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const at = bars[mid]!.time;
        if (at === time) {
          setHovered(bars[mid]!);
          return;
        }
        if (at < time) lo = mid + 1;
        else hi = mid - 1;
      }
      setHovered(null);
    };
    chart.subscribeCrosshairMove(onCrosshair);

    return () => {
      chart.unsubscribeCrosshairMove(onCrosshair);
      chart.remove();
      chartRef.current = null;
      mainRef.current = null;
      volumeRef.current = null;
      indicatorsRef.current = new Map();
      priceLinesRef.current = [];
      appliedBarsRef.current = null;
    };
  }, []);

  // The main series follows the chosen style. Recreating it drops its data and
  // price lines; the effects below re-push them on the new version.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    if (mainRef.current) chart.removeSeries(mainRef.current);
    mainRef.current = createMainSeries(chart, style, palette ?? readPalette());
    priceLinesRef.current = [];
    appliedBarsRef.current = null;
    setMainVersion((v) => v + 1);
    // `palette` is deliberately not a dependency: colours are applied in place
    // below, and recreating the series on a theme flip would lose the viewport.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [style]);

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
    // Per-bar colours (volume, MACD histogram) are baked into the data.
    const bars = allBarsRef.current;
    volumeRef.current?.setData(
      bars.map((bar) => ({
        time: toSeconds(bar),
        value: bar.volume ?? 0,
        color: withAlpha(bar.close >= bar.open ? palette.up : palette.down, '55'),
      })),
    );
    for (const [id, mounted] of indicatorsRef.current) {
      if (INDICATOR_SPECS[id].kind === 'macd')
        applyIndicatorData(mounted, computeIndicator(id, bars, palette));
    }
    const main = mainRef.current;
    if (!main) return;
    switch (main.seriesType()) {
      case 'Candlestick':
        (main as ISeriesApi<'Candlestick'>).applyOptions({
          upColor: palette.up,
          downColor: palette.down,
          wickUpColor: palette.up,
          wickDownColor: palette.down,
        });
        break;
      case 'Bar':
        (main as ISeriesApi<'Bar'>).applyOptions({ upColor: palette.up, downColor: palette.down });
        break;
      case 'Line':
        (main as ISeriesApi<'Line'>).applyOptions({ color: palette.brand });
        break;
      case 'Area':
        (main as ISeriesApi<'Area'>).applyOptions({
          lineColor: palette.brand,
          topColor: withAlpha(palette.brand, '66'),
          bottomColor: withAlpha(palette.brand, '05'),
        });
        break;
      default:
        break;
    }
  }, [palette, mainVersion]);

  useEffect(() => {
    mainRef.current?.applyOptions({ priceFormat });
  }, [priceFormat, mainVersion]);

  // Full history → setData. Preserves what the trader is looking at when an
  // earlier page is prepended (logical indices shift; times do not).
  useEffect(() => {
    const chart = chartRef.current;
    const main = mainRef.current;
    const volume = volumeRef.current;
    if (!chart || !main || !volume) return;
    if (appliedBarsRef.current === series.bars) return;
    const wasPrepend =
      appliedBarsRef.current !== null &&
      appliedBarsRef.current.length > 0 &&
      series.bars.length > appliedBarsRef.current.length;
    const visible = wasPrepend ? chart.timeScale().getVisibleRange() : null;

    // A fresh history (symbol, interval or account change) replaces what the
    // live stream had appended; a style change re-pushes what is already merged.
    const bars =
      appliedBarsRef.current === null && allBarsRef.current.length > 0
        ? allBarsRef.current
        : series.bars;
    allBarsRef.current = bars;
    main.setData(bars.map((bar) => toPoint(style, bar)));
    const up = palette?.up ?? '#22c55e';
    const down = palette?.down ?? '#ef4444';
    volume.setData(
      bars.map((bar) => ({
        time: toSeconds(bar),
        value: bar.volume ?? 0,
        color: withAlpha(bar.close >= bar.open ? up : down, '55'),
      })),
    );
    const colors = palette ?? readPalette();
    for (const [id, mounted] of indicatorsRef.current)
      applyIndicatorData(mounted, computeIndicator(id, bars, colors));
    appliedBarsRef.current = series.bars;
    if (visible) chart.timeScale().setVisibleRange(visible);
    else if (bars.length > 0) chart.timeScale().scrollToRealTime();
    // `style` is read, not depended on: a style change goes through
    // `mainVersion`, which already resets `appliedBarsRef`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series.bars, palette, mainVersion]);

  // Live candle → update. The library refuses an update older than its last
  // bar, and the hook already guarantees monotonic time.
  useEffect(() => {
    const bar = series.lastBar;
    const main = mainRef.current;
    const volume = volumeRef.current;
    if (!bar || !main || !volume) return;
    allBarsRef.current = withLiveBar(allBarsRef.current, bar);
    main.update(toPoint(style, bar));
    const up = palette?.up ?? '#22c55e';
    const down = palette?.down ?? '#ef4444';
    volume.update({
      time: toSeconds(bar),
      value: bar.volume ?? 0,
      color: withAlpha(bar.close >= bar.open ? up : down, '55'),
    });
    const colors = palette ?? readPalette();
    for (const [id, mounted] of indicatorsRef.current) {
      for (const [role, points] of Object.entries(
        computeIndicator(id, allBarsRef.current, colors),
      )) {
        const last = points[points.length - 1];
        if (last && last.time === bar.time) mounted.series.get(role)?.update(last);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series.lastBar, palette]);

  // Indicators: mounted and dropped as they are toggled, fed the merged bars.
  // Removing an indicator's last series removes its pane with it.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const mounted = indicatorsRef.current;
    let changed = false;
    for (const [id, instance] of mounted) {
      if (settings.indicators.includes(id)) continue;
      for (const s of instance.series.values()) chart.removeSeries(s);
      mounted.delete(id);
      changed = true;
    }
    const colors = palette ?? readPalette();
    for (const id of settings.indicators) {
      if (mounted.has(id)) continue;
      const instance = mountIndicator(chart, id);
      applyIndicatorData(instance, computeIndicator(id, allBarsRef.current, colors));
      mounted.set(id, instance);
      changed = true;
    }
    if (changed) arrangePanes(chart, mounted);
    // `palette` only colours the MACD histogram, which the theme effect
    // repaints on its own.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.indicators]);

  // Page back when the trader scrolls near the oldest bar, and remember
  // whether the live edge is in view for the "Latest" control.
  const { exhausted, loadingEarlier, loadEarlier } = series;
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const onRange = (range: LogicalRange | null) => {
      if (!range) return;
      setAtLiveEdge(range.to >= allBarsRef.current.length - 1);
      if (exhausted || loadingEarlier) return;
      if (range.from < LOAD_EARLIER_THRESHOLD) loadEarlier();
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(onRange);
    return () => chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRange);
  }, [exhausted, loadingEarlier, loadEarlier]);

  // Positions and working orders on this symbol, as price lines.
  useEffect(() => {
    const main = mainRef.current;
    if (!main || !palette) return;
    for (const line of priceLinesRef.current) main.removePriceLine(line);
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
        main.createPriceLine({
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
      const profit = Number(position.profit);
      const label = Number.isFinite(profit)
        ? `${side} ${position.volume} · ${formatMoney(profit)}`
        : `${side} ${position.volume}`;
      add(position.openPrice, color, label, LineStyle.Solid);
      add(position.stopLoss, palette.down, 'SL', LineStyle.Dashed);
      add(position.takeProfit, palette.up, 'TP', LineStyle.Dashed);
    }
    for (const order of orders) {
      if (order.displaySymbol !== symbol || order.status !== 'working') continue;
      const side = order.side === 'buy' ? 'Buy' : 'Sell';
      add(order.price, palette.brand, `${side} ${order.kind} ${order.volume}`, LineStyle.Dotted);
    }
  }, [positions, orders, symbol, palette, mainVersion]);

  const chooseInterval = (next: Interval) => {
    setPaneInterval(paneId, next);
    if (isPrimary) setActiveInterval(next);
  };
  const chooseStyle = (next: ChartStyle) => setPaneChartState(paneId, { ...settings, style: next });
  const toggleIndicator = (id: IndicatorId) =>
    setPaneChartState(paneId, {
      ...settings,
      indicators: settings.indicators.includes(id)
        ? settings.indicators.filter((other) => other !== id)
        : INDICATORS.filter((other) => other === id || settings.indicators.includes(other)),
    });
  // Not `scrollToRealTime()`: its animation gives up short of the live edge
  // when the trader has paged far back into history.
  const goToLatest = useCallback(
    () => chartRef.current?.timeScale().scrollToPosition(RIGHT_OFFSET, false),
    [],
  );

  const legendBar = hovered ?? series.lastBar;
  const legend = legendBar
    ? (['open', 'high', 'low', 'close'] as const).map((key) => ({
        key,
        label: key[0]!.toUpperCase(),
        value: formatPrice(legendBar[key], digits) ?? '—',
      }))
    : [];
  const legendUp = legendBar ? legendBar.close >= legendBar.open : true;
  // Change is against the previous bar's close, the way a bar-by-bar legend reads.
  const previous = useMemo(() => {
    if (!legendBar) return null;
    const bars = allBarsRef.current;
    for (let i = bars.length - 1; i >= 0; i--) {
      if (bars[i]!.time < legendBar.time) return bars[i]!;
    }
    return null;
  }, [legendBar]);
  const change = legendBar && previous ? legendBar.close - previous.close : null;
  const changePct =
    change !== null && previous && previous.close !== 0 ? (change / previous.close) * 100 : null;
  const hoveredTime =
    hovered &&
    new Date(hovered.time * 1000).toLocaleString(navigator.language, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: 'UTC',
    });

  const chip = (active: boolean) =>
    cn(
      'rounded px-1.5 py-0.5 text-2xs font-medium transition-colors',
      active
        ? 'bg-[var(--brand-primary)] text-[var(--brand-primary-contrast)]'
        : 'text-[var(--text-muted)] hover:bg-[var(--surface-raised)] hover:text-[var(--text-primary)]',
    );

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
          {hoveredTime && <span className="text-[var(--text-muted)]">{hoveredTime} UTC</span>}
          {legend.map((item) => (
            <span key={item.key}>
              <span className="text-[var(--text-muted)]">{item.label} </span>
              <span className={legendUp ? 'text-[var(--positive)]' : 'text-[var(--negative)]'}>
                {item.value}
              </span>
            </span>
          ))}
          {change !== null && changePct !== null && (
            <span className={change >= 0 ? 'text-[var(--positive)]' : 'text-[var(--negative)]'}>
              {formatSigned(change, digits)} ({formatSigned(changePct, 2)}%)
            </span>
          )}
          {legendBar?.volume !== undefined && legendBar.volume > 0 && (
            <span>
              <span className="text-[var(--text-muted)]">Vol </span>
              {legendBar.volume.toLocaleString(navigator.language)}
            </span>
          )}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-x-2 gap-y-1">
          <div role="group" aria-label="Chart style" className="flex items-center gap-0.5">
            {CHART_STYLES.map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={option === style}
                onClick={() => chooseStyle(option)}
                className={chip(option === style)}
              >
                {CHART_STYLE_LABELS[option]}
              </button>
            ))}
          </div>
          <span aria-hidden className="h-3 w-px bg-[var(--border-default)]" />
          <IndicatorMenu
            active={settings.indicators}
            onToggle={toggleIndicator}
            onClear={() => setPaneChartState(paneId, { ...settings, indicators: [] })}
          />
          <span aria-hidden className="h-3 w-px bg-[var(--border-default)]" />
          <div role="group" aria-label="Chart interval" className="flex items-center gap-0.5">
            {INTERVALS.map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={option === resolvedInterval}
                onClick={() => chooseInterval(option)}
                className={chip(option === resolvedInterval)}
              >
                {INTERVAL_LABELS[option]}
              </button>
            ))}
          </div>
        </div>
      </header>

      <div className="relative min-h-0 flex-1">
        <div ref={containerRef} data-testid={`chart-pane-${paneId}`} className="absolute inset-0" />

        {!atLiveEdge && series.status === 'ready' && (
          <button
            type="button"
            onClick={goToLatest}
            className="absolute bottom-8 right-20 z-10 rounded-full border border-[var(--border-strong)] bg-[var(--surface-overlay)] px-2.5 py-1 text-2xs font-medium text-[var(--text-primary)] shadow hover:bg-[var(--surface-raised)]"
          >
            Latest →
          </button>
        )}
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
