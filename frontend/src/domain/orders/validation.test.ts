import { describe, expect, it } from 'vitest';
import type { DecimalString } from '@/domain/common/decimal';
import type { Quote, TradingSymbol } from '@/domain/common/models';
import { issueFor, validateOrder, validatePositionBrackets } from './validation';

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
    session: '24x5',
    timezone: 'Etc/UTC',
    supportedResolutions: [],
    sector: null,
    industry: null,
    ...overrides,
  };
}

const quote: Quote = {
  symbol: 'EURUSD.',
  bid: d('1.10000'),
  ask: d('1.10020'),
  last: d('1.10010'),
  volume: null,
  receivedAt: Date.now(),
  direction: 'flat',
};

describe('volume validation', () => {
  it('accepts a valid market order', () => {
    const result = validateOrder(
      { kind: 'market', side: 'buy', volume: '0.10' },
      { symbol: symbol(), quote, readOnly: false },
    );
    expect(result.canSubmit).toBe(true);
  });

  it('rejects a volume below the minimum', () => {
    const result = validateOrder(
      { kind: 'market', side: 'buy', volume: '0.001' },
      { symbol: symbol(), quote, readOnly: false },
    );
    expect(result.canSubmit).toBe(false);
    expect(issueFor(result, 'volume')?.message).toMatch(/minimum volume/i);
  });

  it('rejects a volume above the maximum', () => {
    const result = validateOrder(
      { kind: 'market', side: 'buy', volume: '500' },
      { symbol: symbol(), quote, readOnly: false },
    );
    expect(issueFor(result, 'volume')?.message).toMatch(/maximum volume/i);
  });

  it('rejects a volume off the step grid', () => {
    const result = validateOrder(
      { kind: 'market', side: 'buy', volume: '0.015' },
      { symbol: symbol(), quote, readOnly: false },
    );
    expect(issueFor(result, 'volume')?.message).toMatch(/multiple of/i);
  });

  it('warns — but does NOT block — when volume limits are unavailable', () => {
    // The gateway's TradingView symbol shape does not carry real limits.
    // Blocking a trade the server would accept is not our call to make.
    const result = validateOrder(
      { kind: 'market', side: 'buy', volume: '0.10' },
      { symbol: symbol({ volumeMin: null, volumeStep: null }), quote, readOnly: false },
    );
    expect(result.canSubmit).toBe(true);
    expect(issueFor(result, 'volume')?.severity).toBe('warning');
  });

  it('rejects a non-numeric or zero volume', () => {
    expect(
      validateOrder(
        { kind: 'market', side: 'buy', volume: 'abc' },
        { symbol: symbol(), quote, readOnly: false },
      ).canSubmit,
    ).toBe(false);
    expect(
      validateOrder(
        { kind: 'market', side: 'buy', volume: '0' },
        { symbol: symbol(), quote, readOnly: false },
      ).canSubmit,
    ).toBe(false);
  });
});

describe('pending order price validation', () => {
  it('rejects a buy limit above the market', () => {
    const result = validateOrder(
      { kind: 'limit', side: 'buy', volume: '0.10', price: '1.20000' },
      { symbol: symbol(), quote, readOnly: false },
    );
    expect(issueFor(result, 'price')?.message).toMatch(/below the current price/i);
  });

  it('accepts a buy limit below the market', () => {
    const result = validateOrder(
      { kind: 'limit', side: 'buy', volume: '0.10', price: '1.09000' },
      { symbol: symbol(), quote, readOnly: false },
    );
    expect(result.canSubmit).toBe(true);
  });

  it('rejects a buy stop below the market', () => {
    const result = validateOrder(
      { kind: 'stop', side: 'buy', volume: '0.10', price: '1.09000' },
      { symbol: symbol(), quote, readOnly: false },
    );
    expect(issueFor(result, 'price')?.message).toMatch(/above the current price/i);
  });

  it('requires an entry price for a pending order', () => {
    const result = validateOrder(
      { kind: 'limit', side: 'buy', volume: '0.10' },
      { symbol: symbol(), quote, readOnly: false },
    );
    expect(issueFor(result, 'price')?.message).toMatch(/enter an entry price/i);
  });
});

describe('protective level validation', () => {
  it('rejects a buy stop-loss above the entry', () => {
    // A stop on the wrong side would close the trade the moment it opens.
    const result = validateOrder(
      { kind: 'market', side: 'buy', volume: '0.10', stopLoss: '1.20000' },
      { symbol: symbol(), quote, readOnly: false },
    );
    expect(issueFor(result, 'stopLoss')?.message).toMatch(/below the entry price/i);
  });

  it('rejects a sell stop-loss below the entry', () => {
    const result = validateOrder(
      { kind: 'market', side: 'sell', volume: '0.10', stopLoss: '1.00000' },
      { symbol: symbol(), quote, readOnly: false },
    );
    expect(issueFor(result, 'stopLoss')?.message).toMatch(/above the entry price/i);
  });

  it('rejects a buy take-profit below the entry', () => {
    const result = validateOrder(
      { kind: 'market', side: 'buy', volume: '0.10', takeProfit: '1.00000' },
      { symbol: symbol(), quote, readOnly: false },
    );
    expect(issueFor(result, 'takeProfit')?.message).toMatch(/above the entry price/i);
  });

  it('accepts correctly placed levels', () => {
    const result = validateOrder(
      { kind: 'market', side: 'buy', volume: '0.10', stopLoss: '1.09000', takeProfit: '1.12000' },
      { symbol: symbol(), quote, readOnly: false },
    );
    expect(result.canSubmit).toBe(true);
  });
});

