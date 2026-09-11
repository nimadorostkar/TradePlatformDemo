import { describe, expect, it } from 'vitest';
import type { DecimalString } from '@/domain/common/decimal';
import { formatPrice, splitPrice } from './price-format';

const price = (v: string) => v as DecimalString;

describe('formatPrice', () => {
  it('restores the trailing digits MT5 dropped', () => {
    expect(formatPrice(price('1.1672'), 5)).toBe('1.16720');
    expect(formatPrice(price('1.1659'), 5)).toBe('1.16590');
    expect(formatPrice(price('4506.8'), 2)).toBe('4506.80');
  });

  it('prices each instrument to its own precision', () => {
    expect(formatPrice(price('158.237'), 3)).toBe('158.237');
    expect(formatPrice(price('2400.5'), 2)).toBe('2400.50');
  });

  it('keeps an absent price absent rather than inventing a zero', () => {
    expect(formatPrice(null, 5)).toBeNull();
    expect(formatPrice(undefined, 5)).toBeNull();
    expect(formatPrice(price(''), 5)).toBeNull();
  });

  it('refuses a value that is not a number', () => {
    expect(formatPrice('abc' as DecimalString, 5)).toBeNull();
  });

  it('survives a nonsense precision instead of throwing', () => {
    // toFixed throws outside 0..100; a bad digits value must not take a
    // trading panel down.
    expect(formatPrice(price('1.5'), Number.NaN)).toBe('2');
    expect(formatPrice(price('1.5'), -3)).toBe('2');
    expect(formatPrice(price('1.5'), 999)).toBe('1.50000000000000000000');
  });

  it('accepts a plain number as well as a decimal string', () => {
    expect(formatPrice(1.1672, 5)).toBe('1.16720');
  });
});

describe('splitPrice', () => {
  // The split has to follow the INSTRUMENT's pricing, not the string's length:
  // a 5-digit EURUSD quote ends in a fractional pip, a 2-digit gold quote does
  // not, and promoting the wrong digit changes which number a trader watches.
  it('splits a 5-digit FX price at the fractional pip', () => {
    expect(splitPrice('1.16783', 5)).toEqual({ lead: '1.16', pip: '78', fraction: '3' });
  });

  it('splits a 3-digit JPY price the same way', () => {
    expect(splitPrice('159.024', 3)).toEqual({ lead: '159.', pip: '02', fraction: '4' });
  });

  it('leaves a 2-digit price whole, having no fractional pip', () => {
    expect(splitPrice('4620.28', 2)).toEqual({ lead: '4620.', pip: '28', fraction: '' });
  });

  it('pads to the instrument precision before splitting', () => {
    // MT5 sends 1.167 for a price that is quoted to five digits.
    expect(splitPrice(1.167, 5)).toEqual({ lead: '1.16', pip: '70', fraction: '0' });
  });

  it('keeps a very short price whole rather than promoting its only digit', () => {
    expect(splitPrice('7', 0)).toEqual({ lead: '', pip: '7', fraction: '' });
  });

  it('returns null for a price it cannot show', () => {
    expect(splitPrice(null, 5)).toBeNull();
    expect(splitPrice('nonsense', 5)).toBeNull();
  });
});
