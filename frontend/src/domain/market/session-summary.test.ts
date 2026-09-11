import { describe, expect, it } from 'vitest';
import type { DecimalString } from '@/domain/common/decimal';
import { sessionSummary, type SessionBar } from './session-summary';

const d = (v: string) => v as DecimalString;

const bar = (o: string, h: string, l: string, c: string, time = 1): SessionBar => ({
  time,
  open: d(o),
  high: d(h),
  low: d(l),
  close: d(c),
});

/**
 * The details panel showed 0.00000 (0.00%) over a day range of a single point,
 * because it was built on the quote — and the gateway's quote carries no
 * session data at all. The daily bar does.
 */
describe('the day’s summary', () => {
  it('measures change against the PREVIOUS close, not today’s open', () => {
    const bars = [
      bar('1.16000', '1.16500', '1.15900', '1.16200'),
      bar('1.16200', '1.16800', '1.16100', '1.16700'),
    ];

    const summary = sessionSummary(bars, d('1.16700'))!;

    // 1.16700 − 1.16200 = 0.005. Measuring from today's open would give a
    // different number wearing the same label.
    expect(Number(summary.change)).toBeCloseTo(0.005, 8);
    expect(Number(summary.changePercent)).toBeCloseTo(0.4303, 3);
  });

  it('reports no change at all when there is no previous close', () => {
    // One bar means no reference. Silently measuring from today's open would
    // be a different statistic presented as the same one.
    const summary = sessionSummary(
      [bar('1.16000', '1.16500', '1.15900', '1.16200')],
      d('1.16200'),
    )!;
    expect(summary.change).toBeNull();
    expect(summary.changePercent).toBeNull();
  });

  it('extends the range when the live price prints outside it', () => {
    // A bar fetched a minute ago does not know about the tick that just set a
    // new high, and a range excluding the price shown above it is visibly wrong.
    const summary = sessionSummary(
      [bar('1.16000', '1.16500', '1.15900', '1.16400')],
      d('1.16900'),
    )!;
    expect(summary.high).toBe('1.169');
    expect(summary.low).toBe('1.159');
  });

  it('extends the range downward too', () => {
    const summary = sessionSummary(
      [bar('1.16000', '1.16500', '1.15900', '1.16000')],
      d('1.15000'),
    )!;
    expect(summary.low).toBe('1.15');
  });

  it('places the marker within the day’s range', () => {
    const summary = sessionSummary(
      [bar('1.10000', '1.20000', '1.10000', '1.15000')],
      d('1.15000'),
    )!;
    expect(summary.position).toBeCloseTo(50, 6);
  });

  it('pins the marker to the ends without escaping them', () => {
    const atHigh = sessionSummary([bar('1.10000', '1.20000', '1.10000', '1.20000')], d('1.20000'))!;
    expect(atHigh.position).toBeCloseTo(100, 6);
    const atLow = sessionSummary([bar('1.10000', '1.20000', '1.10000', '1.10000')], d('1.10000'))!;
    expect(atLow.position).toBeCloseTo(0, 6);
  });

  it('reports no marker position when the day has no range yet', () => {
    // A brand-new session that has printed one price has no range to place a
    // marker in; a bar pinned to one end would imply a move that never happened.
    const summary = sessionSummary(
      [bar('1.16779', '1.16779', '1.16779', '1.16779')],
      d('1.16779'),
    )!;
    expect(summary.position).toBeNull();
  });

  it('falls back to the bar’s close when no live price has arrived', () => {
    const summary = sessionSummary(
      [
        bar('1.16000', '1.16500', '1.15900', '1.16200'),
        bar('1.16200', '1.16800', '1.16100', '1.16700'),
      ],
      null,
    )!;
    expect(Number(summary.change)).toBeCloseTo(0.005, 8);
  });

  it('ignores a nonsensical live price rather than corrupting the range', () => {
    const summary = sessionSummary([bar('1.16000', '1.16500', '1.15900', '1.16200')], d('0'))!;
    expect(summary.high).toBe('1.165');
    expect(summary.low).toBe('1.159');
  });

  it('has nothing to say without a bar', () => {
    expect(sessionSummary([], d('1.16'))).toBeNull();
  });
});
