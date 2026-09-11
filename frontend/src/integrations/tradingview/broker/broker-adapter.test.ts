import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DecimalString } from '@/domain/common/decimal';
import type { TradingOrder, TradingSymbol } from '@/domain/common/models';
import { TradingService } from '@/domain/orders/trading-service';
import type { TradingApi } from '@/integrations/gateway/api/trading-api';
import type { MarketApi } from '@/integrations/gateway/api/market-api';
import { NO_SUFFIX_POLICY } from '@/integrations/gateway/mappers/symbol-suffix';
import {
  GatewayBrokerAdapter,
  orderBrackets,
  positionBrackets,
  toLibraryOrder,
  toLibraryPosition,
} from './broker-adapter';
import type {
  ActionMetaInfo,
  DefaultContextMenuActionsParams,
  IBrokerConnectionAdapterHost,
  PreOrder,
  TradeContext,
} from '../types';
import { useTradingStore } from '@/stores/trading-store';
import { useSessionStore } from '@/stores/session-store';
import { quoteStore } from '@/stores/quote-store';
import { useWorkspace } from '@/workspace/layout/workspace-store';
import {
  TV_CONNECTION_STATUS,
  TV_ORDER_STATUS,
  TV_ORDER_TYPE,
  TV_PARENT_TYPE,
  TV_SIDE,
} from '../types';

const d = (v: string) => v as DecimalString;

function symbol(overrides: Partial<TradingSymbol> = {}): TradingSymbol {
  return {
    name: 'XAUUSD.',
    displayName: 'XAUUSD',
    description: 'Gold vs US Dollar',
    type: 'Metals',
    exchange: 'Broker',
    digits: 2,
    pricescale: 100,
    minMove: 1,
    volumeMin: d('0.1'),
    volumeMax: d('50'),
    volumeStep: d('0.1'),
    contractSize: d('100'),
    tickSize: d('0.01'),
    tickValue: d('1'),
    currencyCode: 'USD',
    session: '24x5',
    timezone: 'Etc/UTC',
    supportedResolutions: ['1'],
    sector: null,
    industry: null,
    ...overrides,
  };
}

/** Minimal host double — the adapter only calls a few methods here. */
function fakeWatchedValue(initial: unknown) {
  let value = initial;
  return {
    value: () => value,
    setValue: vi.fn((next: unknown) => {
      value = next;
    }),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
  };
}

function fakeHost(): IBrokerConnectionAdapterHost {
  const quantities = new Map<string, number>();
  return {
    getSymbolMinTick: vi.fn().mockResolvedValue(0.00001),
    // Stateful, like the real host: what was set is what is read back.
    // A host that always answered 1 would look exactly like the library
    // restoring its own persisted value over ours, which is a case with its
    // own test below.
    getQty: vi
      .fn()
      .mockImplementation((symbol: string) => Promise.resolve(quantities.get(symbol) ?? 1)),
    setQty: vi.fn((symbol: string, value: number) => quantities.set(symbol, value)),
    equityUpdate: vi.fn(),
    orderUpdate: vi.fn(),
    positionUpdate: vi.fn(),
    showNotification: vi.fn(),
    currentAccountUpdate: vi.fn(),
    connectionStatusUpdate: vi.fn(),
    factory: {
      createWatchedValue: vi.fn(fakeWatchedValue),
      createDelegate: vi.fn(),
    },
  } as unknown as IBrokerConnectionAdapterHost;
}

function createAdapter(resolve: (s: string) => Promise<TradingSymbol | undefined>) {
  return new GatewayBrokerAdapter({
    host: fakeHost(),
    trading: {} as TradingService,
    resolveSymbol: resolve,
  });
}

describe('GatewayBrokerAdapter.symbolInfo', () => {
  it('reports the instrument REAL volume limits, not defaults', async () => {
    // The chart's own order ticket validates against these. Inventing them
    // would let it accept a volume the trading server rejects.
    const adapter = createAdapter(async () => symbol());
    const info = await adapter.symbolInfo('XAUUSD');

    // `default` and `uiStep` are part of the contract, not extras: without a
    // default the library uses its own 1 — one LOT on a 0.1-step field, so a
    // one-click quick order goes in ten times the intended size.
    expect(info.qty).toEqual({ min: 0.1, max: 50, step: 0.1, default: 0.1, uiStep: 0.1 });
    expect(info.units).toBe('Lots');
    adapter.dispose();
  });

  it('derives pip size and pip value from the instrument tick data', async () => {
    const adapter = createAdapter(async () => symbol());
    const info = await adapter.symbolInfo('XAUUSD');

    // 2-digit quote → pip == tick == 0.01; pipValue = (pip / tick) * tickValue.
    expect(info.pipSize).toBeCloseTo(0.01, 10);
    expect(info.pipValue).toBeCloseTo(1, 10);
    adapter.dispose();
  });

  it('scales pip size for a 5-digit fractional-pip quote', async () => {
    const adapter = createAdapter(async () =>
      symbol({ digits: 5, tickSize: d('0.00001'), tickValue: d('1') }),
    );
    const info = await adapter.symbolInfo('EURUSD');

    // A 5-digit FX quote prices in fractional pips: one pip is ten ticks.
    expect(info.pipSize).toBeCloseTo(0.0001, 10);
    expect(info.pipValue).toBeCloseTo(10, 10);
    adapter.dispose();
  });

  it('uses the symbol tick size in preference to the host fallback', async () => {
    const adapter = createAdapter(async () => symbol());
    const info = await adapter.symbolInfo('XAUUSD');
    expect(info.minTick).toBeCloseTo(0.01, 10);
    adapter.dispose();
  });

  it('never reports a zero minTick, even when a zero tick size sneaks through', async () => {
    // Defense in depth behind the mapper: the library DIVIDES by minTick, so
    // a zero here is "[big.js] Division by zero" and a dead trading surface.
    const adapter = createAdapter(async () => symbol({ tickSize: d('0') }));
    const info = await adapter.symbolInfo('XAUUSD');

    // digits 2 → the MT5 point, 10^-2.
    expect(info.minTick).toBeCloseTo(0.01, 10);
    expect(info.minTick).toBeGreaterThan(0);
    expect(info.pipSize).toBeGreaterThan(0);
    adapter.dispose();
  });

  it('derives the point from digits when the gateway omits the tick size', async () => {
    const adapter = createAdapter(async () => symbol({ tickSize: null, digits: 5 }));
    const info = await adapter.symbolInfo('EURUSD');

    expect(info.minTick).toBeCloseTo(0.00001, 12);
    // 5-digit quote → fractional pips → pip is ten points.
    expect(info.pipSize).toBeCloseTo(0.0001, 12);
    adapter.dispose();
  });

  it('falls back without throwing when the symbol cannot be resolved', async () => {
    const adapter = createAdapter(async () => undefined);
    const info = await adapter.symbolInfo('UNKNOWN');

    // The server remains authoritative, so a permissive fallback surfaces the
    // server's own rejection rather than blocking a legitimate trade.
    expect(info.qty.min).toBeGreaterThan(0);
    expect(info.qty.step).toBeGreaterThan(0);
    expect(info.minTick).toBeGreaterThan(0);
    adapter.dispose();
  });

  it('survives a rejected symbol lookup', async () => {
    const adapter = createAdapter(async () => {
      throw new Error('gateway unavailable');
    });
    await expect(adapter.symbolInfo('EURUSD')).resolves.toBeDefined();
    adapter.dispose();
  });
});

describe('teardown', () => {
  it('exposes disconnect() for the library and tolerates repeat calls', () => {
    // The library calls this during teardown and logs "Failed to disconnect"
    // when it is missing. Our React cleanup also calls dispose(), so both
    // paths can run for the same adapter.
    const adapter = createAdapter(async () => symbol());

    expect(() => adapter.disconnect()).not.toThrow();
    expect(() => adapter.disconnect()).not.toThrow();
    expect(() => adapter.dispose()).not.toThrow();
  });
});

