import { describe, expect, it, vi } from 'vitest';
import { TradingService } from './trading-service';
import type { TradingApi } from '@/integrations/gateway/api/trading-api';
import type { MarketApi } from '@/integrations/gateway/api/market-api';
import { SymbolSuffixPolicy } from '@/integrations/gateway/mappers/symbol-suffix';
import type { DecimalString } from '@/domain/common/decimal';
import type { Position, TradingOrder } from '@/domain/common/models';

/**
 * Cancelling one bracket leg must never disturb the other.
 *
 * This is the single most destructive way to get brackets wrong: clearing a
 * take-profit that also silently drops the stop-loss leaves a live position
 * unprotected, and nothing on screen would say so. The rule differs between the
 * two parent kinds, so both are pinned here rather than at each call site.
 */

const d = (v: string) => v as DecimalString;

function position(overrides: Partial<Position> = {}): Position {
  return {
    id: 'p1',
    symbol: 'EURUSD.',
    displaySymbol: 'EURUSD',
    side: 'buy',
    volume: d('0.10'),
    openPrice: d('1.1000'),
    currentPrice: null,
    stopLoss: d('1.0900'),
    takeProfit: d('1.1200'),
    profit: null,
    swap: null,
    commission: null,
    openTime: null,
    comment: null,
    ...overrides,
  } as Position;
}

function order(overrides: Partial<TradingOrder> = {}): TradingOrder {
  return {
    id: 'o1',
    symbol: 'EURUSD.',
    displaySymbol: 'EURUSD',
    side: 'buy',
    kind: 'limit',
    status: 'working',
    volume: d('0.10'),
    filledVolume: null,
    price: d('1.0800'),
    currentPrice: null,
    stopLoss: d('1.0700'),
    takeProfit: d('1.1000'),
    expiration: null,
    createdAt: null,
    comment: null,
    ...overrides,
  } as TradingOrder;
}

function service() {
  const accepted = {
    state: 'accepted',
    orderId: null,
    retcode: '10009',
    message: null,
    requestId: 'r1',
  };
  const modifyPosition = vi.fn().mockResolvedValue(accepted);
  const modifyOrder = vi.fn().mockResolvedValue(accepted);
  const svc = new TradingService({
    trading: { modifyPosition, modifyOrder } as unknown as TradingApi,
    market: {} as MarketApi,
    getLogin: () => '1001',
    getSuffixPolicy: () => new SymbolSuffixPolicy('.'),
    getSymbol: () => undefined,
    isReadOnly: () => false,
    onStateChanged: () => {},
  });
  return { svc, modifyPosition, modifyOrder };
}

