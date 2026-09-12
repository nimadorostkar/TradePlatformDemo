import { create } from 'zustand';
import type { BracketUnit } from '@/domain/orders/risk';
import type { OrderKind, Side } from '@/domain/common/models';

/**
 * The order ticket's working draft, lifted into a store.
 *
 * It lives outside the ticket component so another widget can populate it —
 * specifically the risk calculator, which computes a position size the trader
 * would otherwise have to read off one panel and retype into another.
 *
 * This is UI state only. Nothing here is sent anywhere until the ticket
 * validates it and the trader confirms.
 */

export interface OrderDraft {
  kind: OrderKind;
  volume: string;
  price: string;
  stopLoss: string;
  stopLossUnit: BracketUnit;
  takeProfit: string;
  takeProfitUnit: BracketUnit;
  /** Set when another widget wrote the draft, so the ticket can acknowledge it. */
  appliedFrom: string | null;
  /** Preferred side, when the source had an opinion. */
  side: Side | null;
}

interface OrderDraftState extends OrderDraft {
  set: (patch: Partial<OrderDraft>) => void;
  /**
   * Switches the draft to another symbol: prices are cleared, and the volume
   * for the symbol being left is remembered so returning to it restores it.
   */
  resetForSymbol: (leaving?: string | null, entering?: string | null) => void;
  /**
   * Declares which instrument the ticket is showing, WITHOUT throwing anything
   * away when that is the instrument the draft already belongs to.
   *
   * This is what a remount and a reload call. `resetForSymbol` is for the
   * trader actually moving to another instrument.
   */
  adoptSymbol: (symbol: string) => void;
  /**
   * Seeds the volume from the instrument's minimum when the trader has not
   * sized this symbol yet. The store's default is 0.01 lots; an instrument
   * whose minimum is 0.1 (crypto here, most indices elsewhere) otherwise
   * opens with the ticket already in error and both buttons disabled.
   * Anything the trader typed, or a size remembered for the symbol, wins.
   */
  seedMinimumVolume: (symbol: string, minimum: string) => void;
  /** The instrument the price fields belong to. Null before the ticket mounts. */
  symbol: string | null;
  /** Volume last used per symbol, so each instrument keeps its own size. */
  volumeBySymbol: Record<string, string>;
  applyFrom: (source: string, patch: Partial<OrderDraft>) => void;
  acknowledgeApplied: () => void;
}

const INITIAL: OrderDraft = {
  kind: 'market',
  volume: '0.01',
  price: '',
  stopLoss: '',
  stopLossUnit: 'price',
  takeProfit: '',
  takeProfitUnit: 'price',
  appliedFrom: null,
  side: null,
};

/**
 * What survives a reload, and where.
 *
 * A half-typed ticket is working state that belongs to THIS tab, so it lives in
 * sessionStorage: it survives a reload and is gone when the tab is. The point is
 * narrow — a reload should be invisible to the ticket. A draft left in memory
 * for an hour would still be there had the tab not reloaded, so restoring it
 * makes reload behave like no-reload; that is the whole intent, and it is why
 * there is no expiry here.
 *
 * `appliedFrom` and `side` are deliberately NOT persisted: they are an
 * acknowledgement of something another widget did a moment ago, and restoring
 * "Values applied from Risk calculator" onto a reloaded tab would be a claim
 * about an event the trader can no longer see.
 */
const STORAGE_KEY = 'tradeplatform.order-draft';

type PersistedDraft = Pick<
  OrderDraftState,
  | 'kind'
  | 'volume'
  | 'price'
  | 'stopLoss'
  | 'stopLossUnit'
  | 'takeProfit'
  | 'takeProfitUnit'
  | 'volumeBySymbol'
  | 'symbol'
>;

export function readPersistedDraft(storage?: Storage): Partial<PersistedDraft> {
  try {
    const store = storage ?? sessionStorage;
    const raw = store.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    return parsed as Partial<PersistedDraft>;
  } catch {
    // Blocked storage, or something else's key at ours. A ticket that starts
    // empty is a disappointment; one that throws on boot is an outage.
    return {};
  }
}