describe('connection safety', () => {
  it('reports an error and disables chart trading when any authoritative stream is stale', async () => {
    useSessionStore.setState({ readOnly: false });
    useTradingStore.setState((state) => ({
      accountFreshness: { ...state.accountFreshness, connection: 'connected' },
      positionsFreshness: { ...state.positionsFreshness, connection: 'stale' },
      ordersFreshness: { ...state.ordersFreshness, connection: 'connected' },
    }));
    const adapter = createAdapter(async () => symbol());

    expect(adapter.connectionStatus()).toBe(TV_CONNECTION_STATUS.Error);
    await expect(adapter.isTradable('EURUSD')).resolves.toBe(false);
    adapter.dispose();
  });

  it('enables chart trading only when every stream is connected and the account is writable', async () => {
    useSessionStore.setState({ readOnly: false });
    useTradingStore.setState((state) => ({
      accountFreshness: { ...state.accountFreshness, connection: 'connected' },
      positionsFreshness: { ...state.positionsFreshness, connection: 'connected' },
      ordersFreshness: { ...state.ordersFreshness, connection: 'connected' },
    }));
    const adapter = createAdapter(async () => symbol());

    expect(adapter.connectionStatus()).toBe(TV_CONNECTION_STATUS.Connected);
    await expect(adapter.isTradable('EURUSD')).resolves.toBe(true);
    useSessionStore.setState({ readOnly: true });
    await expect(adapter.isTradable('EURUSD')).resolves.toBe(false);
    adapter.dispose();
  });

  it('says WHY it is non-tradable, once per distinct cause, and never when healthy', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      useSessionStore.setState({ readOnly: false });
      useTradingStore.setState((state) => ({
        accountFreshness: { ...state.accountFreshness, connection: 'connected' },
        positionsFreshness: { ...state.positionsFreshness, connection: 'connected' },
        ordersFreshness: { ...state.ordersFreshness, connection: 'connected' },
      }));
      const adapter = createAdapter(async () => symbol());

      // Healthy: the library polls this constantly, and silence must mean
      // every gate is open — otherwise real warnings drown.
      await adapter.isTradable('EURUSD');
      expect(warn).not.toHaveBeenCalled();

      // Degraded: the inputs are reported once, not per poll.
      useTradingStore.setState((state) => ({
        positionsFreshness: { ...state.positionsFreshness, connection: 'stale' },
      }));
      await adapter.isTradable('EURUSD');
      await adapter.isTradable('EURUSD');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        '[tradingview]',
        'TradingView reports non-tradable',
        expect.objectContaining({ readOnly: false, connection: 'stale' }),
      );

      // Recovery then re-degradation reports again — a NEW incident.
      useTradingStore.setState((state) => ({
        positionsFreshness: { ...state.positionsFreshness, connection: 'connected' },
      }));
      await adapter.isTradable('EURUSD');
      useTradingStore.setState((state) => ({
        positionsFreshness: { ...state.positionsFreshness, connection: 'stale' },
      }));
      await adapter.isTradable('EURUSD');
      expect(warn).toHaveBeenCalledTimes(2);
      adapter.dispose();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('account switch and connection lifecycle', () => {
  /** A minimal domain position, shaped like the store's. */
  function position(id: string, displaySymbol: string) {
    return {
      id,
      symbol: `${displaySymbol}.`,
      displaySymbol,
      side: 'buy' as const,
      volume: d('1'),
      openPrice: d('1.1'),
      currentPrice: null,
      stopLoss: null,
      takeProfit: null,
      profit: null,
      swap: null,
      commission: null,
      openTime: null,
    };
  }

  const fresh = (connection: string) => ({ updatedAt: 1, connection }) as never;

  it('replays a snapshot that arrived before the broker EVER connected (cold boot)', () => {
    // The 2026-08-24 empty-chart regression report hypothesized that data
    // arriving in the mount-before-connect window is dropped permanently
    // ("chart update held: broker not connected" with no replay). This pins
    // the actual contract for the COLD-BOOT window the fast boot opened: the
    // adapter binds while every stream is still idle, the first snapshot
    // lands pre-connect, and the connect transition must flush it.
    useSessionStore.setState({ readOnly: false, activeLogin: '1001' });
    useTradingStore.setState({
      generation: 1 as never,
      positions: [],
      positionsById: new Map(),
      orders: [],
      ordersById: new Map(),
      account: null,
      accountFreshness: fresh('idle'),
      positionsFreshness: fresh('idle'),
      ordersFreshness: fresh('idle'),
    } as never);

    const host = fakeHost() as IBrokerConnectionAdapterHost & {
      positionUpdate: ReturnType<typeof vi.fn>;
      connectionStatusUpdate: ReturnType<typeof vi.fn>;
    };
    const adapter = new GatewayBrokerAdapter({
      host,
      trading: {} as TradingService,
      resolveSymbol: async () => symbol(),
    });

    // Bars-race window: the position snapshot beats the streams' connect.
    useTradingStore.setState({ positions: [position('p1', 'EURUSD')] as never } as never);
    expect(host.positionUpdate).not.toHaveBeenCalled(); // held, not pushed blind

    // Streams connect. The held snapshot must be REPLAYED, not forgotten.
    useTradingStore.setState({
      accountFreshness: fresh('connected'),
      positionsFreshness: fresh('connected'),
      ordersFreshness: fresh('connected'),
    } as never);

    expect(host.connectionStatusUpdate).toHaveBeenLastCalledWith(TV_CONNECTION_STATUS.Connected);
    expect(host.positionUpdate).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1' }));
    adapter.dispose();
  });

  it('publishes the new account’s open positions only after the library is told Connected', () => {
    // Connected on the old account, one open position already mirrored.
    useSessionStore.setState({ readOnly: false, activeLogin: '1001' });
    useTradingStore.setState({
      generation: 1 as never,
      positions: [position('p1', 'EURUSD')] as never,
      positionsById: new Map() as never,
      orders: [],
      ordersById: new Map(),
      account: null,
      accountFreshness: fresh('connected'),
      positionsFreshness: fresh('connected'),
      ordersFreshness: fresh('connected'),
    } as never);

    const host = fakeHost() as IBrokerConnectionAdapterHost & {
      positionUpdate: ReturnType<typeof vi.fn>;
      currentAccountUpdate: ReturnType<typeof vi.fn>;
      connectionStatusUpdate: ReturnType<typeof vi.fn>;
    };
    const adapter = new GatewayBrokerAdapter({
      host,
      trading: {} as TradingService,
      resolveSymbol: async () => symbol(),
    });

    // The switch: exactly what resetForAccountSwitch does — one atomic update
    // advancing the generation, clearing data, and dropping every stream to
    // idle while the new account's sockets come up.
    useSessionStore.setState({ activeLogin: '1002' });
    useTradingStore.setState({
      generation: 2 as never,
      positions: [],
      positionsById: new Map(),
      orders: [],
      ordersById: new Map(),
      account: null,
      accountFreshness: fresh('idle'),
      positionsFreshness: fresh('idle'),
      ordersFreshness: fresh('idle'),
    } as never);

    // The library is told the account changed and the broker is reconnecting —
    // and no diff against the OLD account's snapshot leaks through.
    expect(host.currentAccountUpdate).toHaveBeenCalledTimes(1);
    expect(host.connectionStatusUpdate).toHaveBeenCalledWith(TV_CONNECTION_STATUS.Connecting);
    expect(host.positionUpdate).not.toHaveBeenCalled();

    // The new account ALREADY HAS an open position, and its snapshot lands
    // while the streams are still reconnecting. This is the exact sequence
    // that used to fail the library's "Broker is not connected" assertion —
    // the push must be held.
    useTradingStore.setState({ positions: [position('p2', 'XAUUSD')] as never } as never);
    expect(host.positionUpdate).not.toHaveBeenCalled();

    // Streams recover: Connected is pushed FIRST, then the held snapshot.
    useTradingStore.setState({
      accountFreshness: fresh('connected'),
      positionsFreshness: fresh('connected'),
      ordersFreshness: fresh('connected'),
    } as never);

    expect(host.connectionStatusUpdate).toHaveBeenLastCalledWith(TV_CONNECTION_STATUS.Connected);
    expect(host.positionUpdate).toHaveBeenCalledWith(expect.objectContaining({ id: 'p2' }));
    // Never a stale qty-0 close fabricated from the old account's position.
    expect(host.positionUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: 'p1', qty: 0 }),
    );

    // Status reached the library strictly before the data did.
    const statusOrder = host.connectionStatusUpdate.mock.invocationCallOrder.at(-1)!;
    const dataOrder = host.positionUpdate.mock.invocationCallOrder[0]!;
    expect(statusOrder).toBeLessThan(dataOrder);
    adapter.dispose();
  });

  it('keeps mirroring ordinary position changes while connected', () => {
    useSessionStore.setState({ readOnly: false, activeLogin: '1001' });
    useTradingStore.setState({
      generation: 1 as never,
      positions: [],
      positionsById: new Map(),
      orders: [],
      ordersById: new Map(),
      account: null,
      accountFreshness: fresh('connected'),
      positionsFreshness: fresh('connected'),
      ordersFreshness: fresh('connected'),
    } as never);

    const host = fakeHost() as IBrokerConnectionAdapterHost & {
      positionUpdate: ReturnType<typeof vi.fn>;
    };
    const adapter = new GatewayBrokerAdapter({
      host,
      trading: {} as TradingService,
      resolveSymbol: async () => symbol(),
    });

    useTradingStore.setState({ positions: [position('p1', 'EURUSD')] as never } as never);
    expect(host.positionUpdate).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1' }));

    // A close (absence from the snapshot) is mirrored as qty 0.
    useTradingStore.setState({ positions: [] as never } as never);
    expect(host.positionUpdate).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'p1', qty: 0 }),
    );
    adapter.dispose();
  });
});

