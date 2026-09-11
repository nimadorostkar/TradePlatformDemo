import { create } from 'zustand';
import type { Position, TradingAccount, TradingOrder } from '@/domain/common/models';
import type { ConnectionState } from '@/integrations/gateway/websocket/subscription-pool';
import type { Generation } from '@/integrations/gateway/websocket/session-generation';

/**
 * Normalised trading state — ONE canonical source for positions, orders, and
 * the account snapshot, shared by the custom UI and the TradingView Broker API
 * adapter. Two divergent copies of "what positions are open" is exactly how a
 * terminal ends up showing a position the chart thinks is closed.
 *
 * The gateway streams SNAPSHOTS, so collections are REPLACED atomically per
 * frame rather than merged. Merging would resurrect a position that had just
 * been closed, because its absence — not a tombstone — is how a close is
 * communicated.
 */

export interface DataFreshness {
  /** When the last accepted update arrived. */
  updatedAt: number | null;
  connection: ConnectionState;
}

interface TradingState {
  /** Current session generation. Frames from older generations are dropped. */
  generation: Generation;

  account: TradingAccount | null;
  accountFreshness: DataFreshness;

  positions: Position[];
  positionsById: ReadonlyMap<string, Position>;
  positionsFreshness: DataFreshness;

  orders: TradingOrder[];
  ordersById: ReadonlyMap<string, TradingOrder>;
  ordersFreshness: DataFreshness;

  /** True until the first authoritative REST snapshot lands. */
  initialLoadPending: boolean;

  /** Fields the trader changed, held over incoming frames until those agree. */
  confirmedWrites: Record<string, ConfirmedWrite>;

  setGeneration: (generation: Generation) => void;
  applyAccount: (account: TradingAccount, generation: Generation, at: number) => void;
  /**
   * Applies a field the trader has just changed and the server has already
   * confirmed, without waiting for the next authoritative snapshot.
   *
   * The value is HELD until the broker's own frames agree with it. Applying it
   * once was not enough: the account arrives on a WebSocket frame stream and
   * the broker takes a few seconds to propagate a leverage change, so the very
   * next frame still carries the old number and would have reverted the write —
   * turning a four-second lag into 1:300, 1:200, 1:300, which is worse than the
   * lag it was meant to fix.
   *
   * Freshness is deliberately NOT touched: this is a confirmed write, not a
   * new frame from the broker, and claiming otherwise would make a stalled
   * feed look live.
   */
  patchAccount: (patch: Partial<TradingAccount>, at?: number) => void;
  applyPositions: (positions: Position[], generation: Generation, at: number) => void;
  applyOrders: (orders: TradingOrder[], generation: Generation, at: number) => void;
  setConnection: (scope: 'account' | 'positions' | 'orders', connection: ConnectionState) => void;
  setInitialLoadPending: (pending: boolean) => void;
  /** Wipes all account-scoped data. Called before switching accounts. */
  resetForAccountSwitch: (generation: Generation) => void;
}

const EMPTY_FRESHNESS: DataFreshness = { updatedAt: null, connection: 'idle' };

/**
 * How long a locally-confirmed field is held over the broker's frames.
 *
 * Long enough to cover propagation (measured at ~4s for leverage, with margin),
 * and bounded so that a value the broker never adopts stops being asserted. If
 * the two have not agreed by then the authoritative snapshot wins and the
 * trader sees what their account actually is, which is the only safe end state.
 */
const CONFIRMED_WRITE_TTL_MS = 30_000;

/** A field the trader changed, held until the broker's frames catch up. */
interface ConfirmedWrite {
  value: unknown;
  until: number;
}

function indexById<T extends { id: string }>(items: T[]): ReadonlyMap<string, T> {
  const map = new Map<string, T>();
  for (const item of items) map.set(item.id, item);
  return map;
}

/**
 * Merges an incoming account frame with the fields the trader has changed and
 * the server has already confirmed.
 *
 * A held field wins over the frame until the frame AGREES with it, at which
 * point the hold is dropped and the broker is authoritative again — or until it
 * expires, because a value the broker never adopts must not be asserted
 * forever.
 */
