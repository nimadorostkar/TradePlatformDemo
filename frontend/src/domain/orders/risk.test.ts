import { describe, expect, it } from 'vitest';
import type { DecimalString } from '@/domain/common/decimal';
import type { TradingSymbol } from '@/domain/common/models';
import { bracketToPrice, calculateRisk, pipSize, priceFromPips } from './risk';

const d = (v: string) => v as DecimalString;

function symbol(overrides: Partial<TradingSymbol> = {}): TradingSymbol {
  return {
    name: 'EURUSD.',
    displayName: 'EURUSD',
    description: 'Euro vs US Dollar',
    type: 'FX',
    exchange: 'Broker',
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
    session: '24x5',
    timezone: 'Etc/UTC',
    supportedResolutions: ['1', '5'],
    sector: null,
    industry: null,
    ...overrides,
  };
}

describe('calculateRisk', () => {
  it('sizes a position from equity and risk percentage', () => {
    const result = calculateRisk({
      symbol: symbol(),
      equity: d('10000'),
      riskPercent: '1',
      entryPrice: d('1.10000'),
      stopLossPrice: d('1.09900'),
      side: 'buy',
    });

    // risk = 100; stop distance = 0.001 = 100 ticks; loss/lot = 100 × 1 = 100
    // → 1.00 lot
    expect(result.riskAmount).toBe('100');
    expect(result.stopDistance).toBe('0.001');
    expect(result.suggestedVolume).toBe('1');
    expect(result.potentialLoss).toBe('100');
    expect(result.unavailable).toHaveLength(0);
  });

  it('quantises the suggested volume DOWN to the step', () => {
    const result = calculateRisk({
      symbol: symbol(),
      equity: d('10000'),
      riskPercent: '1.5',
      entryPrice: d('1.10000'),
      stopLossPrice: d('1.09900'),
      side: 'buy',
    });
    // Exact would be 1.5; with a coarser step it must round down, never up.
    const coarse = calculateRisk({
      symbol: symbol({ volumeStep: d('1') }),
      equity: d('10000'),
      riskPercent: '1.5',
      entryPrice: d('1.10000'),
      stopLossPrice: d('1.09900'),
      side: 'buy',
    });
    expect(result.suggestedVolume).toBe('1.5');
    expect(coarse.suggestedVolume).toBe('1');
  });

  it('refuses to size when tick size or tick value is unavailable', () => {
    // A lot size derived from a guessed tick value is a real position at the
    // wrong risk, so the calculator must decline and say why.
    const result = calculateRisk({
      symbol: symbol({ tickSize: null, tickValue: null }),
      equity: d('10000'),
      riskPercent: '1',
      entryPrice: d('1.10000'),
      stopLossPrice: d('1.09900'),
      side: 'buy',
    });

    expect(result.suggestedVolume).toBeNull();
    expect(result.potentialLoss).toBeNull();
    expect(result.unavailable.join(' ')).toMatch(/tick size and tick value are unavailable/i);
  });

  it('refuses to size without a stop-loss', () => {
    const result = calculateRisk({
      symbol: symbol(),
      equity: d('10000'),
      riskPercent: '1',
      entryPrice: d('1.10000'),
      stopLossPrice: null,
      side: 'buy',
    });
    expect(result.suggestedVolume).toBeNull();
    expect(result.unavailable.join(' ')).toMatch(/stop-loss/i);
  });

  it('refuses when the stop equals the entry', () => {
    const result = calculateRisk({
      symbol: symbol(),
      equity: d('10000'),
      riskPercent: '1',
      entryPrice: d('1.10000'),
      stopLossPrice: d('1.10000'),
      side: 'buy',
    });
    expect(result.stopDistance).toBeNull();
    expect(result.suggestedVolume).toBeNull();
  });

  it('reports equity as unavailable rather than assuming a value', () => {
    const result = calculateRisk({
      symbol: symbol(),
      equity: null,
      riskPercent: '1',
      entryPrice: d('1.10000'),
      stopLossPrice: d('1.09900'),
      side: 'buy',
    });
    expect(result.riskAmount).toBeNull();
    expect(result.suggestedVolume).toBeNull();
    expect(result.unavailable.join(' ')).toMatch(/equity is unavailable/i);
  });

  it('prefers an explicit risk amount over the percentage', () => {
    const result = calculateRisk({
      symbol: symbol(),
      equity: d('10000'),
      riskPercent: '1',
      riskAmount: '250',
      entryPrice: d('1.10000'),
      stopLossPrice: d('1.09900'),
      side: 'buy',
    });
    expect(result.riskAmount).toBe('250');
    expect(result.suggestedVolume).toBe('2.5');
  });

  it('computes the risk/reward ratio', () => {
    const result = calculateRisk({
      symbol: symbol(),
      equity: d('10000'),
      riskPercent: '1',
      entryPrice: d('1.10000'),
      stopLossPrice: d('1.09900'),
      takeProfitPrice: d('1.10300'),
      side: 'buy',
    });
    expect(result.riskRewardRatio).toBe('3');
    expect(result.potentialProfit).toBe('300');
  });

  it('reports when the risk is too small for the minimum volume', () => {
    const result = calculateRisk({
      symbol: symbol({ volumeStep: d('1') }),
      equity: d('100'),
      riskPercent: '0.1',
      entryPrice: d('1.10000'),
      stopLossPrice: d('1.09900'),
      side: 'buy',
    });
    expect(result.suggestedVolume).toBeNull();
    expect(result.unavailable.join(' ')).toMatch(/too small/i);
  });
});

