import { describe, expect, it } from 'vitest';
import {
  aggregate,
  applyTick,
  bucketStart,
  formingPrice,
  fromDto,
  looksLikeRawM1,
  mergeStreamBar,
  normalize,
} from './bars';

const MON = Date.UTC(2026, 8, 7) / 1000; // Monday 2026-09-07 00:00 UTC

describe('bucketStart', () => {
  it('floors intraday to the interval', () => {
    expect(bucketStart(MON + 17 * 60 + 5, '15')).toBe(MON + 15 * 60);
    expect(bucketStart(MON + 5 * 3600 + 1, '240')).toBe(MON + 4 * 3600);
  });
  it('uses Monday-start weeks and first-of-month months like the gateway', () => {
    const thursday = MON + 3 * 86_400 + 3600;
    expect(bucketStart(thursday, '1W')).toBe(MON);
    expect(bucketStart(thursday, '1D')).toBe(MON + 3 * 86_400);
    expect(bucketStart(thursday, '1M')).toBe(Date.UTC(2026, 8, 1) / 1000);
    // Sunday belongs to the week that started the previous Monday.
    expect(bucketStart(MON + 6 * 86_400 + 60, '1W')).toBe(MON);
  });
});

describe('fromDto / normalize', () => {
  it('accepts numeric strings and drops rows that are not bars', () => {
    expect(
      fromDto({ time: 10, open: '1.1', high: '1.2', low: '1.0', close: '1.15', volume: '3' }),
    ).toEqual({
      time: 10,
      open: 1.1,
      high: 1.2,
      low: 1,
      close: 1.15,
      volume: 3,
    });
    expect(fromDto({ time: 0, open: 1, high: 1, low: 1, close: 1, volume: null })).toBeNull();
    expect(
      fromDto({ time: 5, open: Number.NaN, high: 1, low: 1, close: 1, volume: null }),
    ).toBeNull();
  });
  it('sorts and de-duplicates by time, last wins', () => {
    const out = normalize([
      { time: 20, open: 1, high: 1, low: 1, close: 1 },
      { time: 10, open: 1, high: 1, low: 1, close: 1 },
      { time: 20, open: 2, high: 2, low: 2, close: 2 },
    ]);
    expect(out.map((b) => b.time)).toEqual([10, 20]);
    expect(out[1]!.close).toBe(2);
  });
});

describe('aggregate', () => {
  const m1 = [0, 60, 120, 300, 360].map((offset, i) => ({
    time: MON + offset,
    open: 1 + i,
    high: 2 + i,
    low: 0.5 + i,
    close: 1.5 + i,
    volume: 1,
  }));
  it('detects raw M1 under a coarser interval', () => {
    expect(looksLikeRawM1(m1, '5')).toBe(true);
    expect(looksLikeRawM1(aggregate(m1, '5'), '5')).toBe(false);
    expect(looksLikeRawM1(m1, '1')).toBe(false);
  });
  it('rolls M1 into 5m buckets with OHLC and summed volume', () => {
    const out = aggregate(m1, '5');
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ time: MON, open: 1, high: 4, low: 0.5, close: 3.5, volume: 3 });
    expect(out[1]).toEqual({ time: MON + 300, open: 4, high: 6, low: 3.5, close: 5.5, volume: 2 });
  });
});

describe('mergeStreamBar', () => {
  const last = { time: MON, open: 1, high: 1.2, low: 0.9, close: 1.1 };
  it('extends the same bucket, opens a later one, ignores an earlier one', () => {
    expect(
      mergeStreamBar(last, { time: MON + 30, open: 1.1, high: 1.3, low: 1.0, close: 1.25 }, '1'),
    ).toEqual({
      time: MON,
      open: 1,
      high: 1.3,
      low: 0.9,
      close: 1.25,
      volume: undefined,
    });
    expect(
      mergeStreamBar(last, { time: MON + 60, open: 2, high: 2, low: 2, close: 2 }, '1')?.time,
    ).toBe(MON + 60);
    expect(
      mergeStreamBar(last, { time: MON - 60, open: 2, high: 2, low: 2, close: 2 }, '1'),
    ).toBeNull();
  });
  it('folds a streamed daily bar into the weekly candle', () => {
    const week = { time: MON, open: 1, high: 1.5, low: 0.8, close: 1.2 };
    const wednesday = { time: MON + 2 * 86_400, open: 1.2, high: 1.6, low: 1.1, close: 1.55 };
    expect(mergeStreamBar(week, wednesday, '1W')).toEqual({
      time: MON,
      open: 1,
      high: 1.6,
      low: 0.8,
      close: 1.55,
      volume: undefined,
    });
  });
});

describe('ticks', () => {
  it('prefers last, falls back to bid, refuses zero', () => {
    expect(formingPrice({ bid: '1.1', last: '1.2' })).toBe(1.2);
    expect(formingPrice({ bid: '1.1', last: '0' })).toBe(1.1);
    expect(formingPrice({ bid: '0', last: '0' })).toBeNull();
  });
  it('moves only the forming intraday candle', () => {
    const last = { time: MON, open: 1, high: 1.2, low: 0.9, close: 1.1 };
    expect(applyTick(last, 1.3, MON + 20, '1')).toEqual({ ...last, high: 1.3, close: 1.3 });
    expect(applyTick(last, 1.3, MON + 61, '1')).toEqual({
      time: MON + 60,
      open: 1.3,
      high: 1.3,
      low: 1.3,
      close: 1.3,
    });
    expect(applyTick(last, 1.3, MON - 5, '1')).toBeNull();
    expect(applyTick(last, 1.3, MON + 20, '1D')).toBeNull();
  });
});
