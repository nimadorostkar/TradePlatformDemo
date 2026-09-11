import { describe, expect, it } from 'vitest';
import type { ExecutionDto } from '@/integrations/gateway/api/features-api';
import { settlementFromExecutions, settlementMessage } from './close-settlement';

/**
 * FIN-001: the close report must come from the CLOSING DEAL's settlement, to
 * the cent, never from a floating value. The fixture reproduces the production
 * observation: floating P/L said -0.12 while the deal settled -0.13.
 */

function fill(overrides: Partial<ExecutionDto>): ExecutionDto {
  return {
    id: 'd1',
    orderId: 'o1',
    positionId: '106085337',
    symbol: 'EURUSD!',
    price: '1.15515',
    qty: '0.01',
    qtyMt5: 100,
    side: 1,
    time: 1_754_844_000_000,
    timeSeconds: 1_754_844_000,
    commission: 0,
    swap: 0,
    profit: -0.13,
    entry: 1,
    comment: '',
    ...overrides,
  };
}

describe('settlementFromExecutions', () => {
  it('reports the closing deal exactly, not a floating value', () => {
    const settlement = settlementFromExecutions([fill({})], '106085337', 1_754_843_000);
    expect(settlement).not.toBeNull();
    expect(settlement?.net).toBeCloseTo(-0.13, 10);
    expect(settlement?.grossProfit).toBeCloseTo(-0.13, 10);
    expect(settlement?.dealIds).toEqual(['d1']);
    expect(settlement?.closePrice).toBe('1.15515');
  });

  it('sums commission and swap into the net', () => {
    const settlement = settlementFromExecutions(
      [fill({ profit: -0.1, commission: -0.02, swap: -0.01 })],
      '106085337',
      0,
    );
    expect(settlement?.net).toBeCloseTo(-0.13, 10);
    expect(settlement?.commission).toBeCloseTo(-0.02, 10);
    expect(settlement?.swap).toBeCloseTo(-0.01, 10);
  });

  it('ignores opening fills, other positions, and stale fills', () => {
    const fills = [
      fill({ id: 'open', entry: 0 }), // the opening leg is not a settlement
      fill({ id: 'other', positionId: '999' }),
      fill({ id: 'old', timeSeconds: 10 }), // predates the close request
    ];
    expect(settlementFromExecutions(fills, '106085337', 1_754_843_000)).toBeNull();
  });

  it('aggregates a close executed in several partial fills', () => {
    const fills = [
      fill({ id: 'a', profit: -0.05 }),
      fill({ id: 'b', profit: -0.08, price: '1.15514' }),
    ];
    const settlement = settlementFromExecutions(fills, '106085337', 0);
    expect(settlement?.net).toBeCloseTo(-0.13, 10);
    expect(settlement?.dealIds).toEqual(['a', 'b']);
    expect(settlement?.closePrice).toBe('1.15514');
  });
});

describe('settlementMessage', () => {
  it('shows only the net when there are no fees', () => {
    const settlement = settlementFromExecutions([fill({})], '106085337', 0);
    expect(settlementMessage(settlement!, 'USD')).toBe(
      'Position 106085337 closed at 1.15515: net -0.13 USD.',
    );
  });

  it('breaks fees out whenever they are non-zero', () => {
    const settlement = settlementFromExecutions(
      [fill({ profit: -0.1, commission: -0.02, swap: -0.01 })],
      '106085337',
      0,
    );
    expect(settlementMessage(settlement!, 'USD')).toBe(
      'Position 106085337 closed at 1.15515: net -0.13 USD (gross -0.10, commission -0.02, swap -0.01).',
    );
  });
});
