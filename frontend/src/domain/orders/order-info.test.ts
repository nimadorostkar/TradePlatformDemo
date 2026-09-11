import { describe, expect, it } from 'vitest';
import type { DecimalString } from '@/domain/common/decimal';
import type { TradingSymbol } from '@/domain/common/models';
import { computeOrderInfo, conversionCandidates, rateFromQuote } from './order-info';

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
    // This trading server does not report a tick value for EURUSD — the
    // FX-conversion fallback is the path actually exercised in production.
    tickValue: null,
    currencyCode: 'USD',
    session: '24x5',
    timezone: 'Etc/UTC',
    supportedResolutions: ['1', '5'],
    sector: null,
    industry: null,
    ...overrides,
  };
}

const round2 = (v: string | null) => (v === null ? null : Number(v).toFixed(2));

describe('computeOrderInfo', () => {
  // The exact figures observed live in the Account Summary during a 0.01
  // EURUSD position on account group Opoforex\STD-APP-USD-B.
  it('reproduces the EURUSD worked example (USD quote, USD account)', () => {
    const info = computeOrderInfo({
      symbol: symbol(),
      volumeLots: d('0.01'),
      price: d('1.16806'),
      quoteToAccountRate: d('1'),
      leverage: d('300'),
      marginFree: d('3283.55'),
    });

    expect(round2(info.tradeValue)).toBe('1168.06');
    expect(round2(info.marginUsed)).toBe('3.89');
    expect(info.marginAvailable).toBe(d('3283.55'));
    expect(round2(info.pipValue)).toBe('0.10');
    expect(info.leverage).toBe(d('300'));
  });

  it('converts a JPY-quoted pair through the USDJPY cross rate', () => {
    const usdJpy = 147.5;
    const info = computeOrderInfo({
      symbol: symbol({
        name: 'USDJPY.',
        displayName: 'USDJPY',
        digits: 3,
        pricescale: 1000,
        tickSize: d('0.001'),
        tickValue: null,
        currencyCode: 'JPY',
      }),
      volumeLots: d('0.5'),
      price: d('147.500'),
      // JPY -> USD comes from inverting USDJPY.
      quoteToAccountRate: d(String(1 / usdJpy)),
      leverage: d('300'),
      marginFree: d('10000'),
    });

    // 0.5 × 100000 × 147.5 JPY = 7,375,000 JPY → 50,000 USD.
    expect(round2(info.tradeValue)).toBe('50000.00');
    expect(round2(info.marginUsed)).toBe('166.67');
    // pip = 0.01 for a 3-digit pair: 0.5 × 100000 × 0.01 / 147.5 = 3.39 USD.
    expect(round2(info.pipValue)).toBe('3.39');
  });

  it('computes a metals symbol from its own tick spec when the server reports one', () => {
    const info = computeOrderInfo({
      symbol: symbol({
        name: 'XAUUSD.',
        displayName: 'XAUUSD',
        type: 'Spot Metals',
        digits: 2,
        pricescale: 100,
        contractSize: d('100'),
        tickSize: d('0.01'),
        tickValue: d('1'),
        currencyCode: 'USD',
      }),
      volumeLots: d('1.5'),
      price: d('4600.00'),
      quoteToAccountRate: d('1'),
      leverage: d('300'),
      marginFree: d('3283.55'),
    });

    // 1.5 × 100 × 4600 = 690,000 USD notional; margin at 1:300 = 2,300.
    expect(round2(info.tradeValue)).toBe('690000.00');
    expect(round2(info.marginUsed)).toBe('2300.00');
    // Non-fractional digits: pip == tick. (0.01 / 0.01) × 1 × 1.5 lots.
    expect(round2(info.pipValue)).toBe('1.50');
  });

  it('prefers the tick-value path over the FX fallback when both resolve', () => {
    const info = computeOrderInfo({
      symbol: symbol({ tickValue: d('1') }),
      volumeLots: d('0.01'),
      price: d('1.16806'),
      quoteToAccountRate: d('999'), // would be wildly wrong if used
      leverage: d('300'),
      marginFree: d('100'),
    });
    // (0.0001 / 0.00001) × 1 × 0.01 = 0.10 — from the tick spec, not the rate.
    expect(round2(info.pipValue)).toBe('0.10');
  });

  it('yields null — never 0 or NaN — when an input is unavailable', () => {
    const noRate = computeOrderInfo({
      symbol: symbol(), // tickValue null AND no rate: neither pip path resolves
      volumeLots: d('0.01'),
      price: d('1.16806'),
      quoteToAccountRate: null,
      leverage: null,
      marginFree: null,
    });
    expect(noRate.pipValue).toBeNull();
    expect(noRate.tradeValue).toBeNull();
    expect(noRate.marginUsed).toBeNull();
    expect(noRate.marginAvailable).toBeNull();
    expect(noRate.leverage).toBeNull();

    const noSymbol = computeOrderInfo({
      symbol: undefined,
      volumeLots: d('1'),
      price: d('1'),
      quoteToAccountRate: d('1'),
      leverage: d('300'),
      marginFree: d('100'),
    });
    expect(noSymbol.pipValue).toBeNull();
    expect(noSymbol.tradeValue).toBeNull();

    const badVolume = computeOrderInfo({
      symbol: symbol(),
      volumeLots: null,
      price: d('1.16806'),
      quoteToAccountRate: d('1'),
      leverage: d('300'),
      marginFree: d('100'),
    });
    expect(badVolume.tradeValue).toBeNull();
    // Free margin and leverage are account facts — available regardless.
    expect(badVolume.marginAvailable).toBe(d('100'));
    expect(badVolume.leverage).toBe(d('300'));
  });

  it('never divides by a zero leverage', () => {
    const info = computeOrderInfo({
      symbol: symbol({ tickValue: d('1') }),
      volumeLots: d('0.01'),
      price: d('1.16806'),
      quoteToAccountRate: d('1'),
      leverage: d('0'),
      marginFree: d('100'),
    });
    expect(info.marginUsed).toBeNull();
    expect(info.leverage).toBeNull();
  });
});

