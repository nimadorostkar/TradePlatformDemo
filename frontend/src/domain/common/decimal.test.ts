import { describe, expect, it } from 'vitest';
import {
  add,
  cmp,
  div,
  isOnVolumeStep,
  mul,
  quantizeVolume,
  roundToDigits,
  sub,
  toDecimalString,
  type DecimalString,
} from './decimal';

const d = (v: string) => v as DecimalString;

describe('toDecimalString', () => {
  it('normalises numbers and numeric strings', () => {
    expect(toDecimalString('1.50')).toBe('1.5');
    expect(toDecimalString(2)).toBe('2');
    expect(toDecimalString('0.000001')).toBe('0.000001');
  });

  it('rejects values that are not finite decimals', () => {
    expect(toDecimalString('abc')).toBeNull();
    expect(toDecimalString('')).toBeNull();
    expect(toDecimalString(null)).toBeNull();
    expect(toDecimalString(undefined)).toBeNull();
    expect(toDecimalString(Number.NaN)).toBeNull();
    expect(toDecimalString(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('arithmetic is decimal-safe', () => {
  it('adds without binary drift', () => {
    // 0.1 + 0.2 === 0.30000000000000004 in IEEE-754.
    expect(add(d('0.1'), d('0.2'))).toBe('0.3');
  });

  it('subtracts without binary drift', () => {
    expect(sub(d('1.005'), d('1'))).toBe('0.005');
  });

  it('multiplies without binary drift', () => {
    expect(mul(d('0.07'), d('100'))).toBe('7');
    expect(mul(d('1.1'), d('3'))).toBe('3.3');
  });

  it('divides and refuses division by zero', () => {
    expect(div(d('1'), d('4'))).toBe('0.25');
    expect(div(d('1'), d('0'))).toBeNull();
  });

  it('compares by value', () => {
    expect(cmp(d('1.10'), d('1.1'))).toBe(0);
    expect(cmp(d('2'), d('10'))).toBe(-1);
    expect(cmp(d('10'), d('2'))).toBe(1);
  });
});

describe('quantizeVolume', () => {
  it('rounds DOWN to the step', () => {
    // Rounding up would risk more than the trader asked for.
    expect(quantizeVolume(d('0.157'), d('0.01'), d('0.01'), d('100'))).toBe('0.15');
    expect(quantizeVolume(d('1.999'), d('0.1'), d('0.1'), d('100'))).toBe('1.9');
  });

  it('clamps to the minimum', () => {
    expect(quantizeVolume(d('0.001'), d('0.01'), d('0.01'), d('100'))).toBe('0.01');
  });

  it('clamps to the maximum', () => {
    expect(quantizeVolume(d('500'), d('0.01'), d('0.01'), d('100'))).toBe('100');
  });

  it('tolerates a zero step', () => {
    expect(quantizeVolume(d('0.157'), d('0'), d('0'), d('100'))).toBe('0.157');
  });
});

describe('isOnVolumeStep', () => {
  it('accepts values on the grid', () => {
    expect(isOnVolumeStep(d('0.05'), d('0.01'), d('0.01'))).toBe(true);
    expect(isOnVolumeStep(d('1'), d('0.1'), d('0.1'))).toBe(true);
  });

  it('rejects values off the grid', () => {
    expect(isOnVolumeStep(d('0.055'), d('0.01'), d('0.01'))).toBe(false);
  });

  it('measures the grid from the minimum, not from zero', () => {
    // min 0.03, step 0.05 → valid: 0.03, 0.08, 0.13 …
    expect(isOnVolumeStep(d('0.08'), d('0.05'), d('0.03'))).toBe(true);
    expect(isOnVolumeStep(d('0.05'), d('0.05'), d('0.03'))).toBe(false);
  });
});

describe('roundToDigits', () => {
  it('rounds to the symbol precision', () => {
    expect(roundToDigits(d('1.234567'), 5)).toBe('1.23457');
    expect(roundToDigits(d('2400.555'), 2)).toBe('2400.56');
    expect(roundToDigits(d('1.5'), 0)).toBe('2');
  });
});
