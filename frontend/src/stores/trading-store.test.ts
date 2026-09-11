import { beforeEach, describe, expect, it } from 'vitest';
import type { DecimalString } from '@/domain/common/decimal';
import { asAccountLogin, asPositionId } from '@/domain/common/ids';
import type { Position, TradingAccount } from '@/domain/common/models';
import type { Generation } from '@/integrations/gateway/websocket/session-generation';
import { overallConnection, useTradingStore } from './trading-store';

const d = (v: string) => v as DecimalString;

function position(id: string, overrides: Partial<Position> = {}): Position {
  return {
    id: asPositionId(id),
    symbol: 'EURUSD.',
    displaySymbol: 'EURUSD',
    side: 'buy',
    volume: d('1'),
    openPrice: d('1.10'),
    currentPrice: d('1.11'),
    stopLoss: null,
    takeProfit: null,
    profit: d('100'),
    swap: null,
    commission: null,
    openTime: 1_700_000_000_000,
    comment: null,
    ...overrides,
  };
}

function account(login: string, balance: string): TradingAccount {
  return {
    login: asAccountLogin(login),
    name: `Account ${login}`,
    currency: 'USD',
    server: 'Broker-Live',
    balance: d(balance),
    equity: d(balance),
    profit: d('0'),
    margin: d('0'),
    marginFree: d(balance),
    marginLevel: null,
    leverage: d('100'),
    readOnly: false,
    asOf: Date.now(),
  };
}

beforeEach(() => {
  useTradingStore.setState({
    generation: 1 as Generation,
    account: null,
    confirmedWrites: {},
    positions: [],
    positionsById: new Map(),
    orders: [],
    ordersById: new Map(),
    initialLoadPending: true,
  });
});

describe('generation guarding', () => {
  it('drops a frame from a superseded generation', () => {
    // This is what stops the PREVIOUS account's positions appearing under the
    // new one after a switch.
    const store = useTradingStore.getState();
    store.setGeneration(5 as Generation);

    store.applyPositions([position('1')], 4 as Generation, Date.now());
    expect(useTradingStore.getState().positions).toHaveLength(0);

    store.applyPositions([position('2')], 5 as Generation, Date.now());
    expect(useTradingStore.getState().positions).toHaveLength(1);
  });

  it('drops a superseded account frame', () => {
    const store = useTradingStore.getState();
    store.setGeneration(3 as Generation);

    store.applyAccount(account('1001', '5000'), 2 as Generation, Date.now());
    expect(useTradingStore.getState().account).toBeNull();

    store.applyAccount(account('1002', '9000'), 3 as Generation, Date.now());
    expect(useTradingStore.getState().account?.balance).toBe('9000');
  });

  it('clears every account-scoped collection on an account switch', () => {
    const store = useTradingStore.getState();
    store.applyPositions([position('1')], 1 as Generation, Date.now());
    store.applyAccount(account('1001', '5000'), 1 as Generation, Date.now());
    expect(useTradingStore.getState().positions).toHaveLength(1);

    useTradingStore.getState().resetForAccountSwitch(2 as Generation);

    const state = useTradingStore.getState();
    expect(state.positions).toHaveLength(0);
    expect(state.positionsById.size).toBe(0);
    expect(state.orders).toHaveLength(0);
    expect(state.account).toBeNull();
    expect(state.initialLoadPending).toBe(true);
    expect(state.generation).toBe(2);
  });
});

describe('snapshot replacement', () => {
  it('REPLACES the collection rather than merging', () => {
    // The gateway streams snapshots; a position's ABSENCE is how a close is
    // communicated. Merging would resurrect a closed position.
    const store = useTradingStore.getState();
    store.applyPositions([position('1'), position('2')], 1 as Generation, Date.now());
    expect(useTradingStore.getState().positions).toHaveLength(2);

    store.applyPositions([position('1')], 1 as Generation, Date.now());
    const state = useTradingStore.getState();
    expect(state.positions).toHaveLength(1);
    expect(state.positionsById.has('2')).toBe(false);
  });

  it('indexes positions by id for O(1) lookup', () => {
    useTradingStore.getState().applyPositions([position('42')], 1 as Generation, Date.now());
    expect(useTradingStore.getState().positionsById.get('42')?.displaySymbol).toBe('EURUSD');
  });

  it('records the update time for staleness detection', () => {
    const at = Date.now();
    useTradingStore.getState().applyPositions([], 1 as Generation, at);
    expect(useTradingStore.getState().positionsFreshness.updatedAt).toBe(at);
  });
});

describe('overallConnection', () => {
  it('reports the WORST state across the three streams', () => {
    // A partially-degraded session must never look fully healthy.
    useTradingStore.setState({
      accountFreshness: { updatedAt: 1, connection: 'connected' },
      positionsFreshness: { updatedAt: 1, connection: 'stale' },
      ordersFreshness: { updatedAt: 1, connection: 'connected' },
    });
    expect(overallConnection(useTradingStore.getState())).toBe('stale');

    useTradingStore.setState({
      positionsFreshness: { updatedAt: 1, connection: 'disconnected' },
    });
    expect(overallConnection(useTradingStore.getState())).toBe('disconnected');

    useTradingStore.setState({
      ordersFreshness: { updatedAt: 1, connection: 'auth-expired' },
    });
    expect(overallConnection(useTradingStore.getState())).toBe('auth-expired');
  });

  it('reports connected only when every stream is connected', () => {
    useTradingStore.setState({
      accountFreshness: { updatedAt: 1, connection: 'connected' },
      positionsFreshness: { updatedAt: 1, connection: 'connected' },
      ordersFreshness: { updatedAt: 1, connection: 'connected' },
    });
    expect(overallConnection(useTradingStore.getState())).toBe('connected');
  });
});