function reconcileConfirmed(
  account: TradingAccount,
  held: Record<string, ConfirmedWrite>,
  at: number,
): { merged: TradingAccount; remaining: Record<string, ConfirmedWrite> } {
  const entries = Object.entries(held);
  if (entries.length === 0) return { merged: account, remaining: held };

  const merged = { ...account } as Record<string, unknown>;
  const remaining: Record<string, ConfirmedWrite> = {};
  for (const [field, write] of entries) {
    if (at > write.until) continue; // expired: the frame is the truth again
    if (merged[field] === write.value) continue; // converged: stop holding it
    merged[field] = write.value;
    remaining[field] = write;
  }
  return { merged: merged as unknown as TradingAccount, remaining };
}

export const useTradingStore = create<TradingState>()((set, get) => ({
  generation: 1 as Generation,

  account: null,
  accountFreshness: EMPTY_FRESHNESS,
  confirmedWrites: {},

  positions: [],
  positionsById: new Map(),
  positionsFreshness: EMPTY_FRESHNESS,

  orders: [],
  ordersById: new Map(),
  ordersFreshness: EMPTY_FRESHNESS,

  initialLoadPending: true,

  setGeneration: (generation) => set({ generation }),

  applyAccount: (account, generation, at) => {
    // A frame from a superseded generation belongs to an account the user has
    // already left. Applying it would show the wrong balance.
    if (generation !== get().generation) return;
    set((state) => {
      const { merged, remaining } = reconcileConfirmed(account, state.confirmedWrites, at);
      return {
        account: merged,
        confirmedWrites: remaining,
        accountFreshness: { updatedAt: at, connection: state.accountFreshness.connection },
      };
    });
  },

  patchAccount: (patch, at = Date.now()) =>
    set((state) => {
      if (!state.account) return state;
      const held = { ...state.confirmedWrites };
      for (const [field, value] of Object.entries(patch)) {
        held[field] = { value, until: at + CONFIRMED_WRITE_TTL_MS };
      }
      return { account: { ...state.account, ...patch }, confirmedWrites: held };
    }),

  applyPositions: (positions, generation, at) => {
    if (generation !== get().generation) return;
    set((state) => ({
      positions,
      positionsById: indexById(positions),
      positionsFreshness: { updatedAt: at, connection: state.positionsFreshness.connection },
    }));
  },

  applyOrders: (orders, generation, at) => {
    if (generation !== get().generation) return;
    set((state) => ({
      orders,
      ordersById: indexById(orders),
      ordersFreshness: { updatedAt: at, connection: state.ordersFreshness.connection },
    }));
  },

  setConnection: (scope, connection) =>
    set((state) => {
      const key = `${scope}Freshness` as const;
      const current = state[key];
      if (current.connection === connection) return state;
      return { [key]: { ...current, connection } } as Partial<TradingState>;
    }),

  setInitialLoadPending: (pending) => set({ initialLoadPending: pending }),

  resetForAccountSwitch: (generation) =>
    set({
      generation,
      account: null,
      accountFreshness: EMPTY_FRESHNESS,
      // A confirmed write belongs to the account being left.
      confirmedWrites: {},
      positions: [],
      positionsById: new Map(),
      positionsFreshness: EMPTY_FRESHNESS,
      orders: [],
      ordersById: new Map(),
      ordersFreshness: EMPTY_FRESHNESS,
      initialLoadPending: true,
    }),
}));

// Selectors — components subscribe to the narrowest slice they need so an
// order update does not re-render the positions table.
export const selectAccount = (s: TradingState) => s.account;
export const selectPositions = (s: TradingState) => s.positions;
export const selectOrders = (s: TradingState) => s.orders;
export const selectPositionCount = (s: TradingState) => s.positions.length;
export const selectOrderCount = (s: TradingState) => s.orders.length;

/** Worst connection state across the three streams, for the header badge. */
export function overallConnection(state: TradingState): ConnectionState {
  const states = [
    state.accountFreshness.connection,
    state.positionsFreshness.connection,
    state.ordersFreshness.connection,
  ];
  const severity: Record<ConnectionState, number> = {
    failed: 6,
    'auth-expired': 5,
    disconnected: 4,
    reconnecting: 3,
    stale: 2,
    connecting: 1,
    connected: 0,
    idle: 0,
  };
  return states.reduce((worst, current) => (severity[current] > severity[worst] ? current : worst));
}
