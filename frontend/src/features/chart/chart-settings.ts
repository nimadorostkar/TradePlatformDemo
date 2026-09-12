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

export const INDICATORS = ['sma20', 'ema50'] as const;
export type IndicatorId = (typeof INDICATORS)[number];

export const INDICATOR_SPECS: Record<
  IndicatorId,
  { label: string; kind: 'sma' | 'ema'; length: number }
> = {
  sma20: { label: 'SMA 20', kind: 'sma', length: 20 },
  ema50: { label: 'EMA 50', kind: 'ema', length: 50 },
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