describe('pip helpers', () => {
  it('treats a 5-digit quote as a fractional pip', () => {
    expect(pipSize(symbol({ digits: 5, tickSize: d('0.00001') }))).toBe('0.0001');
  });

  it('treats a 2-digit quote as a whole pip', () => {
    expect(pipSize(symbol({ digits: 2, tickSize: d('0.01') }))).toBe('0.01');
  });

  it('converts pips to a price offset on the correct side', () => {
    const s = symbol();
    expect(priceFromPips(d('1.10000'), '20', s, 'below')).toBe('1.098');
    expect(priceFromPips(d('1.10000'), '20', s, 'above')).toBe('1.102');
  });
});

describe('bracketToPrice', () => {
  const entry = d('1.10000');

  // Changed deliberately (2026-08-22): this used to assert 1.09877, because a
  // typed price was rounded to the symbol's digits here. That rounding is what
  // let an unplaceable price become a placeable one behind the trader's back —
  // they typed a number this instrument cannot trade at and were shown, and
  // sent, a different one. The value now survives the conversion untouched so
  // `validateOrder` can say it is off the grid.
  it('hands a typed price back exactly as typed', () => {
    const result = bracketToPrice({
      unit: 'price',
      value: '1.0987654',
      entryPrice: entry,
      symbol: symbol(),
      side: 'buy',
      kind: 'stopLoss',
    });
    expect(result.price).toBe('1.0987654');
  });

  // A COMPUTED bracket is different: the trader typed a distance, not a price,
  // so landing it on the grid is the conversion's job rather than something to
  // report back to them. It used to round to the symbol's digits, which is the
  // same thing only while the tick IS the point — on an instrument quoting a
  // coarser tick it produced a price the server would refuse, and, since the
  // grid became a validation rule, an error the trader could not act on.
  it('snaps a computed bracket onto a coarse tick', () => {
    const coarse = symbol({ digits: 2, tickSize: d('0.25') });
    const result = bracketToPrice({
      unit: 'percent',
      value: '1',
      entryPrice: d('4605.03'),
      symbol: coarse,
      side: 'buy',
      kind: 'stopLoss',
    });
    // 4605.03 - 1% = 4559.0. Nearest quarter: 4559.
    expect(result.price).not.toBeNull();
    expect(Number(result.price) % 0.25).toBe(0);
  });

  it('places a BUY stop below entry and a BUY target above', () => {
    // Getting this backwards would close the trade the moment it opens.
    const stop = bracketToPrice({
      unit: 'pips',
      value: '20',
      entryPrice: entry,
      symbol: symbol(),
      side: 'buy',
      kind: 'stopLoss',
    });
    const target = bracketToPrice({
      unit: 'pips',
      value: '20',
      entryPrice: entry,
      symbol: symbol(),
      side: 'buy',
      kind: 'takeProfit',
    });
    expect(stop.price).toBe('1.098');
    expect(target.price).toBe('1.102');
  });

  it('mirrors the direction for a SELL', () => {
    const stop = bracketToPrice({
      unit: 'pips',
      value: '20',
      entryPrice: entry,
      symbol: symbol(),
      side: 'sell',
      kind: 'stopLoss',
    });
    const target = bracketToPrice({
      unit: 'pips',
      value: '20',
      entryPrice: entry,
      symbol: symbol(),
      side: 'sell',
      kind: 'takeProfit',
    });
    expect(stop.price).toBe('1.102');
    expect(target.price).toBe('1.098');
  });

  it('converts a percentage of the entry price', () => {
    const result = bracketToPrice({
      unit: 'percent',
      value: '1',
      entryPrice: entry,
      symbol: symbol(),
      side: 'buy',
      kind: 'stopLoss',
    });
    expect(result.price).toBe('1.089');
  });

  it('converts a cash amount using volume and tick value', () => {
    // 1 lot, tick 0.00001, tickValue 1 -> 100000 per price unit.
    // $100 risk => 0.001 price distance => 1.09900.
    const result = bracketToPrice({
      unit: 'money',
      value: '100',
      entryPrice: entry,
      symbol: symbol(),
      side: 'buy',
      kind: 'stopLoss',
      volumeLots: d('1'),
    });
    expect(result.price).toBe('1.099');
  });

  it('refuses a cash amount without a volume', () => {
    const result = bracketToPrice({
      unit: 'money',
      value: '100',
      entryPrice: entry,
      symbol: symbol(),
      side: 'buy',
      kind: 'stopLoss',
      volumeLots: null,
    });
    expect(result.price).toBeNull();
    expect(result.unavailable).toMatch(/volume/i);
  });

  it('refuses a cash amount when tick data is unavailable', () => {
    const result = bracketToPrice({
      unit: 'money',
      value: '100',
      entryPrice: entry,
      symbol: symbol({ tickSize: null, tickValue: null }),
      side: 'buy',
      kind: 'stopLoss',
      volumeLots: d('1'),
    });
    expect(result.price).toBeNull();
    expect(result.unavailable).toMatch(/tick size and value/i);
  });

  it('treats an empty field as "no level", not as an error', () => {
    const result = bracketToPrice({
      unit: 'pips',
      value: '   ',
      entryPrice: entry,
      symbol: symbol(),
      side: 'buy',
      kind: 'stopLoss',
    });
    expect(result.price).toBeNull();
    expect(result.unavailable).toBeNull();
  });

  it('rejects a negative or non-numeric distance', () => {
    for (const value of ['-5', 'abc']) {
      const result = bracketToPrice({
        unit: 'pips',
        value,
        entryPrice: entry,
        symbol: symbol(),
        side: 'buy',
        kind: 'stopLoss',
      });
      expect(result.price).toBeNull();
      expect(result.unavailable).toBeTruthy();
    }
  });
});
