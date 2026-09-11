import { describe, expect, it } from 'vitest';
import type { DecimalString } from '@/domain/common/decimal';
import type { TradingSymbol } from '@/domain/common/models';
import { volumePresets } from './volume-presets';

const d = (v: string) => v as DecimalString;

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

describe('volumePresets', () => {
  it('derives presets from a typical FX minimum', () => {
    expect(volumePresets(symbol())).toEqual(['0.01', '0.1', '0.5', '1']);
  });

  it('scales to an instrument with a larger minimum', () => {
    // A fixed 0.01/0.10/0.50 set would offer three volumes this symbol cannot
    // accept.
    const presets = volumePresets(symbol({ volumeMin: d('1'), volumeStep: d('1') }));
    expect(presets).toEqual(['1', '10', '50', '100']);
  });

  it('never offers a preset above the maximum', () => {
    const presets = volumePresets(
      symbol({ volumeMin: d('0.1'), volumeStep: d('0.1'), volumeMax: d('5') }),
    );
    expect(presets.every((p) => Number(p) <= 5)).toBe(true);
    expect(presets).toContain('0.1');
  });

  it('snaps every preset onto the step grid', () => {
    // min 0.03 with step 0.05 → valid volumes are 0.03, 0.08, 0.13 …
    const presets = volumePresets(symbol({ volumeMin: d('0.03'), volumeStep: d('0.05') }));
    for (const preset of presets) {
      const steps = (Number(preset) - 0.03) / 0.05;
      expect(Math.abs(steps - Math.round(steps))).toBeLessThan(1e-9);
    }
  });

  it('falls back when the instrument limits are unavailable', () => {
    expect(volumePresets(symbol({ volumeMin: null, volumeStep: null }))).toEqual([
      '0.01',
      '0.10',
      '0.50',
      '1.00',
    ]);
    expect(volumePresets(undefined)).toHaveLength(4);
  });

  it('does not emit duplicates', () => {
    const presets = volumePresets(
      symbol({ volumeMin: d('1'), volumeStep: d('1'), volumeMax: d('1') }),
    );
    expect(new Set(presets).size).toBe(presets.length);
  });
});