/** Only the fields above, and only ones of the right shape. */
function sanitise(raw: Partial<PersistedDraft>): Partial<PersistedDraft> {
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
  const out: Partial<PersistedDraft> = {};
  if (raw.kind === 'market' || raw.kind === 'limit' || raw.kind === 'stop') out.kind = raw.kind;
  for (const key of ['volume', 'price', 'stopLoss', 'takeProfit', 'symbol'] as const) {
    const value = str(raw[key]);
    if (value !== undefined) out[key] = value;
  }
  for (const key of ['stopLossUnit', 'takeProfitUnit'] as const) {
    const value = str(raw[key]);
    if (value === 'price' || value === 'pips' || value === 'percent' || value === 'money') {
      out[key] = value;
    }
  }
  if (raw.volumeBySymbol && typeof raw.volumeBySymbol === 'object') {
    const volumes: Record<string, string> = {};
    for (const [symbol, volume] of Object.entries(raw.volumeBySymbol)) {
      if (typeof volume === 'string') volumes[symbol] = volume;
    }
    out.volumeBySymbol = volumes;
  }
  return out;
}

export const useOrderDraft = create<OrderDraftState>()((set, get) => ({
  ...INITIAL,
  symbol: null,
  volumeBySymbol: {},
  ...sanitise(readPersistedDraft()),

  set: (patch) => set(patch),

  adoptSymbol: (symbol) =>
    set((state) => {
      if (state.symbol === symbol) return state;
      // A draft restored from another instrument must never be shown against
      // this one — a EURUSD stop price under XAUUSD is not a stale field, it is
      // a wrong number the trader has no reason to distrust.
      //
      // The VOLUME is re-derived for the same reason, and it is the more
      // dangerous of the two: a price that belongs to another instrument is
      // obvious on sight and the ticket refuses it, whereas 0.05 carried from
      // EURUSD onto gold is a perfectly valid number that silently resizes the
      // trade. Each symbol keeps its own, and an unvisited one starts at the
      // default — the same rule `resetForSymbol` applies when the trader
      // switches instrument with the tab still open.
      if (state.symbol !== null) {
        return {
          symbol,
          volume: state.volumeBySymbol[symbol] ?? INITIAL.volume,
          price: '',
          stopLoss: '',
          takeProfit: '',
          appliedFrom: null,
          side: null,
        };
      }
      return { symbol };
    }),

  resetForSymbol: (leaving, entering) =>
    // Prices are symbol-specific and are cleared, or a EURUSD stop would
    // follow the trader onto XAUUSD. Volume is symbol-specific too, but in the
    // other direction: carrying one instrument's size onto another silently
    // resizes the trade — 0.25 lots of EURUSD is not 0.25 lots of gold — so
    // each symbol keeps its own, and an unvisited one starts from the default.
    set(() => {
      const state = get();
      const remembered = { ...state.volumeBySymbol };
      if (leaving) remembered[leaving] = state.volume;
      return {
        volumeBySymbol: remembered,
        volume: (entering ? remembered[entering] : undefined) ?? INITIAL.volume,
        symbol: entering ?? null,
        price: '',
        stopLoss: '',
        takeProfit: '',
        appliedFrom: null,
        side: null,
      };
    }),

  seedMinimumVolume: (symbol, minimum) =>
    set((state) => {
      if (state.symbol !== symbol || state.volumeBySymbol[symbol] !== undefined) return {};
      if (state.volume !== INITIAL.volume) return {};
      const min = Number(minimum);
      if (!Number.isFinite(min) || min <= Number(INITIAL.volume)) return {};
      return { volume: minimum, volumeBySymbol: { ...state.volumeBySymbol, [symbol]: minimum } };
    }),

  applyFrom: (source, patch) => set({ ...patch, appliedFrom: source }),

  acknowledgeApplied: () => set({ appliedFrom: null }),
}));

// Mirrored on every change, so a reload — including the one the stale-chunk
// recovery performs after a deploy lands under a running tab — restores the
// ticket instead of silently emptying it.
useOrderDraft.subscribe((state) => {
  try {
    const snapshot: PersistedDraft = {
      kind: state.kind,
      volume: state.volume,
      price: state.price,
      stopLoss: state.stopLoss,
      stopLossUnit: state.stopLossUnit,
      takeProfit: state.takeProfit,
      takeProfitUnit: state.takeProfitUnit,
      volumeBySymbol: state.volumeBySymbol,
      symbol: state.symbol,
    };
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    /* storage can be blocked or full; the ticket still works in memory */
  }
});