describe('GatewayBrokerAdapter — an undecided submission is never silent', () => {
  /**
   * The library treats a resolved promise as success and has no notion of an
   * unknown outcome. A chart trade whose result the server never confirmed
   * therefore looked exactly like one that worked — and a trader who sees
   * nothing happen places it again.
   */
  function adapterWith(trading: Partial<TradingService>, onNotification: ReturnType<typeof vi.fn>) {
    useSessionStore.setState({ readOnly: false });
    return new GatewayBrokerAdapter({
      host: fakeHost(),
      trading: trading as TradingService,
      resolveSymbol: async () => symbol(),
      onNotification,
    });
  }

  const unknown = {
    state: 'unknown' as const,
    orderId: null,
    retcode: null,
    message: 'Outcome unknown — check Positions.',
    requestId: 'req-1',
  };

  it('warns when a chart order comes back undecided', async () => {
    const onNotification = vi.fn();
    const adapter = adapterWith({ openPosition: async () => unknown }, onNotification);

    const result = await adapter.placeOrder({
      symbol: 'EURUSD',
      side: 1,
      type: 2,
      qty: 1,
      limitPrice: 1.085,
    } as unknown as Parameters<GatewayBrokerAdapter['placeOrder']>[0]);

    expect(result).toEqual({});
    expect(onNotification).toHaveBeenCalledWith(
      'Order outcome unknown',
      'Outcome unknown — check Positions.',
      true,
    );
    adapter.dispose();
  });

  it('warns when a close comes back undecided', async () => {
    const onNotification = vi.fn();
    useTradingStore.setState({
      positionsById: new Map([['p1', { id: 'p1', displaySymbol: 'EURUSD' }]]),
    } as never);
    const adapter = adapterWith({ closePosition: async () => unknown }, onNotification);

    await adapter.closePosition('p1');

    expect(onNotification).toHaveBeenCalledWith(
      'Close outcome unknown',
      'Outcome unknown — check Positions.',
      true,
    );
    adapter.dispose();
  });

  it('announces an accepted chart order as a SUCCESS, not an error', async () => {
    // Silence on success was itself a defect: "bracket edited" with no
    // feedback is indistinguishable from a dropped request, and QA rightly
    // expects a confirmation toast.
    const onNotification = vi.fn();
    const adapter = adapterWith(
      {
        openPosition: async () => ({
          state: 'accepted' as const,
          orderId: '55' as never,
          retcode: '10009',
          message: null,
          requestId: 'req-2',
        }),
      },
      onNotification,
    );

    const result = await adapter.placeOrder({
      symbol: 'EURUSD',
      side: 1,
      type: 2,
      qty: 1,
      limitPrice: 1.085,
    } as unknown as Parameters<GatewayBrokerAdapter['placeOrder']>[0]);

    expect(result).toEqual({ orderId: '55' });
    expect(onNotification).toHaveBeenCalledWith('Order placed', '', false);
    adapter.dispose();
  });

  it('announces an accepted bracket edit as a SUCCESS', async () => {
    const onNotification = vi.fn();
    useTradingStore.setState({
      positionsById: new Map([
        ['p1', { id: 'p1', displaySymbol: 'EURUSD', symbol: 'EURUSD.', side: 'buy' }],
      ]),
    } as never);
    const adapter = adapterWith(
      {
        modifyPositionBrackets: async () => ({
          state: 'accepted' as const,
          orderId: null,
          retcode: '10009',
          message: null,
          requestId: 'req-3',
        }),
      },
      onNotification,
    );

    await adapter.editPositionBrackets('p1', { stopLoss: 1.05, takeProfit: 1.12 });

    expect(onNotification).toHaveBeenCalledWith('Position brackets updated', '', false);
    adapter.dispose();
  });
});

describe('accountManagerInfo — required Broker API contract', () => {
  it('builds without throwing and carries a live summary row', () => {
    // The library constructs the Account Manager whenever trading is enabled
    // and throws a TypeError on every boot and account switch when this
    // method is missing — the one console error a healthy session produced.
    const adapter = new GatewayBrokerAdapter({
      host: fakeHost(),
      trading: {} as TradingService,
      resolveSymbol: async () => symbol(),
    });

    const info = adapter.accountManagerInfo();

    expect(info.accountTitle).toBe('OpoTrade');
    expect(info.summary.map((f) => f.text)).toEqual([
      'Balance',
      'Equity',
      'P/L',
      'Margin',
      'Free margin',
    ]);
    for (const field of info.summary) expect(field.wValue).toBeDefined();
    expect(info.orderColumns.length).toBeGreaterThan(0);
    expect(info.positionColumns?.some((c) => c.id === 'stopLoss')).toBe(true);
    expect(info.pages).toEqual([]);
    // Stable across calls: the library may ask more than once, and fresh
    // watched values each time would orphan the ones it subscribed to.
    expect(adapter.accountManagerInfo().summary[0]!.wValue).toBe(info.summary[0]!.wValue);
    adapter.dispose();
  });

  it('feeds the summary from the account snapshot on store ticks', () => {
    const adapter = new GatewayBrokerAdapter({
      host: fakeHost(),
      trading: {} as TradingService,
      resolveSymbol: async () => symbol(),
    });
    const info = adapter.accountManagerInfo();

    useTradingStore.setState({
      account: {
        balance: '1000.50',
        equity: '990.25',
        profit: '-10.25',
        margin: '120.00',
        marginFree: '870.25',
      },
    } as never);

    expect(info.summary[0]!.wValue.value()).toBe(1000.5);
    expect(info.summary[1]!.wValue.value()).toBe(990.25);
    expect(info.summary[2]!.wValue.value()).toBe(-10.25);
    expect(info.summary[3]!.wValue.value()).toBe(120);
    expect(info.summary[4]!.wValue.value()).toBe(870.25);
    adapter.dispose();
  });
});

