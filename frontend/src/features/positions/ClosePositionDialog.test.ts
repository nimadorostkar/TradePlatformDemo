import { describe, expect, it } from 'vitest';
import type { DecimalString } from '@/domain/common/decimal';
import { asPositionId } from '@/domain/common/ids';
import type { Position, TradingSymbol } from '@/domain/common/models';
import { validateCloseVolume } from './ClosePositionDialog';

const d = (v: string) => v as DecimalString;

function position(volume: string): Position {
  return {
    id: asPositionId('1'),
    symbol: 'EURUSD.',
    displaySymbol: 'EURUSD',
    side: 'buy',
    volume: d(volume),
    openPrice: d('1.10'),
    currentPrice: d('1.11'),
    stopLoss: null,
    takeProfit: null,
    profit: d('10'),
    swap: null,
    commission: null,
    openTime: null,
    comment: null,
  };
}

function symbol(overrides: Partial<TradingSymbol> = {}): TradingSymbol {
  return {
    name: 'EURUSD.',
    displayName: 'EURUSD',
    description: '',
    type: 'FX',
    exchange: '',
    digits: 5,
    pricescale: 100_000,
    minMove: 1,
    volumeMin: d('0.01'),
    volumeMax: d('100'),
    volumeStep: d('0.01'),
    contractSize: d('100000'),
    tickSize: d('0.00001'),
    tickValue: d('1'),
    currencyCode: 'USD',
    session: '24x7',
    timezone: 'Etc/UTC',
    supportedResolutions: [],
    sector: null,
    industry: null,
    ...overrides,
  };
}

describe('validateCloseVolume', () => {
  it('accepts a full close', () => {
    const result = validateCloseVolume('1', position('1'), symbol());
    expect(result.error).toBeNull();
    expect(result.volume).toBe('1');
  });

  it('accepts a valid partial close', () => {
    const result = validateCloseVolume('0.3', position('1'), symbol());
    expect(result.error).toBeNull();
    expect(result.volume).toBe('0.3');
  });

  it('refuses more than the position holds', () => {
    const result = validateCloseVolume('1.5', position('1'), symbol());
    expect(result.error).toMatch(/cannot close more than 1/i);
  });

  it('refuses zero, negative and non-numeric input', () => {
    for (const value of ['0', '-1', 'abc', '']) {
      expect(validateCloseVolume(value, position('1'), symbol()).error).toBeTruthy();
    }
  });

  it('refuses a partial that is off the step grid', () => {
    const result = validateCloseVolume('0.035', position('1'), symbol());
    expect(result.error).toMatch(/multiple of/i);
  });

  it('refuses a partial below the minimum', () => {
    const result = validateCloseVolume('0.005', position('1'), symbol());
    expect(result.error).toBeTruthy();
  });

  it('refuses a partial that would strand an uncloseable remainder', () => {
    // A position can hold an odd size after an earlier partial close. Closing
    // 0.01 of 0.015 is itself a valid step, but leaves 0.005 — below the 0.01
    // minimum, so the remainder could never be closed afterwards.
    const result = validateCloseVolume('0.01', position('0.015'), symbol());
    expect(result.error).toMatch(/would leave/i);
  });

  it('allows a FULL close even when it is off the step grid', () => {
    // The position's own size is by definition one the server accepted, so a
    // full close must never be blocked by client-side step arithmetic.
    const result = validateCloseVolume('0.035', position('0.035'), symbol());
    expect(result.error).toBeNull();
    expect(result.volume).toBe('0.035');
  });

  it('allows any partial when the symbol limits are unavailable', () => {
    // The server validates authoritatively; blocking here would be a guess.
    const result = validateCloseVolume(
      '0.333',
      position('1'),
      symbol({ volumeMin: null, volumeStep: null }),
    );
    expect(result.error).toBeNull();
  });
});
