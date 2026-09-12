import { describe, expect, it } from 'vitest';
import type { Bar } from './bars';
import { ema, sma, withLiveBar } from './indicators';

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