describe('leverage', () => {
  it('is refused outright when the broker does not offer it', async () => {
    // No `leverage` dep means the gateway did not report the capability. The
    // library must get a rejection, not a fabricated range it can write back.
    const adapter = createAdapter(async () => symbol());
    await expect(adapter.leverageInfo()).rejects.toThrow();
    await expect(adapter.setLeverage({ leverage: 500 })).rejects.toThrow();
    adapter.dispose();
  });

  it('describes a step that lands on every value the broker offers', async () => {
    // The library models leverage as a range; brokers publish a list. A step
    // that did not divide every gap would let the dialog produce a number the
    // gateway refuses.
    const get = vi.fn().mockResolvedValue({
      login: 1001,
      leverage: 100,
      min: 25,
      max: 500,
      choices: [25, 50, 100, 200, 500],
    });
    const adapter = new GatewayBrokerAdapter({
      host: fakeHost(),
      trading: {} as TradingService,
      resolveSymbol: async () => symbol(),
      leverage: { get, set: vi.fn() },
    });

    const info = await adapter.leverageInfo();
    expect(info).toMatchObject({ leverage: 100, min: 25, max: 500, step: 25 });
    for (const choice of [25, 50, 100, 200, 500]) {
      expect((choice - info.min) % info.step).toBe(0);
    }
    adapter.dispose();
  });

  it('previews without writing, and refuses a value not on offer', async () => {
    const set = vi.fn();
    const adapter = new GatewayBrokerAdapter({
      host: fakeHost(),
      trading: {} as TradingService,
      resolveSymbol: async () => symbol(),
      leverage: {
        get: vi.fn().mockResolvedValue({
          login: 1001,
          leverage: 100,
          min: 100,
          max: 200,
          choices: [100, 200],
        }),
        set,
      },
    });

    expect(await adapter.previewLeverage({ leverage: 150 })).toMatchObject({
      errors: expect.any(Array),
    });
    expect(await adapter.previewLeverage({ leverage: 200 })).not.toHaveProperty('errors');
    // A preview moves a control; it must never touch the account.
    expect(set).not.toHaveBeenCalled();
    adapter.dispose();
  });
});

describe('chartContextMenuActions', () => {
  it('delegates to the host defaults instead of removing chart trading', async () => {
    // Returning [] is documented to remove the Trade button and every trading
    // action from the chart context menu — the exact regression under test.
    const defaults = [{ text: 'Buy EURUSD' } as unknown as ActionMetaInfo];
    // The chart and the application agree, which is the precondition for the
    // menu being offered at all (see the lag case below).
    useWorkspace.getState().setActiveSymbol('EURUSD');
    const host = fakeHost();
    (host as unknown as { defaultContextMenuActions: unknown }).defaultContextMenuActions = vi
      .fn()
      .mockResolvedValue(defaults);

    const adapter = new GatewayBrokerAdapter({
      host,
      trading: {} as TradingService,
      resolveSymbol: async () => symbol(),
    });

    const context: TradeContext = {
      symbol: 'EURUSD',
      displaySymbol: 'EURUSD',
      value: 1.08543,
      formattedValue: '1.08543',
      last: 1.0855,
    };
    const options: DefaultContextMenuActionsParams = {};

    const actions = await adapter.chartContextMenuActions(context, options);

    expect(actions).toBe(defaults);
    expect(actions).not.toHaveLength(0);

    const hostMock = (host as unknown as { defaultContextMenuActions: ReturnType<typeof vi.fn> })
      .defaultContextMenuActions;
    expect(hostMock).toHaveBeenCalledTimes(1);
    // The SAME context object goes through untouched: `value` is the chart
    // price where the menu was opened, and it must survive to placeOrder.
    expect(hostMock).toHaveBeenCalledWith(context, options);
    expect((hostMock.mock.calls[0]![0] as TradeContext).value).toBe(1.08543);
    adapter.dispose();
  });

  it('withholds trade actions while the chart symbol lags the application', async () => {
    // Switching symbol swaps the series asynchronously. Until it lands, the
    // panels name the new instrument while the chart, its price scale and this
    // menu still describe the old one — and with instant placement that gap is
    // one click away from a filled order on the symbol nobody is looking at.
    useWorkspace.getState().setActiveSymbol('EURUSD');

    const host = fakeHost();
    const defaults = [{ text: 'Buy USDJPY' } as unknown as ActionMetaInfo];
    (host as unknown as { defaultContextMenuActions: unknown }).defaultContextMenuActions = vi
      .fn()
      .mockResolvedValue(defaults);

    const adapter = new GatewayBrokerAdapter({
      host,
      trading: {} as TradingService,
      resolveSymbol: async () => symbol(),
    });

    const stale: TradeContext = {
      symbol: 'USDJPY',
      displaySymbol: 'USDJPY',
      value: 158.237,
      formattedValue: '158.237',
      last: 158.24,
    };

    // A disabled, self-explaining line — not an empty array. Nothing at all
    // reads as a broken right-click, and takes the menu's non-trading entries
    // down with it.
    const withheld = await adapter.chartContextMenuActions(stale, {});
    expect(withheld).toHaveLength(1);
    expect(withheld[0]).toMatchObject({ enabled: false, text: expect.stringContaining('EURUSD') });
    expect(
      (host as unknown as { defaultContextMenuActions: ReturnType<typeof vi.fn> })
        .defaultContextMenuActions,
    ).not.toHaveBeenCalled();

    // Once the chart catches up the menu returns in full.
    const caughtUp: TradeContext = { ...stale, symbol: 'EURUSD', displaySymbol: 'EURUSD' };
    expect(await adapter.chartContextMenuActions(caughtUp, {})).toBe(defaults);
    adapter.dispose();
  });
});

