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

/**
 * Relative Strength Index over `length` bars, Wilder's smoothing: the first
 * value is a simple average of the first `length` gains and losses, every
 * later one blends the previous average with the new change at 1/length.
 * Ranges 0–100; needs `length` changes, so `length + 1` bars.
 */
export function rsi(bars: readonly Bar[], length: number): IndicatorPoint[] {
  if (length < 1 || bars.length <= length) return [];
  const out: IndicatorPoint[] = [];
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= length; i++) {
    const change = bars[i]!.close - bars[i - 1]!.close;
    if (change > 0) gain += change;
    else loss -= change;
  }
  gain /= length;
  loss /= length;
  const value = () => (loss === 0 ? 100 : 100 - 100 / (1 + gain / loss));
  out.push({ time: bars[length]!.time, value: value() });
  for (let i = length + 1; i < bars.length; i++) {
    const change = bars[i]!.close - bars[i - 1]!.close;
    gain = (gain * (length - 1) + Math.max(change, 0)) / length;
    loss = (loss * (length - 1) + Math.max(-change, 0)) / length;
    out.push({ time: bars[i]!.time, value: value() });
  }
  return out;
}

export interface MacdSeries {
  macd: IndicatorPoint[];
  signal: IndicatorPoint[];
  histogram: IndicatorPoint[];
}

/**
 * MACD: fast EMA − slow EMA, its EMA as the signal, and their difference as
 * the histogram. Each series starts where its inputs are all defined, so the
 * signal and histogram begin `signalLength − 1` bars after the MACD line.
 */
export function macd(
  bars: readonly Bar[],
  fastLength: number,
  slowLength: number,
  signalLength: number,
): MacdSeries {
  const empty: MacdSeries = { macd: [], signal: [], histogram: [] };
  if (fastLength < 1 || slowLength <= fastLength || signalLength < 1) return empty;
  const fast = ema(bars, fastLength);
  const slow = ema(bars, slowLength);
  if (slow.length === 0) return empty;
  // ema() returns one point per bar from index length-1; align by time.
  const offset = fast.length - slow.length;
  const line: IndicatorPoint[] = slow.map((point, i) => ({
    time: point.time,
    value: fast[i + offset]!.value - point.value,
  }));
  if (line.length < signalLength) return { macd: line, signal: [], histogram: [] };
  const asBars: Bar[] = line.map((p) => ({
    time: p.time,
    open: p.value,
    high: p.value,
    low: p.value,
    close: p.value,
  }));
  const signal = ema(asBars, signalLength);
  const start = line.length - signal.length;
  const histogram = signal.map((point, i) => ({
    time: point.time,
    value: line[i + start]!.value - point.value,
  }));
  return { macd: line, signal, histogram };
}

export interface BollingerSeries {
  upper: IndicatorPoint[];
  middle: IndicatorPoint[];
  lower: IndicatorPoint[];
}

/**
 * Bollinger Bands: a simple moving average of closes with bands `mult`
 * population standard deviations either side (the textbook 20 / 2). The
 * population deviation — dividing by `length`, not `length − 1` — is what
 * Bollinger specified and what every charting package draws.
 */
export function bollinger(bars: readonly Bar[], length: number, mult: number): BollingerSeries {
  const empty: BollingerSeries = { upper: [], middle: [], lower: [] };
  if (length < 1 || mult < 0 || bars.length < length) return empty;
  const out: BollingerSeries = { upper: [], middle: [], lower: [] };
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < bars.length; i++) {
    const close = bars[i]!.close;
    sum += close;
    sumSq += close * close;
    if (i >= length) {
      const gone = bars[i - length]!.close;
      sum -= gone;
      sumSq -= gone * gone;
    }
    if (i < length - 1) continue;
    const mean = sum / length;
    // Guard the rounding that can push a flat window's variance below zero.
    const variance = Math.max(sumSq / length - mean * mean, 0);
    const width = mult * Math.sqrt(variance);
    const time = bars[i]!.time;
    out.middle.push({ time, value: mean });
    out.upper.push({ time, value: mean + width });
    out.lower.push({ time, value: mean - width });
  }
  return out;
}
