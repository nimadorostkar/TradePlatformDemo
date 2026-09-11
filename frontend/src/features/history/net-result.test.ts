import { describe, expect, it } from 'vitest';
import type { ClosedPosition } from '@/domain/common/models';
import { historyTotals, netResultOf } from './net-result';

const row = (overrides: Partial<ClosedPosition>): ClosedPosition =>
  ({
    id: '1',
    symbol: 'EURUSD.',
    displaySymbol: 'EURUSD',
    side: 'buy',
    volume: '0.01',
    openPrice: '1.16614',
    closePrice: '1.16627',
    openTime: 1_700_000_000_000,
    closeTime: 1_700_003_600_000,
    profit: '0.13',
    swap: null,
    commission: '-0.04',
    ...overrides,
  }) as ClosedPosition;

describe('netResultOf', () => {
  it('is profit less swap and commission — the balance delta', () => {
    expect(netResultOf(row({}))).toBe('0.09');
  });

  it('treats absent charges as nothing charged', () => {
    expect(netResultOf(row({ swap: null, commission: null }))).toBe('0.13');
  });

  it('does not lose cents to binary floating point', () => {
    // 0.1 + 0.2 in float is 0.30000000000000004; money must not be.
    expect(netResultOf(row({ profit: '0.1', swap: '0.2', commission: null }))).toBe('0.3');
  });
});

describe('historyTotals', () => {
  it('reports the period net, not the gross the columns contradict', () => {
    const totals = historyTotals([
      row({ id: '1', profit: '0.13', commission: '-0.04' }),
      row({ id: '2', profit: '0.10', commission: '-0.06', swap: '-0.02' }),
    ]);

    expect(totals.gross).toBe('0.23');
    expect(totals.charges).toBe('-0.12');
    expect(totals.net).toBe('0.11');
  });

  it('classifies a fee-eaten trade as the loss it was', () => {
    // Gross +0.03, commission -0.08: the balance went down. Counting it as a
    // win while its own row shows red is the same inconsistency elsewhere.
    const totals = historyTotals([row({ profit: '0.03', commission: '-0.08' })]);

    expect(totals.wins).toBe(0);
    expect(totals.losses).toBe(1);
    expect(totals.winRate).toBe(0);
  });

  it('rates nothing when nothing closed', () => {
    const totals = historyTotals([]);
    expect(totals.net).toBe('0');
    expect(totals.winRate).toBeNull();
  });
});