describe('placeOrder price mapping and safety', () => {
  const accepted = {
    state: 'accepted' as const,
    orderId: '77' as never,
    retcode: '10009',
    message: null,
    requestId: 'req-t',
  };

  beforeEach(() => {
    useSessionStore.setState({
      readOnly: false,
      activeLogin: '1001',
      suffixPolicy: NO_SUFFIX_POLICY,
    });
  });

  function marketAdapter(trading: Partial<TradingService>) {
    return new GatewayBrokerAdapter({
      host: fakeHost(),
      trading: trading as TradingService,
      resolveSymbol: async () => symbol({ digits: 5, tickSize: d('0.00001') }),
    });
  }

  function pre(overrides: Partial<PreOrder>): PreOrder {
    return {
      symbol: 'EURUSD',
      side: TV_SIDE.Buy,
      type: TV_ORDER_TYPE.Market,
      qty: 0.1,
      ...overrides,
    } as PreOrder;
  }

  it('sends market buys at the ask and market sells at the bid', async () => {
    quoteStore.apply({
      symbol: 'EURUSD',
      bid: d('1.10000'),
      ask: d('1.10020'),
      last: d('1.10010'),
      volume: null,
      receivedAt: Date.now(),
      brokerTime: null,
    });

    const openPosition = vi.fn().mockResolvedValue(accepted);
    const adapter = marketAdapter({ openPosition });

    // The broker quote passes through as-is: the ASK for a buy, the BID for a
    // sell, never the reverse and never `last`.
    await adapter.placeOrder(pre({ side: TV_SIDE.Buy }));
    expect(openPosition).toHaveBeenLastCalledWith(
      expect.objectContaining({ side: 'buy', price: '1.10020' }),
    );

    await adapter.placeOrder(pre({ side: TV_SIDE.Sell }));
    expect(openPosition).toHaveBeenLastCalledWith(
      expect.objectContaining({ side: 'sell', price: '1.10000' }),
    );
    adapter.dispose();
  });

  it('sends a limit order at its limitPrice and a stop at its stopPrice', async () => {
    const placePendingOrder = vi.fn().mockResolvedValue(accepted);
    const adapter = marketAdapter({ placePendingOrder });

    // Prices come back formatted to the instrument's 5 digits.
    await adapter.placeOrder(pre({ type: TV_ORDER_TYPE.Limit, limitPrice: 1.0845 }));
    expect(placePendingOrder).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: 'limit', price: '1.08450' }),
    );

    await adapter.placeOrder(pre({ type: TV_ORDER_TYPE.Stop, stopPrice: 1.115 }));
    expect(placePendingOrder).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: 'stop', price: '1.11500' }),
    );
    adapter.dispose();
  });

  it('snaps a pending price onto the instrument tick grid and digits', async () => {
    const placePendingOrder = vi.fn().mockResolvedValue(accepted);
    // XAUUSD: tick 0.01, 2 digits. A raw chart coordinate has far more
    // precision than the instrument trades in.
    const adapter = new GatewayBrokerAdapter({
      host: fakeHost(),
      trading: { placePendingOrder } as unknown as TradingService,
      resolveSymbol: async () => symbol(),
    });

    await adapter.placeOrder(
      pre({ symbol: 'XAUUSD', type: TV_ORDER_TYPE.Limit, limitPrice: 2450.12734 }),
    );
    expect(placePendingOrder).toHaveBeenLastCalledWith(
      expect.objectContaining({ price: '2450.13' }),
    );
    adapter.dispose();
  });

  it.each([
    ['zero', 0],
    ['negative', -1.08],
    ['NaN', Number.NaN],
    ['infinite', Number.POSITIVE_INFINITY],
    ['missing', undefined],
  ])('refuses a pending order whose price is %s', async (_label, bad) => {
    const placePendingOrder = vi.fn();
    const adapter = marketAdapter({ placePendingOrder });

    await expect(
      adapter.placeOrder(pre({ type: TV_ORDER_TYPE.Limit, limitPrice: bad })),
    ).rejects.toMatchObject({ code: 'trade.no-price' });
    expect(placePendingOrder).not.toHaveBeenCalled();
    adapter.dispose();
  });

  it('refuses a stop-limit order rather than misfiling it as a stop', async () => {
    const placePendingOrder = vi.fn();
    const adapter = marketAdapter({ placePendingOrder });

    await expect(
      adapter.placeOrder(pre({ type: TV_ORDER_TYPE.StopLimit, limitPrice: 1.08, stopPrice: 1.09 })),
    ).rejects.toMatchObject({ code: 'trade.unsupported-type' });
    expect(placePendingOrder).not.toHaveBeenCalled();
    adapter.dispose();
  });

  it('joins a duplicate in-flight submission instead of sending it twice', async () => {
    let resolveTrade: (v: typeof accepted) => void = () => {};
    const placePendingOrder = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveTrade = resolve as never;
        }),
    );
    const adapter = marketAdapter({ placePendingOrder });
    const order = pre({ type: TV_ORDER_TYPE.Limit, limitPrice: 1.0845 });

    // The library delivering one user action twice (double-fired callback,
    // instant-mode double-click) must not become two broker orders.
    const first = adapter.placeOrder(order);
    const second = adapter.placeOrder({ ...order });
    // Price normalisation resolves the symbol first; wait for the request to
    // actually reach the transport before letting it settle.
    await vi.waitFor(() => expect(placePendingOrder).toHaveBeenCalledTimes(1));
    resolveTrade(accepted);
    const [a, b] = await Promise.all([first, second]);

    expect(placePendingOrder).toHaveBeenCalledTimes(1);
    expect(a).toEqual({ orderId: '77' });
    expect(b).toEqual({ orderId: '77' });

    // A DELIBERATE repeat after settlement is a new order, not a duplicate.
    placePendingOrder.mockResolvedValue(accepted);
    await adapter.placeOrder({ ...order });
    expect(placePendingOrder).toHaveBeenCalledTimes(2);
    adapter.dispose();
  });

  it('never retries a submission whose outcome is unknown', async () => {
    const openPosition = vi.fn().mockResolvedValue({
      state: 'unknown' as const,
      orderId: null,
      retcode: null,
      message: 'Outcome unknown.',
      requestId: 'req-u',
    });
    quoteStore.apply({
      symbol: 'EURUSD',
      bid: d('1.1'),
      ask: d('1.1002'),
      last: d('1.1001'),
      volume: null,
      receivedAt: Date.now(),
      brokerTime: null,
    });
    const adapter = marketAdapter({ openPosition });

    await adapter.placeOrder(pre({ side: TV_SIDE.Buy }));
    expect(openPosition).toHaveBeenCalledTimes(1);
    adapter.dispose();
  });

  it('never retries a submission that failed with a network-shaped error', async () => {
    const openPosition = vi.fn().mockRejectedValue(new Error('timeout'));
    quoteStore.apply({
      symbol: 'EURUSD',
      bid: d('1.1'),
      ask: d('1.1002'),
      last: d('1.1001'),
      volume: null,
      receivedAt: Date.now(),
      brokerTime: null,
    });
    const adapter = marketAdapter({ openPosition });

    await expect(adapter.placeOrder(pre({ side: TV_SIDE.Buy }))).rejects.toThrow();
    expect(openPosition).toHaveBeenCalledTimes(1);
    adapter.dispose();
  });

  it('refuses to submit for a read-only account before any request is made', async () => {
    useSessionStore.setState({ readOnly: true });

    // A REAL TradingService wired to a mock transport: read-only is enforced
    // in the service so the Broker API path cannot bypass it, and the
    // transport must never be reached.
    const transport = { openPosition: vi.fn(), placePendingOrder: vi.fn() };
    const service = new TradingService({
      trading: transport as unknown as TradingApi,
      market: {} as MarketApi,
      getLogin: () => '1001',
      getSuffixPolicy: () => NO_SUFFIX_POLICY,
      getSymbol: () => symbol(),
      isReadOnly: () => useSessionStore.getState().readOnly,
      onStateChanged: () => {},
    });
    const adapter = new GatewayBrokerAdapter({
      host: fakeHost(),
      trading: service,
      resolveSymbol: async () => symbol(),
    });

    await expect(
      adapter.placeOrder(pre({ type: TV_ORDER_TYPE.Limit, limitPrice: 1.0845 })),
    ).rejects.toMatchObject({ code: 'trade.read-only' });
    expect(transport.openPosition).not.toHaveBeenCalled();
    expect(transport.placePendingOrder).not.toHaveBeenCalled();
    adapter.dispose();
  });
});

describe('bracket keys are always explicit', () => {
  // The library's cache replaces the stored object wholesale, but nothing in
  // the pipeline may be left to infer that an ABSENT key means "cleared".
  // A cleared bracket must arrive as an explicit undefined so every consumer
  // — bracket lines, Account Manager cells — sees the deletion.
  it('emits stopLoss/takeProfit as undefined when a position bracket is cleared', () => {
    const position = {
      id: 'p1',
      displaySymbol: 'EURUSD',
      volume: '0.10' as DecimalString,
      side: 'buy' as const,
      openPrice: '1.1000' as DecimalString,
      profit: '5.00' as DecimalString,
      stopLoss: null,
      takeProfit: null,
    };
    const mapped = toLibraryPosition(position as never);

    expect('stopLoss' in mapped).toBe(true);
    expect('takeProfit' in mapped).toBe(true);
    expect(mapped.stopLoss).toBeUndefined();
    expect(mapped.takeProfit).toBeUndefined();
    expect(mapped.profit).toBe(5);
  });

  it('emits real numbers when brackets are set', () => {
    const mapped = toLibraryPosition({
      id: 'p1',
      displaySymbol: 'EURUSD',
      volume: '0.10',
      side: 'sell',
      openPrice: '1.1000',
      profit: null,
      stopLoss: '1.1200',
      takeProfit: '1.0800',
    } as never);

    expect(mapped.stopLoss).toBe(1.12);
    expect(mapped.takeProfit).toBe(1.08);
  });

  it('does the same for orders', () => {
    const mapped = toLibraryOrder({
      id: 'o1',
      displaySymbol: 'EURUSD',
      volume: '0.10',
      side: 'buy',
      kind: 'limit',
      status: 'working',
      price: '1.0900',
      stopLoss: null,
      takeProfit: null,
      filledVolume: null,
      createdAt: null,
    } as never);

    expect('stopLoss' in mapped).toBe(true);
    expect('takeProfit' in mapped).toBe(true);
    expect(mapped.stopLoss).toBeUndefined();
    expect(mapped.limitPrice).toBe(1.09);
  });
});

