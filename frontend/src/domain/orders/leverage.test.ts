import { describe, expect, it } from 'vitest';
import type { DecimalString } from '@/domain/common/decimal';
import { projectLeverageChange } from './leverage';

const d = (v: string) => v as DecimalString;
const round2 = (v: string | null) => (v === null ? null : Number(v).toFixed(2));

describe('projectLeverageChange', () => {
  it('scales the margin requirement by the leverage ratio', () => {
    // The QA worked example: 1,100 USD notional, 3.67 margin at 1:300
    // becomes 5.50 at 1:200 — margin scales by 300/200.
    const p = projectLeverageChange({
      currentLeverage: 300,
      nextLeverage: 200,
      margin: d('3.67'),
      equity: d('3287.44'),
    });
    expect(Number(p.marginAfter)).toBeCloseTo(5.505, 10); // 3.67 × 300/200, exact
    expect(p.wouldExceedEquity).toBe(false);
  });

  it('computes margin level before and after from equity', () => {
    const p = projectLeverageChange({
      currentLeverage: 300,
      nextLeverage: 100,
      margin: d('100'),
      equity: d('3000'),
    });
    // 3000/100 = 3000%; after: margin 300 → 1000%.
    expect(round2(p.marginLevelBefore)).toBe('3000.00');
    expect(round2(p.marginAfter)).toBe('300.00');
    expect(round2(p.marginLevelAfter)).toBe('1000.00');
    expect(p.wouldExceedEquity).toBe(false);
  });

  it('flags a change whose projected requirement exceeds equity', () => {
    // 2,000 margin at 1:300 → 6,000 at 1:100, against 3,000 equity.
    const p = projectLeverageChange({
      currentLeverage: 300,
      nextLeverage: 100,
      margin: d('2000'),
      equity: d('3000'),
    });
    expect(round2(p.marginAfter)).toBe('6000.00');
    expect(p.wouldExceedEquity).toBe(true);
  });

  it('reports a flat account as safe, with no margin level', () => {
    const p = projectLeverageChange({
      currentLeverage: 300,
      nextLeverage: 50,
      margin: d('0'),
      equity: d('3000'),
    });
    expect(p.marginAfter).toBe(d('0'));
    // MT5's own convention: no margin in use means margin level is not
    // applicable — never 0%, never Infinity.
    expect(p.marginLevelBefore).toBeNull();
    expect(p.marginLevelAfter).toBeNull();
    expect(p.wouldExceedEquity).toBe(false);
  });

  it('yields null — never a guess — when inputs are unavailable', () => {
    const noMargin = projectLeverageChange({
      currentLeverage: 300,
      nextLeverage: 200,
      margin: null,
      equity: d('3000'),
    });
    expect(noMargin.marginAfter).toBeNull();
    expect(noMargin.wouldExceedEquity).toBeNull();

    const noEquity = projectLeverageChange({
      currentLeverage: 300,
      nextLeverage: 200,
      margin: d('100'),
      equity: null,
    });
    expect(round2(noEquity.marginAfter)).toBe('150.00');
    // "We cannot tell" must not read as "it is safe".
    expect(noEquity.wouldExceedEquity).toBeNull();
    expect(noEquity.marginLevelBefore).toBeNull();
  });

  it('refuses zero or negative leverage rather than dividing by it', () => {
    for (const [cur, next] of [
      [0, 200],
      [300, 0],
      [-100, 200],
      [300, -200],
    ] as const) {
      const p = projectLeverageChange({
        currentLeverage: cur,
        nextLeverage: next,
        margin: d('100'),
        equity: d('3000'),
      });
      expect(p.marginAfter).toBeNull();
      expect(p.wouldExceedEquity).toBeNull();
    }
  });
});
