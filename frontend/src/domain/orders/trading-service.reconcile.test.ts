import { describe, expect, it, vi } from 'vitest';
import { TradingService } from './trading-service';
import type { TradingApi } from '@/integrations/gateway/api/trading-api';
import type { MarketApi } from '@/integrations/gateway/api/market-api';
import { SymbolSuffixPolicy } from '@/integrations/gateway/mappers/symbol-suffix';
import type { DecimalString } from '@/domain/common/decimal';
import type { Position } from '@/domain/common/models';

/**
 * "No reconcile after a modify" has been reported twice by reviewers reading
 * only the broker adapter. The reconcile lives HERE, one layer down: every
 * mutation exits through settled(), which fires onStateChanged — wired in
 * services.tsx to the account-sync reconciler, whose loadSnapshots() refetches
 * positions, orders and the account immediately. This test makes that chain
 * executable evidence instead of an argument.
 */

const d = (v: string) => v as DecimalString;

function position(): Position {
  return {
    id: 'p1',
    symbol: 'EURUSD.',
    displaySymbol: 'EURUSD',
    side: 'buy',
    volume: d('0.10'),
    openPrice: d('1.1000'),
    currentPrice: null,
    stopLoss: null,
    takeProfit: null,
    profit: null,
    swap: null,
    commission: null,
    openTime: null,
    comment: null,
  } as Position;
}

function serviceWith(result: { state: string }) {
  const onStateChanged = vi.fn();
  const modifyPosition = vi.fn().mockResolvedValue({
    orderId: null,
    retcode: '10009',
    message: null,
    requestId: 'r1',
    ...result,
  });
  const service = new TradingService({
    trading: { modifyPosition } as unknown as TradingApi,
    market: {} as MarketApi,
    getLogin: () => '1001',
    getSuffixPolicy: () => new SymbolSuffixPolicy('.'),
    getSymbol: () => undefined,
    isReadOnly: () => false,
    onStateChanged,
  });
  return { service, onStateChanged, modifyPosition };
}

describe('bracket modify triggers reconciliation', () => {
  it('fires onStateChanged after an ACCEPTED bracket modify', async () => {
    const { service, onStateChanged } = serviceWith({ state: 'accepted' });

    await service.modifyPositionBrackets(position(), {
      stopLoss: d('1.0900'),
      takeProfit: d('1.1200'),
    });

    expect(onStateChanged).toHaveBeenCalledWith('modify-position');
  });

  it('fires onStateChanged even when the outcome is UNKNOWN — a timed-out modify may have applied', async () => {
    const { service, onStateChanged } = serviceWith({ state: 'unknown' });

    await service.modifyPositionBrackets(position(), { stopLoss: null, takeProfit: null });

    expect(onStateChanged).toHaveBeenCalledWith('modify-position');
  });
});