describe('editPositionBrackets — a resize can never be silently discarded', () => {
  // MT5 cannot resize a position via an SLTP modification, and the library's
  // Brackets carry no qty — but typings can lag reality. If a size change
  // ever reaches this handler, the whole edit is refused with an explanation,
  // never applied minus the resize.
  it('rejects a bracket edit that smuggles a different qty', async () => {
    const onNotification = vi.fn();
    useSessionStore.setState({ readOnly: false });
    useTradingStore.setState({
      positionsById: new Map([
        [
          'p1',
          { id: 'p1', displaySymbol: 'EURUSD', symbol: 'EURUSD.', side: 'buy', volume: '0.10' },
        ],
      ]),
    } as never);
    const modifyPositionBrackets = vi.fn();
    const adapter = new GatewayBrokerAdapter({
      host: fakeHost(),
      trading: { modifyPositionBrackets } as unknown as TradingService,
      resolveSymbol: async () => symbol(),
      onNotification,
    });

    await expect(
      adapter.editPositionBrackets('p1', { stopLoss: 1.05, qty: 0.5 } as never),
    ).rejects.toThrow(/partial close/);

    expect(modifyPositionBrackets).not.toHaveBeenCalled();
    expect(onNotification).toHaveBeenCalledWith(
      'Could not modify position',
      'Position size cannot be changed here — use a partial close.',
      true,
    );
    adapter.dispose();
  });

  it('accepts an unchanged qty riding along with a bracket edit', async () => {
    useSessionStore.setState({ readOnly: false });
    useTradingStore.setState({
      positionsById: new Map([
        [
          'p1',
          { id: 'p1', displaySymbol: 'EURUSD', symbol: 'EURUSD.', side: 'buy', volume: '0.10' },
        ],
      ]),
    } as never);
    const modifyPositionBrackets = vi.fn().mockResolvedValue({
      state: 'accepted',
      orderId: null,
      retcode: '10009',
      message: null,
      requestId: 'r1',
    });
    const adapter = new GatewayBrokerAdapter({
      host: fakeHost(),
      trading: { modifyPositionBrackets } as unknown as TradingService,
      resolveSymbol: async () => symbol(),
    });

    await adapter.editPositionBrackets('p1', { stopLoss: 1.05, qty: 0.1 } as never);

    expect(modifyPositionBrackets).toHaveBeenCalledTimes(1);
    adapter.dispose();
  });
});

