import { describe, expect, it } from 'vitest';
import type { Bar } from './bars';
import { bollinger, ema, macd, rsi, sma, withLiveBar } from './indicators';

const bar = (i: number, close: number): Bar => ({
  time: 60 * i,
  open: close,
  high: close,
  low: close,
  close,
});
const closes = (...values: number[]) => values.map((v, i) => bar(i, v));

describe('sma', () => {
  it('averages the trailing window and skips bars without enough history', () => {
    const points = sma(closes(1, 2, 3, 4, 5), 3);
    expect(points).toEqual([
      { time: 120, value: 2 },
      { time: 180, value: 3 },
      { time: 240, value: 4 },
    ]);
  });

  it('is empty when there are fewer bars than the length', () => {
    expect(sma(closes(1, 2), 3)).toEqual([]);
    expect(sma(closes(1, 2), 0)).toEqual([]);
  });
});

describe('ema', () => {
  it('seeds with the SMA and then weights the latest close by 2/(n+1)', () => {
    const points = ema(closes(1, 2, 3, 6), 3);
    expect(points[0]).toEqual({ time: 120, value: 2 });
    // k = 0.5: 6 * 0.5 + 2 * 0.5
    expect(points[1]).toEqual({ time: 180, value: 4 });
  });

  it('is empty when there are fewer bars than the length', () => {
    expect(ema(closes(1), 2)).toEqual([]);
  });
});

describe('withLiveBar', () => {
  const history = closes(1, 2, 3);

  it('returns history untouched without a live bar', () => {
    expect(withLiveBar(history, null)).toBe(history);
  });

  it('replaces the last bucket when the live bar shares its time', () => {
    const live = { ...bar(2, 9) };
    expect(withLiveBar(history, live).map((b) => b.close)).toEqual([1, 2, 9]);
  });

  it('appends when the live bar opens a new bucket', () => {
    expect(withLiveBar(history, bar(3, 4)).map((b) => b.close)).toEqual([1, 2, 3, 4]);
  });
});

describe('rsi', () => {
  it('is 100 after nothing but gains and 0 after nothing but losses', () => {
    expect(rsi(closes(1, 2, 3, 4, 5), 3).map((p) => p.value)).toEqual([100, 100]);
    expect(rsi(closes(5, 4, 3, 2, 1), 3).map((p) => p.value)).toEqual([0, 0]);
  });

  it('starts after `length` changes and smooths alternating moves', () => {
    // +1, −1, +1, −1 with length 2: the seed averages one gain and one loss
    // (50); Wilder smoothing then weights the latest change at 1/2, so the
    // next bar's +1 lifts it to 75 and the following −1 pulls it to 37.5.
    const points = rsi(closes(10, 11, 10, 11, 10), 2);
    expect(points.map((p) => p.time)).toEqual([120, 180, 240]);
    expect(points.map((p) => p.value)).toEqual([50, 75, 37.5]);
  });

  it('applies Wilder smoothing after the seed', () => {
    // Seed over 2 changes: gains (1+1)/2 = 1, losses 0 → 100. Then a −3 bar:
    // gain = (1·1 + 0)/2 = 0.5, loss = (0 + 3)/2 = 1.5 → RS 1/3 → RSI 25.
    const points = rsi(closes(10, 11, 12, 9), 2);
    expect(points.at(-1)?.value).toBeCloseTo(25, 10);
  });

  it('is empty without enough bars', () => {
    expect(rsi(closes(1, 2, 3), 3)).toEqual([]);
  });
});

describe('macd', () => {
  it('is zero everywhere on a flat series', () => {
    const flat = closes(...Array<number>(40).fill(5));
    const m = macd(flat, 3, 6, 2);
    expect(m.macd.length).toBe(35);
    expect(m.signal.length).toBe(34);
    expect(m.histogram.length).toBe(34);
    for (const s of [m.macd, m.signal, m.histogram]) for (const p of s) expect(p.value).toBe(0);
  });

  it('aligns the line to the slow EMA and the signal to the line', () => {
    const rising = closes(...Array.from({ length: 12 }, (_, i) => i + 1));
    const m = macd(rising, 2, 4, 3);
    expect(m.macd[0]?.time).toBe(180); // slow EMA(4) starts at bar 3
    expect(m.signal[0]?.time).toBe(300); // 3rd MACD point
    // A steadily rising series: the fast EMA leads, so MACD is positive.
    for (const p of m.macd) expect(p.value).toBeGreaterThan(0);
    const last = m.histogram.at(-1)!;
    expect(last.value).toBeCloseTo(m.macd.at(-1)!.value - m.signal.at(-1)!.value, 12);
  });

  it('rejects nonsensical lengths', () => {
    expect(macd(closes(1, 2, 3), 5, 3, 2).macd).toEqual([]);
  });
});

describe('bollinger', () => {
  it('collapses onto the average when the window is flat', () => {
    const b = bollinger(closes(5, 5, 5, 5), 3, 2);
    expect(b.middle.map((p) => p.value)).toEqual([5, 5]);
    expect(b.upper.map((p) => p.value)).toEqual([5, 5]);
    expect(b.lower.map((p) => p.value)).toEqual([5, 5]);
  });

  it('uses the population deviation of the window', () => {
    // Window 2, 4, 6: mean 4, population σ = √(8/3).
    const b = bollinger(closes(2, 4, 6), 3, 2);
    const sigma = Math.sqrt(8 / 3);
    expect(b.middle[0]).toEqual({ time: 120, value: 4 });
    expect(b.upper[0]!.value).toBeCloseTo(4 + 2 * sigma, 12);
    expect(b.lower[0]!.value).toBeCloseTo(4 - 2 * sigma, 12);
  });

  it('slides the window and stays symmetric about the middle', () => {
    const b = bollinger(closes(1, 2, 3, 10, 2), 3, 2);
    expect(b.middle.map((p) => p.time)).toEqual([120, 180, 240]);
    for (let i = 0; i < b.middle.length; i++) {
      const mid = b.middle[i]!.value;
      expect(b.upper[i]!.value - mid).toBeCloseTo(mid - b.lower[i]!.value, 12);
    }
    expect(b.middle[1]!.value).toBe(5); // (2 + 3 + 10) / 3
  });

  it('is empty without enough bars', () => {
    expect(bollinger(closes(1, 2), 3, 2).middle).toEqual([]);
  });
});