describe('account and market state', () => {
  it('blocks a read-only account', () => {
    const result = validateOrder(
      { kind: 'market', side: 'buy', volume: '0.10' },
      { symbol: symbol(), quote, readOnly: true },
    );
    expect(result.canSubmit).toBe(false);
    expect(issueFor(result, 'account')?.message).toMatch(/read-only/i);
  });

  it('blocks when the market is closed', () => {
    const result = validateOrder(
      { kind: 'market', side: 'buy', volume: '0.10' },
      { symbol: symbol(), quote, readOnly: false, marketClosed: true },
    );
    expect(result.canSubmit).toBe(false);
    expect(issueFor(result, 'symbol')?.message).toMatch(/market is closed/i);
  });

  it('blocks a market order with no live price', () => {
    const result = validateOrder(
      { kind: 'market', side: 'buy', volume: '0.10' },
      { symbol: symbol(), quote: undefined, readOnly: false },
    );
    expect(result.canSubmit).toBe(false);
    expect(issueFor(result, 'price')?.message).toMatch(/no live price/i);
  });

  it('blocks a market order priced at zero, however the quote got there', () => {
    // The mapper no longer builds a quote from a priceless tick, but a market
    // order submitted at 0 is a rejection at best — so it is refused here too.
    const result = validateOrder(
      { kind: 'market', side: 'buy', volume: '0.10' },
      {
        symbol: symbol(),
        quote: { ...quote, bid: d('0'), ask: d('0') },
        readOnly: false,
      },
    );
    expect(result.canSubmit).toBe(false);
    expect(issueFor(result, 'price')?.message).toMatch(/no live price/i);
  });

  it('blocks when no symbol is selected', () => {
    const result = validateOrder(
      { kind: 'market', side: 'buy', volume: '0.10' },
      { symbol: undefined, quote, readOnly: false },
    );
    expect(result.canSubmit).toBe(false);
  });
});

/**
 * QA, 2026-08-24: a BUY opened at 1.16614 accepted a stop-loss of 1.20000 —
 * above the entry, where a stop can never protect a long — with Save enabled
 * and no message at all. Take-profit was not checked in any direction.
 */