describe('brackets are first-class cancellable orders', () => {
  const workingOrder = {
    id: 'o1',
    symbol: 'EURUSD.',
    displaySymbol: 'EURUSD',
    side: 'buy' as const,
    kind: 'limit' as const,
    status: 'working' as const,
    volume: d('0.10'),
    filledVolume: null,
    price: d('1.0900'),
    currentPrice: null,
    stopLoss: d('1.0800'),
    takeProfit: d('1.1100'),
    expiration: null,
    createdAt: null,
    comment: null,
  };

  const openPosition = {
    id: 'p1',
    symbol: 'EURUSD.',
    displaySymbol: 'EURUSD',
    side: 'sell' as const,
    volume: d('0.20'),
    openPrice: d('1.1000'),
    currentPrice: null,
    stopLoss: d('1.1200'),
    takeProfit: d('1.0800'),
    profit: null,
    swap: null,
    commission: null,
    openTime: null,
    comment: null,
  };

  function seed(orders: unknown[], positions: unknown[]) {
    useSessionStore.setState({ readOnly: false });
    useTradingStore.setState({
      orders: orders as never,
      ordersById: new Map(orders.map((o) => [(o as { id: string }).id, o])) as never,
      positions: positions as never,
      positionsById: new Map(positions.map((p) => [(p as { id: string }).id, p])) as never,
    } as never);
  }

  it('synthesises one bracket order per non-null leg, linked to its parent', async () => {
    // Without parentId + parentType the library renders NOTHING clickable:
    // no chart line with a close button, no Account Manager row, no Cancel.
    seed([workingOrder], []);
    const adapter = createAdapter(async () => symbol());

    const orders = await adapter.orders();
    const brackets = orders.filter((o) => 'parentId' in o);

    expect(brackets).toHaveLength(2);
    const sl = brackets.find((b) => b.id === 'o1-sl')!;
    const tp = brackets.find((b) => b.id === 'o1-tp')!;

    expect(sl.parentId).toBe('o1');
    expect(sl.parentType).toBe(TV_PARENT_TYPE.Order);
    expect(sl.type).toBe(TV_ORDER_TYPE.Stop);
    expect(sl.stopPrice).toBe(1.08);
    // Protective legs close the parent, so they sit on the opposite side.
    expect(sl.side).toBe(TV_SIDE.Sell);
    expect(sl.qty).toBe(0.1);
    // The parent is a PENDING order, so this leg cannot trigger yet — it arms
    // only if the parent fills. Working would claim it is already guarding a
    // live trade.
    expect(sl.status).toBe(TV_ORDER_STATUS.Inactive);

    expect(tp.type).toBe(TV_ORDER_TYPE.Limit);
    expect(tp.limitPrice).toBe(1.11);
    adapter.dispose();
  });

  it('keeps a POSITION bracket Working, because that one can trigger now', () => {
    // The distinction is the point: a stop on an open position is live, a stop
    // on an unfilled order is not, and reporting both as Working made an
    // unarmed protective level look like protection.
    const brackets = positionBrackets([
      {
        id: 'p1',
        displaySymbol: 'EURUSD',
        side: 'buy',
        volume: '0.1' as DecimalString,
        stopLoss: '1.08' as DecimalString,
        takeProfit: '1.11' as DecimalString,
      },
    ] as never);

    expect(brackets).toHaveLength(2);
    for (const bracket of brackets) {
      expect(bracket.parentType).toBe(TV_PARENT_TYPE.Position);
      expect(bracket.status).toBe(TV_ORDER_STATUS.Working);
    }
  });

  it('returns POSITION brackets through orders(), since positions() cannot carry orders', async () => {
    seed([], [openPosition]);
    const adapter = createAdapter(async () => symbol());

    const brackets = (await adapter.orders()).filter((o) => 'parentId' in o);

    expect(brackets.map((b) => b.id).sort()).toEqual(['p1-sl', 'p1-tp']);
    expect(brackets[0]!.parentType).toBe(TV_PARENT_TYPE.Position);
    // A short position is protected by buying.
    expect(brackets[0]!.side).toBe(TV_SIDE.Buy);
    adapter.dispose();
  });

  it('emits no bracket for a cleared leg', async () => {
    seed([{ ...workingOrder, takeProfit: null }], []);
    const adapter = createAdapter(async () => symbol());

    const brackets = (await adapter.orders()).filter((o) => 'parentId' in o);

    expect(brackets.map((b) => b.id)).toEqual(['o1-sl']);
    adapter.dispose();
  });

  it('does not double-count brackets once a pending order has filled', async () => {
    // The surviving SL/TP belong to the resulting POSITION. Emitting the filled
    // order's brackets too would draw two lines at one real stop.
    seed([{ ...workingOrder, status: 'filled' }], [openPosition]);
    const adapter = createAdapter(async () => symbol());

    const brackets = (await adapter.orders()).filter((o) => 'parentId' in o);

    expect(brackets.map((b) => b.id).sort()).toEqual(['p1-sl', 'p1-tp']);
    adapter.dispose();
  });

  /**
   * A REAL TradingService wired to a mock transport, so these assertions land
   * on the values that actually reach the gateway. Stubbing the service would
   * only prove the adapter called a method — the sibling-preservation rule
   * lives BELOW that call, and getting it wrong destroys a live stop.
   */
  function realService(transport: Record<string, unknown>) {
    return new TradingService({
      trading: transport as unknown as TradingApi,
      market: {} as MarketApi,
      getLogin: () => '1001',
      getSuffixPolicy: () => NO_SUFFIX_POLICY,
      getSymbol: () => symbol(),
      isReadOnly: () => false,
      onStateChanged: () => {},
    });
  }

  const accepted = {
    state: 'accepted',
    orderId: null,
    retcode: '10009',
    message: null,
    requestId: 'r1',
  };

  it('cancels an ORDER bracket by nulling only that leg, and says so', async () => {
    seed([workingOrder], []);
    const modifyOrder = vi.fn().mockResolvedValue(accepted);
    const cancelOrder = vi.fn();
    const onNotification = vi.fn();
    const adapter = new GatewayBrokerAdapter({
      host: fakeHost(),
      trading: realService({ modifyOrder, cancelOrder }),
      resolveSymbol: async () => symbol(),
      onNotification,
    });

    await adapter.cancelOrder('o1-sl');

    // Routed to a MODIFY on the parent — never to the gateway's cancel-pending
    // intent, which knows only real tickets.
    expect(cancelOrder).not.toHaveBeenCalled();
    expect(modifyOrder).toHaveBeenCalledTimes(1);
    // What reaches the gateway: this leg cleared, the sibling intact, and the
    // parent's own entry price and volume unchanged.
    expect(modifyOrder.mock.calls[0]![0]).toMatchObject({
      orderId: 'o1',
      stopLoss: null,
      takeProfit: '1.1100',
      price: '1.0900',
      volumeLots: '0.10',
    });
    // The user must be told the bracket was CANCELLED, not "order modified".
    expect(onNotification).toHaveBeenCalledWith('Stop loss canceled', '', false);
    adapter.dispose();
  });

  it('cancels a POSITION bracket by re-sending the sibling explicitly', async () => {
    // The position path has no "unchanged" sentinel — it sends BOTH levels every
    // time and null means clear. A sibling passed as undefined would reach the
    // wire as NaN and silently destroy a live stop, so this asserts the actual
    // transport payload rather than the service call.
    seed([], [openPosition]);
    const modifyPosition = vi.fn().mockResolvedValue(accepted);
    const onNotification = vi.fn();
    const adapter = new GatewayBrokerAdapter({
      host: fakeHost(),
      trading: realService({ modifyPosition }),
      resolveSymbol: async () => symbol(),
      onNotification,
    });

    await adapter.cancelOrder('p1-tp');

    expect(modifyPosition).toHaveBeenCalledTimes(1);
    expect(modifyPosition.mock.calls[0]![0]).toMatchObject({
      positionId: 'p1',
      stopLoss: '1.1200',
      takeProfit: null,
    });
    expect(onNotification).toHaveBeenCalledWith('Take profit canceled', '', false);
    adapter.dispose();
  });

  it('prefers a REAL order whose id happens to look synthetic', async () => {
    const oddlyNamed = { ...workingOrder, id: 'weird-tp' };
    seed([oddlyNamed], []);
    const cancelOrder = vi.fn().mockResolvedValue({
      state: 'accepted',
      orderId: null,
      retcode: '10009',
      message: null,
      requestId: 'r1',
    });
    const modifyOrder = vi.fn();
    const adapter = new GatewayBrokerAdapter({
      host: fakeHost(),
      trading: { cancelOrder, modifyOrder } as unknown as TradingService,
      resolveSymbol: async () => symbol(),
    });

    await adapter.cancelOrder('weird-tp');

    expect(cancelOrder).toHaveBeenCalledTimes(1);
    expect(modifyOrder).not.toHaveBeenCalled();
    adapter.dispose();
  });

  it('rejects a bracket id whose parent is gone, without reaching the gateway', async () => {
    seed([], []);
    const modifyOrder = vi.fn();
    const modifyPositionBrackets = vi.fn();
    const adapter = new GatewayBrokerAdapter({
      host: fakeHost(),
      trading: { modifyOrder, modifyPositionBrackets } as unknown as TradingService,
      resolveSymbol: async () => symbol(),
    });

    await expect(adapter.cancelOrder('ghost-sl')).rejects.toThrow(/not found/i);
    expect(modifyOrder).not.toHaveBeenCalled();
    expect(modifyPositionBrackets).not.toHaveBeenCalled();
    adapter.dispose();
  });

  it('moves a bracket leg when its chart line is dragged', async () => {
    // Brackets render as draggable lines now, so modifyOrder receives the
    // synthetic id. Before this it threw "Order not found."
    seed([workingOrder], []);
    const modifyOrder = vi.fn().mockResolvedValue(accepted);
    const adapter = new GatewayBrokerAdapter({
      host: fakeHost(),
      trading: realService({ modifyOrder }),
      resolveSymbol: async () => symbol(),
    });

    await adapter.modifyOrder({ id: 'o1-sl', stopPrice: 1.075 } as never);

    // The dragged leg takes the new level; the sibling and the entry survive.
    expect(modifyOrder.mock.calls[0]![0]).toMatchObject({
      orderId: 'o1',
      stopLoss: '1.075',
      takeProfit: '1.1100',
      price: '1.0900',
    });
    adapter.dispose();
  });

  it('announces a FILLED pending order as filled, and keeps its legs', () => {
    // MT5 gives the position the ticket of the order that opened it. The order
    // leaves the working set on fill, and treating every disappearance as a
    // cancellation told the trader their filled trade had been cancelled —
    // and said the same about both bracket legs, which had actually just
    // transferred onto the new position.
    seed([workingOrder], []);
    const host = fakeHost() as IBrokerConnectionAdapterHost & {
      orderUpdate: ReturnType<typeof vi.fn>;
    };
    const adapter = new GatewayBrokerAdapter({
      host,
      trading: {} as TradingService,
      resolveSymbol: async () => symbol(),
    });
    host.orderUpdate.mockClear();

    // The order fills: it leaves the working set and a position appears under
    // the SAME ticket, carrying the brackets across.
    useTradingStore.setState({
      orders: [] as never,
      positions: [
        {
          id: 'o1',
          displaySymbol: 'EURUSD',
          side: 'buy',
          volume: '0.1',
          openPrice: '1.1',
          stopLoss: '1.08',
          takeProfit: '1.11',
        },
      ] as never,
    } as never);

    const pushed = host.orderUpdate.mock.calls.map((c) => c[0] as { id: string; status: number });
    const parent = pushed.find((o) => o.id === 'o1');
    expect(parent?.status).toBe(TV_ORDER_STATUS.Filled);
    expect(parent?.status).not.toBe(TV_ORDER_STATUS.Canceled);

    // The legs keep their ids across the fill, so nothing may announce them as
    // cancelled; they are now the position's brackets.
    for (const legId of ['o1-sl', 'o1-tp']) {
      const cancels = pushed.filter((o) => o.id === legId && o.status === TV_ORDER_STATUS.Canceled);
      expect(cancels).toHaveLength(0);
    }
    adapter.dispose();
  });

  it('flips a removed bracket to Canceled on the push path and leaves the sibling alone', () => {
    // The library keeps what it was last told: an unannounced disappearance
    // leaves a dead SL line on the chart forever.
    seed([workingOrder], []);
    const host = fakeHost() as IBrokerConnectionAdapterHost & {
      orderUpdate: ReturnType<typeof vi.fn>;
    };
    const adapter = new GatewayBrokerAdapter({
      host,
      trading: {} as TradingService,
      resolveSymbol: async () => symbol(),
    });
    host.orderUpdate.mockClear();

    // The SL leg is cleared; the TP survives.
    useTradingStore.setState({
      orders: [{ ...workingOrder, stopLoss: null }] as never,
    } as never);

    const pushed = host.orderUpdate.mock.calls.map((c) => c[0]);
    const sl = pushed.find((o: { id: string }) => o.id === 'o1-sl');
    const tp = pushed.find((o: { id: string }) => o.id === 'o1-tp');

    expect(sl?.status).toBe(TV_ORDER_STATUS.Canceled);
    expect(tp?.status).toBe(TV_ORDER_STATUS.Inactive);
    expect(tp?.limitPrice).toBe(1.11);
    adapter.dispose();
  });
});

/**
 * Bracket legs are not stored orders: they are rebuilt from the parent on every
 * render, copying its size. So a resized parent carries both legs with it, and
 * nothing needs to propagate anything — which is exactly why no propagation
 * logic should ever be written here.
 */
describe('bracket legs follow the parent size', () => {
  const parent = (volume: string): TradingOrder =>
    ({
      id: '111154328',
      symbol: 'EURUSD.',
      displaySymbol: 'EURUSD',
      side: 'buy',
      kind: 'limit',
      status: 'working',
      volume,
      filledVolume: null,
      price: '1.16000',
      currentPrice: null,
      stopLoss: '1.15000',
      takeProfit: '1.18000',
      expiration: null,
      createdAt: null,
      comment: null,
    }) as unknown as TradingOrder;

  it('reports the parent size on both legs', () => {
    const legs = orderBrackets([parent('0.10')]);
    expect(legs.map((l) => l.qty)).toEqual([0.1, 0.1]);
  });

  it('reports the NEW size on both legs after a resize', () => {
    // The replacement order simply arrives with a different volume; the legs
    // are derived from it, so they cannot disagree with their parent.
    const legs = orderBrackets([parent('0.25')]);
    expect(legs).toHaveLength(2);
    expect(legs.map((l) => l.qty)).toEqual([0.25, 0.25]);
    expect(legs.map((l) => l.id)).toEqual(['111154328-sl', '111154328-tp']);
  });
});

