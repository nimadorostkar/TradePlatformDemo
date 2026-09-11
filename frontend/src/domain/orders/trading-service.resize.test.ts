import { describe, expect, it, vi } from 'vitest';
import { TradingService } from './trading-service';
import type { TradingApi } from '@/integrations/gateway/api/trading-api';
import type { MarketApi } from '@/integrations/gateway/api/market-api';
import { SymbolSuffixPolicy } from '@/integrations/gateway/mappers/symbol-suffix';
import type { DecimalString } from '@/domain/common/decimal';
import type { TradingOrder, TradingSymbol } from '@/domain/common/models';

/**
 * Resizing a pending order.
 *
 * MT5 cannot change a pending order's size in place: it applies the rest of a
 * modify request, ignores the volume and reports success. The size therefore
 * changes the only way it can — cancel, then place a replacement — and that is
 * a destructive sequence with a window in the middle where the trader owns no
 * order at all. Everything here is about that window.
 */

const d = (v: string) => v as DecimalString;

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

function symbol(overrides: Partial<TradingSymbol> = {}): TradingSymbol {
  return {
    displayName: 'EURUSD',
    digits: 5,
    volumeMin: d('0.01'),
    volumeMax: d('100'),
    volumeStep: d('0.01'),
    ...overrides,
  } as TradingSymbol;
}

const ACCEPTED = {
  state: 'accepted',
  orderId: 'o2',
  retcode: '10009',
  message: null,
  requestId: 'r1',
};

function service(options: { symbol?: TradingSymbol | undefined } = {}) {
  const cancelOrder = vi.fn().mockResolvedValue({ ...ACCEPTED, orderId: 'o1' });
  const placePendingOrder = vi.fn().mockResolvedValue(ACCEPTED);
  const svc = new TradingService({
    trading: { cancelOrder, placePendingOrder } as unknown as TradingApi,
    market: {} as MarketApi,
    getLogin: () => '1001',
    getSuffixPolicy: () => new SymbolSuffixPolicy('.'),
    getSymbol: () => ('symbol' in options ? options.symbol : symbol()),
    isReadOnly: () => false,
    onStateChanged: () => {},
  });
  return { svc, cancelOrder, placePendingOrder };
}

describe('resizePendingOrder — the happy path', () => {
  it('cancels the order and places a replacement at the new size', async () => {
    const { svc, cancelOrder, placePendingOrder } = service();

    const result = await svc.resizePendingOrder(order(), d('0.25'));

    expect(cancelOrder).toHaveBeenCalledOnce();
    expect(cancelOrder.mock.calls[0]![0]).toMatchObject({ orderId: 'o1' });
    expect(placePendingOrder.mock.calls[0]![0]).toMatchObject({
      volumeLots: '0.25',
      // Everything else is carried across untouched: a resize changes the
      // size, not the trade.
      side: 'buy',
      kind: 'limit',
      price: '1.0800',
      stopLoss: '1.0700',
      takeProfit: '1.1000',
    });
    expect(result.previousOrderId).toBe('o1');
    expect(result.placed.orderId).toBe('o2');
  });

  it('cancels BEFORE placing, never the other way round', async () => {
    const calls: string[] = [];
    const { svc, cancelOrder, placePendingOrder } = service();
    cancelOrder.mockImplementation(async () => {
      calls.push('cancel');
      return { ...ACCEPTED, orderId: 'o1' };
    });
    placePendingOrder.mockImplementation(async () => {
      calls.push('place');
      return ACCEPTED;
    });

    await svc.resizePendingOrder(order(), d('0.25'));

    // Placing first would briefly double the trader's exposure at the same
    // price — two live orders for one intent.
    expect(calls).toEqual(['cancel', 'place']);
  });

  it('carries price and bracket edits submitted alongside the size', async () => {
    const { svc, placePendingOrder } = service();

    await svc.resizePendingOrder(order(), d('0.25'), {
      price: d('1.0750'),
      stopLoss: d('1.0650'),
      takeProfit: null,
    });

    // One dialog submission can change several things. Replacing at the OLD
    // price would quietly undo an edit the trader watched themselves make.
    expect(placePendingOrder.mock.calls[0]![0]).toMatchObject({
      volumeLots: '0.25',
      price: '1.0750',
      stopLoss: '1.0650',
      takeProfit: null,
    });
  });
});