describe('cancelBracketLeg', () => {
  it('clears a position stop-loss and re-states the take-profit', async () => {
    const { svc, modifyPosition } = service();

    await svc.cancelBracketLeg({ kind: 'position', position: position() }, 'sl');

    // modifyPosition always sends BOTH levels, so the survivor must be restated
    // explicitly — an omitted or undefined value would clear it too.
    expect(modifyPosition.mock.calls[0]![0]).toMatchObject({
      positionId: 'p1',
      stopLoss: null,
      takeProfit: '1.1200',
    });
  });

  it('clears a position take-profit and re-states the stop-loss', async () => {
    const { svc, modifyPosition } = service();

    await svc.cancelBracketLeg({ kind: 'position', position: position() }, 'tp');

    expect(modifyPosition.mock.calls[0]![0]).toMatchObject({
      positionId: 'p1',
      stopLoss: '1.0900',
      takeProfit: null,
    });
  });

  it('never sends a non-finite level for the surviving leg', async () => {
    // The trap this method exists to prevent: `undefined` for the sibling
    // reaches the wire as Number(undefined) === NaN.
    const { svc, modifyPosition } = service();

    await svc.cancelBracketLeg({ kind: 'position', position: position() }, 'sl');

    const sent = modifyPosition.mock.calls[0]![0] as { takeProfit: unknown };
    expect(Number.isNaN(Number(sent.takeProfit))).toBe(false);
  });

  it('clears an order leg and leaves its entry, volume and sibling intact', async () => {
    const { svc, modifyOrder } = service();

    await svc.cancelBracketLeg({ kind: 'order', order: order() }, 'tp');

    expect(modifyOrder.mock.calls[0]![0]).toMatchObject({
      orderId: 'o1',
      stopLoss: '1.0700',
      takeProfit: null,
      price: '1.0800',
      volumeLots: '0.10',
    });
  });

  // The assertion that matters: the survivor keeps its PRICE, not merely a
  // non-null value. An `undefined` reaching the wire mapper becomes
  // Number(undefined) -> NaN -> null, which reads as "clear this level" — a
  // silently removed stop on a live position. Both legs, both parent kinds.
  it.each([
    ['order', 'sl', 'takeProfit', '1.1000'],
    ['order', 'tp', 'stopLoss', '1.0700'],
    ['position', 'sl', 'takeProfit', '1.1200'],
    ['position', 'tp', 'stopLoss', '1.0900'],
  ] as const)(
    'cancelling %s %s leaves %s at its exact price',
    async (kind, leg, survivor, expectedPrice) => {
      const { svc, modifyOrder, modifyPosition } = service();

      await svc.cancelBracketLeg(
        kind === 'order'
          ? { kind: 'order', order: order() }
          : { kind: 'position', position: position() },
        leg,
      );

      const transport = kind === 'order' ? modifyOrder : modifyPosition;
      const sent = transport.mock.calls[0]![0] as Record<string, unknown>;

      expect(sent[survivor]).toBe(expectedPrice);
      // Named explicitly rather than left to a sentinel resolved elsewhere.
      expect(sent[survivor]).not.toBeUndefined();
      expect(Number.isNaN(Number(sent[survivor]))).toBe(false);
    },
  );

  it('survives a parent that has only the leg being cancelled', async () => {
    const { svc, modifyPosition } = service();

    await svc.cancelBracketLeg(
      { kind: 'position', position: position({ takeProfit: null }) },
      'sl',
    );

    expect(modifyPosition.mock.calls[0]![0]).toMatchObject({
      stopLoss: null,
      takeProfit: null,
    });
  });
});

describe('pending-order volume cannot be silently dropped', () => {
  // MT5 cannot resize a pending order in place. The server does not reject a
  // changed volume — it applies the rest, ignores the size, and reports
  // success. The dialog used to repeat that as "saved". The service now refuses
  // a changed volume on every path, so no caller can recreate the silent lie.
  it('refuses a modify that changes the volume', async () => {
    const { svc, modifyOrder } = service();

    await expect(
      svc.modifyOrder(order(), { volumeLots: d('0.20'), price: d('1.0800') }),
    ).rejects.toMatchObject({ code: 'trade.no-volume-modify' });
    expect(modifyOrder).not.toHaveBeenCalled();
  });

  it('accepts the same volume written differently', async () => {
    // The chart's drag-to-modify echoes the qty back as "0.1" while the store
    // holds "0.10". Same size, different notation — string comparison would
    // break every drag.
    const { svc, modifyOrder } = service();

    await svc.modifyOrder(order({ volume: d('0.10') }), {
      volumeLots: d('0.1'),
      price: d('1.0790'),
    });

    expect(modifyOrder).toHaveBeenCalledTimes(1);
    expect(modifyOrder.mock.calls[0]![0]).toMatchObject({ price: '1.0790' });
  });

  it('accepts a modify that never mentions volume', async () => {
    const { svc, modifyOrder } = service();

    await svc.modifyOrder(order(), { price: d('1.0790') });

    // The order's own volume rides along unchanged.
    expect(modifyOrder.mock.calls[0]![0]).toMatchObject({ volumeLots: '0.10' });
  });
});