/**
 * QA 2026-08-21: the `-sl` bracket leg rendered an empty Price cell. The
 * column declared `dataFields: ['limitPrice', 'stopPrice']`, which reads like a
 * fallback but is not — the standard price formatter uses only the first — so
 * every stop-priced order showed nothing at all.
 */
describe('Account Manager order columns', () => {
  const columns = () => {
    const adapter = createAdapter(async () => undefined);
    const info = adapter.accountManagerInfo() as unknown as {
      orderColumns: { id: string; label: string; dataFields: string[] }[];
    };
    return info.orderColumns;
  };

  it('gives a stop-priced order a column of its own', () => {
    const trigger = columns().find((c) => c.dataFields.includes('stopPrice'));
    expect(trigger).toBeDefined();
    expect(trigger!.label).toBe('Trigger');
  });

  it('does not leave a column silently reading only the first of two fields', () => {
    for (const column of columns()) {
      // One field per price column, so what renders is never a guess about
      // which of them the formatter happened to pick.
      if (column.dataFields.some((f) => /Price$/.test(f))) {
        expect(column.dataFields).toHaveLength(1);
      }
    }
  });
});

describe('formatters on the position-line render path', () => {
  // The library wraps formatter() in its own 10-second limit and rejects the
  // whole position render on "formatter not received". These must ALWAYS
  // resolve, gateway up or not (2026-08-24 chart wedge).
  it('formats prices with the symbol digits when the record resolves', async () => {
    const adapter = createAdapter(() => Promise.resolve(symbol({ digits: 3 })));
    const formatter = await adapter.formatter('XAUUSD', true);
    // Grouped, exactly like the library's default formatter renders the DOM
    // ladder and position lines.
    expect(formatter.format(4606.5)).toBe('4,606.500');
    expect(formatter.format(undefined)).toBe('');
    expect(formatter.format(Number.NaN)).toBe('');
  });

  it('still resolves — with fallback digits — when the symbol lookup HANGS', async () => {
    vi.useFakeTimers();
    try {
      const adapter = createAdapter(() => new Promise(() => {})); // never settles
      const pending = adapter.formatter('XAUUSD', true);
      await vi.advanceTimersByTimeAsync(3_100);
      const formatter = await pending;
      expect(formatter.format(1.168055)).toBe('1.16806');
      expect(formatter.format(2400.25)).toBe('2,400.25000');
    } finally {
      vi.useRealTimers();
    }
  });

  it('still resolves when the symbol lookup REJECTS', async () => {
    const adapter = createAdapter(() => Promise.reject(new Error('gateway down')));
    const formatter = await adapter.formatter('XAUUSD', true);
    expect(formatter.format(1.16806)).toBe('1.16806');
  });

  it('formats quantities to the volume step, with a sane fallback', async () => {
    const stepped = createAdapter(() => Promise.resolve(symbol({ volumeStep: d('0.1') })));
    expect((await stepped.quantityFormatter('XAUUSD')).format(1.5)).toBe('1.5');

    const unknown = createAdapter(() => Promise.reject(new Error('gateway down')));
    expect((await unknown.quantityFormatter('XAUUSD')).format(1.5)).toBe('1.50');
  });

  it('symbolInfo answers within the budget when the lookup hangs', async () => {
    vi.useFakeTimers();
    try {
      const adapter = createAdapter(() => new Promise(() => {}));
      const pending = adapter.symbolInfo('XAUUSD');
      // symbolInfo's budget is looser than the formatters' (the library
      // caches its first answer per symbol, so a premature fallback pins
      // wrong contract limits for the session).
      await vi.advanceTimersByTimeAsync(10_100);
      const info = await pending;
      // The fallback contract limits — degraded, but delivered in time.
      expect(info.qty.min).toBe(0.01);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('removal pushes are reinforced', () => {
  function position(id: string, displaySymbol: string) {
    return {
      id,
      symbol: `${displaySymbol}.`,
      displaySymbol,
      side: 'buy' as const,
      volume: d('1'),
      openPrice: d('1.1'),
      currentPrice: null,
      stopLoss: null,
      takeProfit: null,
      profit: null,
      swap: null,
      commission: null,
      openTime: null,
    };
  }
  const fresh = (connection: string) => ({ updatedAt: 1, connection }) as never;

  // The library's object cache swallows exactly one push after its own
  // positions()/orders() pull (`_isObjectsRequestActual`). Updates survive —
  // they repeat every tick — but a close was pushed ONCE, and one swallowed
  // close left the position line on the chart until reload (Issue 1,
  // 2026-08-24). The removal must repeat after the flag has been consumed.
  it('re-pushes a position close so a swallowed first push cannot orphan the line', async () => {
    vi.useFakeTimers();
    try {
      useSessionStore.setState({ readOnly: false, activeLogin: '1001' });
      useTradingStore.setState({
        generation: 1 as never,
        positions: [position('p1', 'EURUSD')] as never,
        positionsById: new Map([['p1', position('p1', 'EURUSD')]]) as never,
        orders: [],
        ordersById: new Map(),
        account: null,
        accountFreshness: fresh('connected'),
        positionsFreshness: fresh('connected'),
        ordersFreshness: fresh('connected'),
      } as never);

      const host = fakeHost() as IBrokerConnectionAdapterHost & {
        positionUpdate: ReturnType<typeof vi.fn>;
      };
      const adapter = new GatewayBrokerAdapter({
        host,
        trading: {} as TradingService,
        resolveSymbol: async () => symbol(),
      });

      useTradingStore.setState({
        positions: [] as never,
        positionsById: new Map() as never,
      } as never);
      const closes = () =>
        host.positionUpdate.mock.calls.filter(
          (c) =>
            (c[0] as { id: string; qty: number }).id === 'p1' &&
            (c[0] as { qty: number }).qty === 0,
        ).length;
      expect(closes()).toBe(1);

      await vi.advanceTimersByTimeAsync(2_000);
      expect(closes()).toBeGreaterThanOrEqual(3);

      adapter.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('never fires a stale close for a position that re-opened under the same id', async () => {
    vi.useFakeTimers();
    try {
      useSessionStore.setState({ readOnly: false, activeLogin: '1001' });
      useTradingStore.setState({
        generation: 1 as never,
        positions: [position('p1', 'EURUSD')] as never,
        positionsById: new Map([['p1', position('p1', 'EURUSD')]]) as never,
        orders: [],
        ordersById: new Map(),
        account: null,
        accountFreshness: fresh('connected'),
        positionsFreshness: fresh('connected'),
        ordersFreshness: fresh('connected'),
      } as never);

      const host = fakeHost() as IBrokerConnectionAdapterHost & {
        positionUpdate: ReturnType<typeof vi.fn>;
      };
      const adapter = new GatewayBrokerAdapter({
        host,
        trading: {} as TradingService,
        resolveSymbol: async () => symbol(),
      });

      useTradingStore.setState({
        positions: [] as never,
        positionsById: new Map() as never,
      } as never);
      // The id returns before the reinforcement fires (a partial-close
      // snapshot glitch, or a rapid re-open).
      useTradingStore.setState({
        positions: [position('p1', 'EURUSD')] as never,
        positionsById: new Map([['p1', position('p1', 'EURUSD')]]) as never,
      } as never);
      host.positionUpdate.mockClear();

      await vi.advanceTimersByTimeAsync(2_000);
      const staleCloses = host.positionUpdate.mock.calls.filter(
        (c) => (c[0] as { qty: number }).qty === 0,
      );
      expect(staleCloses).toHaveLength(0);

      adapter.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
