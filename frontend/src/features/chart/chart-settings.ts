/**
 * Per-pane chart settings, persisted in the workspace's opaque `chartState`
 * slot. Parsed defensively: the slot is `unknown` on the wire and older
 * workspaces (or a hand-edited one) may hold anything.
 */

export const CHART_STYLES = ['candles', 'bars', 'line', 'area'] as const;
export type ChartStyle = (typeof CHART_STYLES)[number];

export const CHART_STYLE_LABELS: Record<ChartStyle, string> = {
  candles: 'Candles',
  bars: 'Bars',
  line: 'Line',
  area: 'Area',
};

export const INDICATORS = ['sma20', 'ema50', 'bb20', 'rsi14', 'macd'] as const;
export type IndicatorId = (typeof INDICATORS)[number];

/**
 * Moving averages draw over the price; oscillators get a pane of their own
 * under it, in this order.
 */
export type IndicatorSpec =
  | { label: string; placement: 'overlay'; kind: 'sma' | 'ema'; length: number }
  | { label: string; placement: 'overlay'; kind: 'bb'; length: number; mult: number }
  | { label: string; placement: 'pane'; kind: 'rsi'; length: number }
  | { label: string; placement: 'pane'; kind: 'macd'; fast: number; slow: number; signal: number };

export const INDICATOR_SPECS: Record<IndicatorId, IndicatorSpec> = {
  sma20: { label: 'SMA 20', placement: 'overlay', kind: 'sma', length: 20 },
  ema50: { label: 'EMA 50', placement: 'overlay', kind: 'ema', length: 50 },
  bb20: { label: 'BB 20/2', placement: 'overlay', kind: 'bb', length: 20, mult: 2 },
  rsi14: { label: 'RSI 14', placement: 'pane', kind: 'rsi', length: 14 },
  macd: { label: 'MACD 12/26/9', placement: 'pane', kind: 'macd', fast: 12, slow: 26, signal: 9 },
};

/** Indicator colours, distinct from the up/down palette so they never read as price. */
export const INDICATOR_COLORS: Record<IndicatorId, string> = {
  sma20: '#f5a524',
  ema50: '#a78bfa',
  bb20: '#94a3b8',
  rsi14: '#38bdf8',
  macd: '#f5a524',
};

export interface ChartSettings {
  style: ChartStyle;
  indicators: readonly IndicatorId[];
}

export const DEFAULT_CHART_SETTINGS: ChartSettings = { style: 'candles', indicators: [] };

export function parseChartSettings(state: unknown): ChartSettings {
  if (!state || typeof state !== 'object') return DEFAULT_CHART_SETTINGS;
  const raw = state as { style?: unknown; indicators?: unknown };
  const style = (CHART_STYLES as readonly unknown[]).includes(raw.style)
    ? (raw.style as ChartStyle)
    : DEFAULT_CHART_SETTINGS.style;
  const listed: readonly unknown[] = Array.isArray(raw.indicators) ? raw.indicators : [];
  const indicators = INDICATORS.filter((id) => listed.includes(id));
  return { style, indicators };
}