describe('conversionCandidates', () => {
  it('is empty when the currencies already match', () => {
    expect(conversionCandidates('USD', 'USD')).toEqual([]);
  });

  it('offers the direct pair first, then the inverted one', () => {
    expect(conversionCandidates('JPY', 'USD')).toEqual([
      { pair: 'JPYUSD', invert: false },
      { pair: 'USDJPY', invert: true },
    ]);
  });
});

describe('rateFromQuote', () => {
  it('uses the mid price, inverted when the pair is backwards', () => {
    expect(Number(rateFromQuote(d('147.4'), d('147.6'), false))).toBeCloseTo(147.5);
    expect(Number(rateFromQuote(d('147.4'), d('147.6'), true))).toBeCloseTo(1 / 147.5);
  });

  it('refuses a zero quote rather than returning Infinity', () => {
    expect(rateFromQuote(d('0'), d('0'), true)).toBeNull();
  });
});

describe('margin used across leverage presets', () => {
  // The QA regression: on an 1,100.00 USD trade value, 1:200 must show 5.50
  // and 1:300 must show 3.67 — Margin Used is TradeValue / leverage for every
  // preset the broker offers, with no preset-specific special cases.
  it.each([
    ['100', '11.00'],
    ['200', '5.50'],
    ['300', '3.67'],
    ['400', '2.75'],
    ['500', '2.20'],
  ])('1:%s → %s USD on a 1,100.00 trade value', (leverage, expected) => {
    const info = computeOrderInfo({
      symbol: symbol(),
      volumeLots: d('0.01'),
      price: d('1.10000'),
      quoteToAccountRate: d('1'),
      leverage: d(leverage),
      marginFree: d('3000'),
    });
    expect(round2(info.tradeValue)).toBe('1100.00');
    expect(round2(info.marginUsed)).toBe(expected);
  });
});