describe('open position bracket validation', () => {
  const d5 = (v: string) => d(v);

  it('refuses a stop-loss the far side of the market on a long', () => {
    const result = validatePositionBrackets(
      { side: 'buy', stopLoss: '1.20000', takeProfit: '' },
      { referencePrice: d5('1.16600'), symbol: symbol() },
    );
    expect(result.canSubmit).toBe(false);
    expect(issueFor(result, 'stopLoss')?.message).toMatch(/must be below the current price/i);
  });

  it('refuses a take-profit below the market on a long — the leg nobody checked', () => {
    const result = validatePositionBrackets(
      { side: 'buy', stopLoss: '', takeProfit: '1.16000' },
      { referencePrice: d5('1.16600'), symbol: symbol() },
    );
    expect(result.canSubmit).toBe(false);
    expect(issueFor(result, 'takeProfit')?.message).toMatch(/must be above the current price/i);
  });

  it('mirrors both rules for a short', () => {
    const short = validatePositionBrackets(
      { side: 'sell', stopLoss: '1.16000', takeProfit: '1.17000' },
      { referencePrice: d5('1.16600'), symbol: symbol() },
    );
    expect(short.canSubmit).toBe(false);
    expect(issueFor(short, 'stopLoss')?.message).toMatch(/must be above the current price/i);
    expect(issueFor(short, 'takeProfit')?.message).toMatch(/must be below the current price/i);
  });

  it('allows a profit-locking stop above the entry, which the old rule forbade', () => {
    // A long opened at 1.16614 that has run to 1.17000 can perfectly well
    // carry a stop at 1.16800 — that is what the break-even button does.
    const result = validatePositionBrackets(
      { side: 'buy', stopLoss: '1.16800', takeProfit: '1.17500' },
      { referencePrice: d5('1.17000'), symbol: symbol() },
    );
    expect(result.canSubmit).toBe(true);
  });

  it('accepts empty fields — that is how a level is removed', () => {
    const result = validatePositionBrackets(
      { side: 'buy', stopLoss: '', takeProfit: '' },
      { referencePrice: d5('1.16600'), symbol: symbol() },
    );
    expect(result.canSubmit).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it('rejects text that is not a price', () => {
    const result = validatePositionBrackets(
      { side: 'buy', stopLoss: 'abc', takeProfit: '' },
      { referencePrice: d5('1.16600'), symbol: symbol() },
    );
    expect(result.canSubmit).toBe(false);
    expect(issueFor(result, 'stopLoss')?.message).toMatch(/valid stop-loss/i);
  });

  it('rejects a level off the instrument’s price grid', () => {
    const result = validatePositionBrackets(
      { side: 'buy', stopLoss: '1.1660055', takeProfit: '' },
      { referencePrice: d5('1.16700'), symbol: symbol() },
    );
    expect(result.canSubmit).toBe(false);
  });

  it('warns rather than blocks when there is no price to judge against', () => {
    // Refusing to save would strand a trader wanting a stop on a quiet symbol.
    const result = validatePositionBrackets(
      { side: 'buy', stopLoss: '1.16000', takeProfit: '' },
      { referencePrice: null, symbol: symbol() },
    );
    expect(result.canSubmit).toBe(true);
    expect(issueFor(result, 'price')?.severity).toBe('warning');
  });
});

/**
 * QA, 2026-08-22: 1.1678355 was accepted on a five-digit EURUSD — no inline
 * error, no snap, nothing between it and the server. The ticket had validated
 * volume against its step since the beginning and price against nothing.
 */
describe('price step validation', () => {
  it('rejects an entry price finer than the tick', () => {
    const result = validateOrder(
      { kind: 'limit', side: 'buy', volume: '0.10', price: '1.0987655' },
      { symbol: symbol(), quote, readOnly: false },
    );
    expect(result.canSubmit).toBe(false);
    expect(issueFor(result, 'price')?.message).toBe('Price must be a multiple of 0.00001.');
  });

  it('accepts an entry price on the tick', () => {
    const result = validateOrder(
      { kind: 'limit', side: 'buy', volume: '0.10', price: '1.09876' },
      { symbol: symbol(), quote, readOnly: false },
    );
    expect(result.canSubmit).toBe(true);
  });

  // A JPY pair prices to three digits, and the grid has to follow the SYMBOL
  // rather than a constant: 158.9715 is a valid EURUSD-shaped number and an
  // invalid USDJPY price.
  it('follows the symbol’s own precision', () => {
    const jpy = symbol({ digits: 3, tickSize: d('0.001'), name: 'USDJPY.' });
    const jpyQuote: Quote = { ...quote, bid: d('158.900'), ask: d('158.920') };
    const invalid = validateOrder(
      { kind: 'limit', side: 'buy', volume: '0.10', price: '158.8715' },
      { symbol: jpy, quote: jpyQuote, readOnly: false },
    );
    expect(issueFor(invalid, 'price')?.message).toBe('Price must be a multiple of 0.001.');

    const valid = validateOrder(
      { kind: 'limit', side: 'buy', volume: '0.10', price: '158.871' },
      { symbol: jpy, quote: jpyQuote, readOnly: false },
    );
    expect(valid.canSubmit).toBe(true);
  });

  // MT5 reports TickSize 0 — mapped to null — to mean "use the point". The grid
  // is 10^-digits, not absent, so an off-grid price is still a real error.
  it('falls back to the point when the server states no tick size', () => {
    const result = validateOrder(
      { kind: 'limit', side: 'buy', volume: '0.10', price: '1.0987655' },
      { symbol: symbol({ tickSize: null }), quote, readOnly: false },
    );
    expect(result.canSubmit).toBe(false);
    expect(issueFor(result, 'price')?.message).toBe('Price must be a multiple of 0.00001.');
  });

  it('holds the protective levels to the same grid', () => {
    const result = validateOrder(
      {
        kind: 'market',
        side: 'buy',
        volume: '0.10',
        stopLoss: '1.0987655',
        takeProfit: '1.1098766',
      },
      { symbol: symbol(), quote, readOnly: false },
    );
    expect(result.canSubmit).toBe(false);
    expect(issueFor(result, 'stopLoss')?.message).toBe('Stop-loss must be a multiple of 0.00001.');
    expect(issueFor(result, 'takeProfit')?.message).toBe(
      'Take-profit must be a multiple of 0.00001.',
    );
  });

  // The wrong-side rule and the grid rule are independent: a price can fail one
  // and pass the other, and a trader has to be told about the one they hit.
  it('reports the wrong side and the grid separately', () => {
    const offGridWrongSide = validateOrder(
      { kind: 'limit', side: 'buy', volume: '0.10', price: '1.2098765' },
      { symbol: symbol(), quote, readOnly: false },
    );
    const messages = offGridWrongSide.issues
      .filter((i) => i.field === 'price')
      .map((i) => i.message);
    expect(messages).toContain('Price must be a multiple of 0.00001.');
    expect(messages).toContain('A buy limit must be below the current price.');
  });
});
