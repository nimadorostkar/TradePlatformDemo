import { describe, expect, it } from 'vitest';
import { fillPrices } from './fill-prices';
import type { Deal } from '@/domain/common/models';

/**
 * BUG-F, 2026-08-20 retest, the second half: the order history's Price column
 * showed the price an order was PLACED at, not the price it filled at — 1.16759
 * for a stop that executed at 1.16758 — and showed nothing at all for a market
 * order, which has no price of its own. An order record only ever carries what
 * was asked for; the deal is the only record of what the trade actually cost.
 */

const deal = (overrides: Partial<Deal>): Deal =>
  ({
    id: 'd1',
    positionId: null,
    orderId: null,
    kind: 'trade',
    entry: 0,
    symbol: 'EURUSD',
    displaySymbol: 'EURUSD',
    side: 'buy',
    volume: '0.01',
    price: null,
    profit: null,
    swap: null,
    commission: null,
    time: 1_755_711_790_000,
    comment: null,
    ...overrides,
  }) as Deal;

describe('what an order actually executed at', () => {
  it('reports a single fill verbatim', () => {
    const prices = fillPrices([deal({ orderId: '77', price: '1.16758' })]);
    // Verbatim, not round-tripped through a weighted average: dividing one
    // price by its own weight can render 1.16758 as 1.1675800000000001.
    expect(prices.get('77')).toBe('1.16758');
  });

  it('weights a partial fill by the volume that went through at each price', () => {
    const prices = fillPrices([
      deal({ id: 'd1', orderId: '77', price: '1.16750', volume: '0.03' }),
      deal({ id: 'd2', orderId: '77', price: '1.16770', volume: '0.01' }),
    ]);
    // Quoting the first leg would understate what the trader paid for the rest.
    expect(prices.get('77')).toBe('1.16755');
  });

  it('says nothing about an order with no deals behind it', () => {
    // Cancelled, rejected, expired, or filled outside the window: the table
    // falls back to the order's own price rather than inventing a fill.
    const prices = fillPrices([deal({ orderId: '77', price: '1.16758' })]);
    expect(prices.get('99')).toBeUndefined();
  });

  it('ignores ledger entries, which are not fills of anything', () => {
    const prices = fillPrices([
      deal({ orderId: '77', price: '920.00', kind: 'credit' }),
      deal({ id: 'd2', orderId: '78', price: '0', volume: '0.01' }),
    ]);
    expect(prices.size).toBe(0);
  });
});