describe('resizePendingOrder — nothing is destroyed until it is safe', () => {
  it('refuses a volume below the symbol minimum without cancelling', async () => {
    const { svc, cancelOrder, placePendingOrder } = service();

    await expect(svc.resizePendingOrder(order(), d('0.001'))).rejects.toMatchObject({
      code: 'trade.resize-invalid-volume',
    });
    // The order the trader already had must survive a value the broker would
    // have refused anyway.
    expect(cancelOrder).not.toHaveBeenCalled();
    expect(placePendingOrder).not.toHaveBeenCalled();
  });

  it('refuses a volume off the symbol step without cancelling', async () => {
    const { svc, cancelOrder } = service();

    await expect(svc.resizePendingOrder(order(), d('0.125'))).rejects.toMatchObject({
      code: 'trade.resize-invalid-volume',
    });
    expect(cancelOrder).not.toHaveBeenCalled();
  });

  it('refuses an order that is no longer working', async () => {
    const { svc, cancelOrder } = service();

    // Filled between the dialog opening and the trader pressing Replace.
    await expect(
      svc.resizePendingOrder(order({ status: 'filled' }), d('0.25')),
    ).rejects.toMatchObject({ code: 'trade.resize-not-working' });
    expect(cancelOrder).not.toHaveBeenCalled();
  });

  it('refuses a market order', async () => {
    const { svc, cancelOrder } = service();
    await expect(
      svc.resizePendingOrder(order({ kind: 'market' }), d('0.25')),
    ).rejects.toMatchObject({ code: 'trade.resize-market' });
    expect(cancelOrder).not.toHaveBeenCalled();
  });

  it('refuses a resize to the size it already has', async () => {
    const { svc, cancelOrder } = service();
    await expect(svc.resizePendingOrder(order(), d('0.10'))).rejects.toMatchObject({
      code: 'trade.resize-unchanged',
    });
    expect(cancelOrder).not.toHaveBeenCalled();
  });

  it('still resizes when the symbol carries no volume limits', async () => {
    // Without the raw MT5 record there is nothing to check against, and
    // refusing every resize would be worse than letting the server decide.
    const { svc, placePendingOrder } = service({ symbol: undefined });
    await svc.resizePendingOrder(order(), d('0.25'));
    expect(placePendingOrder).toHaveBeenCalledOnce();
  });
});

describe('resizePendingOrder — when the cancel does not land', () => {
  it('does not place a replacement when the cancel is rejected', async () => {
    const { svc, cancelOrder, placePendingOrder } = service();
    cancelOrder.mockResolvedValue({ ...ACCEPTED, state: 'rejected' });

    await expect(svc.resizePendingOrder(order(), d('0.25'))).rejects.toMatchObject({
      code: 'trade.resize-cancel-failed',
    });
    expect(placePendingOrder).not.toHaveBeenCalled();
  });

  it('does not place a replacement when the cancel is UNDECIDED', async () => {
    const { svc, cancelOrder, placePendingOrder } = service();
    cancelOrder.mockResolvedValue({ ...ACCEPTED, state: 'unknown' });

    await expect(svc.resizePendingOrder(order(), d('0.25'))).rejects.toMatchObject({
      code: 'trade.resize-cancel-failed',
    });
    // The original may still be live. Placing here could leave two orders for
    // one intent — worse than a refused resize, and harder to notice.
    expect(placePendingOrder).not.toHaveBeenCalled();
  });
});

describe('resizePendingOrder — cancelled but not replaced', () => {
  it('raises its own error saying the order is gone', async () => {
    const { svc, placePendingOrder } = service();
    placePendingOrder.mockRejectedValue(new Error('Not enough money'));

    await expect(svc.resizePendingOrder(order(), d('0.25'))).rejects.toMatchObject({
      code: 'trade.resize-orphaned',
    });
  });

  it('names the order and says there is now nothing on the market', async () => {
    const { svc, placePendingOrder } = service();
    placePendingOrder.mockRejectedValue(new Error('Not enough money'));

    // This is the outcome a trader must never have to discover for themselves.
    await expect(svc.resizePendingOrder(order(), d('0.25'))).rejects.toThrow(
      /o1 was cancelled.*no order/s,
    );
  });

  it('carries everything a retry needs to put the order back', async () => {
    const { svc, placePendingOrder } = service();
    placePendingOrder.mockRejectedValue(new Error('Not enough money'));

    const failure = await svc.resizePendingOrder(order(), d('0.25')).catch((e: unknown) => e);

    expect((failure as { payload: unknown }).payload).toMatchObject({
      displaySymbol: 'EURUSD',
      side: 'buy',
      kind: 'limit',
      volumeLots: '0.25',
      price: '1.0800',
      stopLoss: '1.0700',
      takeProfit: '1.1000',
    });
  });
});

describe('modifyOrder still refuses a size change', () => {
  it('keeps the guard, so no caller can send a volume MT5 would drop', async () => {
    const modifyOrder = vi.fn();
    const svc = new TradingService({
      trading: { modifyOrder } as unknown as TradingApi,
      market: {} as MarketApi,
      getLogin: () => '1001',
      getSuffixPolicy: () => new SymbolSuffixPolicy('.'),
      getSymbol: () => symbol(),
      isReadOnly: () => false,
      onStateChanged: () => {},
    });

    // The resize path exists now, but `modifyOrder` is still reachable from
    // anywhere. It must keep refusing rather than quietly sending a size the
    // server will discard.
    await expect(svc.modifyOrder(order(), { volumeLots: d('0.25') })).rejects.toMatchObject({
      code: 'trade.no-volume-modify',
    });
    expect(modifyOrder).not.toHaveBeenCalled();
  });
});
