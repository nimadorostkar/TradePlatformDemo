import type { Bar } from './bars';

/**
 * Overlay indicators, computed from the broker's own bars.
 *
 * Kept independent of the charting library so they can be tested as plain
 * arithmetic. Each returns one point per input bar from the first bar that has
 * enough history; earlier bars produce nothing rather than a misleading value.
 */

export interface IndicatorPoint {
  time: number;
  value: number;
}

/** Simple moving average of closes over `length` bars. */
export function sma(bars: readonly Bar[], length: number): IndicatorPoint[] {
  if (length < 1 || bars.length < length) return [];
  const out: IndicatorPoint[] = [];
  let sum = 0;
  for (let i = 0; i < bars.length; i++) {
    sum += bars[i]!.close;
    if (i >= length) sum -= bars[i - length]!.close;
    if (i >= length - 1) out.push({ time: bars[i]!.time, value: sum / length });
  }
  return out;
}

/**
 * Exponential moving average of closes, seeded with the SMA of the first
 * `length` bars (the conventional seed, and the one most platforms draw).
 */
export function ema(bars: readonly Bar[], length: number): IndicatorPoint[] {
  if (length < 1 || bars.length < length) return [];
  const k = 2 / (length + 1);
  const out: IndicatorPoint[] = [];
  let seed = 0;
  for (let i = 0; i < length; i++) seed += bars[i]!.close;
  let value = seed / length;
  out.push({ time: bars[length - 1]!.time, value });
  for (let i = length; i < bars.length; i++) {
    value = bars[i]!.close * k + value * (1 - k);
    out.push({ time: bars[i]!.time, value });
  }
  return out;
}

/**
 * The full series plus the live bar: the hook publishes history and the
 * streaming bar separately, and the streaming bar either extends the last
 * bucket or opens a new one.
 */
export function withLiveBar(bars: readonly Bar[], live: Bar | null): readonly Bar[] {
  if (!live) return bars;
  const last = bars[bars.length - 1];
  if (!last || live.time > last.time) return [...bars, live];
  if (live.time === last.time && last !== live) return [...bars.slice(0, -1), live];
  return bars;
}