/**
 * 2026-08-20 retest, the leverage observation: the toast and the Order panel
 * moved to 1:300 instantly while the Account tab — the one place a trader
 * looks to check what their account really is — still read 1:200 for about
 * four seconds. It converged every time, but for those four seconds the
 * definitive view was the one showing the old number.
 */
describe('a value the server has already confirmed', () => {
  it('moves the account without waiting for the next snapshot', () => {
    const store = useTradingStore.getState();
    store.applyAccount(account('1001', '3289.42'), 1 as Generation, 1_000);

    store.patchAccount({ leverage: d('300') });

    expect(useTradingStore.getState().account?.leverage).toBe('300');
    // Everything else is untouched: this states one confirmed field, it does
    // not stand in for a snapshot.
    expect(useTradingStore.getState().account?.balance).toBe('3289.42');
  });

  it('holds the value over frames that still carry the old one', () => {
    const store = useTradingStore.getState();
    store.applyAccount(account('1001', '3289.42'), 1 as Generation, 1_000);
    store.patchAccount({ leverage: d('300') }, 1_000);

    // The broker takes a few seconds to propagate. Every frame in between still
    // says 1:200, and applying them would flip the tab back — 1:300, 1:200,
    // 1:300 — which is worse than the lag this exists to remove.
    const stale = { ...account('1001', '3289.42'), leverage: d('200') };
    useTradingStore.getState().applyAccount(stale, 1 as Generation, 2_000);
    expect(useTradingStore.getState().account?.leverage).toBe('300');

    useTradingStore.getState().applyAccount(stale, 1 as Generation, 3_500);
    expect(useTradingStore.getState().account?.leverage).toBe('300');
  });

  it('lets the broker be authoritative again the moment it agrees', () => {
    const store = useTradingStore.getState();
    store.applyAccount(account('1001', '3289.42'), 1 as Generation, 1_000);
    store.patchAccount({ leverage: d('300') }, 1_000);

    const caughtUp = { ...account('1001', '3289.42'), leverage: d('300') };
    useTradingStore.getState().applyAccount(caughtUp, 1 as Generation, 4_000);
    expect(useTradingStore.getState().confirmedWrites).toEqual({});

    // And a LATER change made anywhere else is no longer masked by the hold.
    const changedElsewhere = { ...account('1001', '3289.42'), leverage: d('500') };
    useTradingStore.getState().applyAccount(changedElsewhere, 1 as Generation, 5_000);
    expect(useTradingStore.getState().account?.leverage).toBe('500');
  });

  it('stops asserting a value the broker never adopts', () => {
    const store = useTradingStore.getState();
    store.applyAccount(account('1001', '3289.42'), 1 as Generation, 1_000);
    store.patchAccount({ leverage: d('300') }, 1_000);

    // Half a minute on, the account still says 1:200. Whatever happened, the
    // trader must be shown what their account actually is.
    const stale = { ...account('1001', '3289.42'), leverage: d('200') };
    useTradingStore.getState().applyAccount(stale, 1 as Generation, 1_000 + 31_000);
    expect(useTradingStore.getState().account?.leverage).toBe('200');
    expect(useTradingStore.getState().confirmedWrites).toEqual({});
  });

  it('drops held writes when the account is switched away from', () => {
    const store = useTradingStore.getState();
    store.applyAccount(account('1001', '3289.42'), 1 as Generation, 1_000);
    store.patchAccount({ leverage: d('300') }, 1_000);

    useTradingStore.getState().resetForAccountSwitch(2 as Generation);
    // A confirmed write belongs to the account it was made on; carrying it
    // across would state one account's leverage over another's.
    expect(useTradingStore.getState().confirmedWrites).toEqual({});

    const other = { ...account('2002', '100.00'), leverage: d('100') };
    useTradingStore.getState().applyAccount(other, 2 as Generation, 2_000);
    expect(useTradingStore.getState().account?.leverage).toBe('100');
  });

  it('does not claim the account data got any fresher', () => {
    const store = useTradingStore.getState();
    store.applyAccount(account('1001', '3289.42'), 1 as Generation, 1_000);

    store.patchAccount({ leverage: d('300') });

    // A confirmed write is not a new frame from the broker. Stamping freshness
    // here would make a stalled feed look live.
    expect(useTradingStore.getState().accountFreshness.updatedAt).toBe(1_000);
  });

  it('does nothing when no account is loaded', () => {
    useTradingStore.getState().patchAccount({ leverage: d('300') });
    // Inventing an account from a single field would put a balance-less row
    // on screen where the terminal means to show its loading state.
    expect(useTradingStore.getState().account).toBeNull();
  });
});
