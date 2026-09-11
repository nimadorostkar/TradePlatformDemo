import { describe, expect, it } from 'vitest';
import { SymbolSuffixPolicy } from '@/integrations/gateway/mappers/symbol-suffix';
import type { ExecutionDto } from '@/integrations/gateway/api/features-api';
import { TV_SIDE } from '../types';
import { executionsCursorSeconds, toLibraryExecution, toLibraryExecutions } from './executions';

const suffix = new SymbolSuffixPolicy('.');

function dto(overrides: Partial<ExecutionDto> = {}): ExecutionDto {
  return {
    id: '1',
    orderId: '10',
    positionId: '100',
    symbol: 'EURUSD.',
    price: '1.09551',
    qty: '0.5',
    qtyMt5: 5000,
    side: 0,
    time: 1_700_000_000_000,
    timeSeconds: 1_700_000_000,
    commission: '-0.7',
    swap: '0',
    profit: '12.4',
    entry: 0,
    comment: '',
    ...overrides,
  } as ExecutionDto;
}

describe('toLibraryExecution', () => {
  it('maps a buy fill and strips the account suffix', () => {
    expect(toLibraryExecution(dto(), suffix)).toEqual({
      symbol: 'EURUSD',
      price: 1.09551,
      qty: 0.5,
      side: TV_SIDE.Buy,
      time: 1_700_000_000_000,
      commission: -0.7,
    });
  });

  it('maps side 1 to Sell', () => {
    expect(toLibraryExecution(dto({ side: 1 }), suffix)?.side).toBe(TV_SIDE.Sell);
  });

  it('drops non-trade deal actions rather than guessing a side', () => {
    // 2 is a balance operation — it has no price on a chart.
    expect(toLibraryExecution(dto({ side: 2 }), suffix)).toBeNull();
  });

  it('drops a fill with a non-positive price', () => {
    expect(toLibraryExecution(dto({ price: '0' }), suffix)).toBeNull();
    expect(toLibraryExecution(dto({ price: 'n/a' }), suffix)).toBeNull();
  });

  it('drops a fill with a non-positive quantity', () => {
    expect(toLibraryExecution(dto({ qty: '0' }), suffix)).toBeNull();
  });

  it('falls back to timeSeconds when the millisecond field is missing', () => {
    const mapped = toLibraryExecution(dto({ time: 0, timeSeconds: 1_700_000_000 }), suffix);
    expect(mapped?.time).toBe(1_700_000_000_000);
  });

  it('drops a fill with no usable timestamp', () => {
    expect(toLibraryExecution(dto({ time: 0, timeSeconds: null }), suffix)).toBeNull();
  });

  it('omits commission entirely when the gateway did not report one', () => {
    const mapped = toLibraryExecution(dto({ commission: null }), suffix);
    expect(mapped).not.toBeNull();
    expect(mapped && 'commission' in mapped).toBe(false);
  });

  it('keeps a zero commission, which is a real value', () => {
    expect(toLibraryExecution(dto({ commission: 0 }), suffix)?.commission).toBe(0);
  });
});

describe('toLibraryExecutions', () => {
  it('skips unmappable entries without discarding the batch', () => {
    const mapped = toLibraryExecutions(
      [dto(), dto({ id: '2', side: 7 }), dto({ id: '3' })],
      suffix,
    );
    expect(mapped).toHaveLength(2);
  });
});

describe('executionsCursorSeconds', () => {
  it('returns a second-precision cursor the configured window back', () => {
    const now = 1_700_000_000_000;
    expect(executionsCursorSeconds(now, 30)).toBe(1_700_000_000 - 30 * 86_400);
  });
});
