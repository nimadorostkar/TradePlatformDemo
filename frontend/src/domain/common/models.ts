import type { DecimalString } from './decimal';
import type { TradingError } from './errors';
import type { AccountLogin, DealId, OrderId, PositionId } from './ids';

/**
 * Canonical domain models. React components consume ONLY these — never a raw
 * gateway/MT5 DTO. Every field here is either verified against the gateway
 * source or explicitly typed as possibly-unavailable.
 *
 * `null` means "the gateway does not supply this". The UI renders it as
 * `Unavailable` or hides the column; it must never be displayed as `0`.
 */

export type Side = 'buy' | 'sell';

export type OrderKind =
  | 'market'
  | 'limit'
  | 'stop'
  /** Stop-limit is only surfaced when a symbol/gateway path is verified. */
  | 'stop-limit';

/** Lifecycle of a locally-submitted order. Never jumps ahead of the gateway. */
export type SubmissionState =
  | 'draft'
  | 'submitting'
  | 'accepted'
  | 'rejected'
  /** Timed out — the outcome is genuinely unknown until state is refetched. */
  | 'unknown';

export type OrderStatus =
  'working' | 'filled' | 'canceled' | 'rejected' | 'expired' | 'placing' | 'unknown';

export interface TradingAccount {
  login: AccountLogin;
  /** Display name, e.g. "ECN 1002983". */
  name: string;
  currency: string | null;
  server: string | null;
  balance: DecimalString;
  /**
   * Broker credit (bonus funds). Counts toward equity and margin but is not
   * the trader's own money. Absent when the server does not report it — a
   * credited account whose credit is not shown looks like an equity that
   * disagrees with its balance for no visible reason.
   */
  credit: DecimalString | null;
  equity: DecimalString;
  profit: DecimalString;
  margin: DecimalString;
  marginFree: DecimalString;
  /** Percent. Null when no margin is in use — not 0. */
  marginLevel: DecimalString | null;
  leverage: DecimalString | null;
  /** Investor / read-only accounts must not be able to trade. */
  readOnly: boolean;
  /** Server timestamp (ms) of the snapshot this came from. */
  asOf: number;
}

export interface TradingSymbol {
  /** Gateway-facing name, suffix INCLUDED. */
  name: string;
  /** Display name, suffix REMOVED. */
  displayName: string;
  description: string;
  type: string;
  exchange: string;
  /** Price decimals derived from the gateway's pricescale. */
  digits: number;
  pricescale: number;
  minMove: number;
  volumeMin: DecimalString | null;
  volumeMax: DecimalString | null;
  volumeStep: DecimalString | null;
  contractSize: DecimalString | null;
  tickSize: DecimalString | null;
  tickValue: DecimalString | null;
  currencyCode: string | null;
  session: string;
  timezone: string;
  supportedResolutions: readonly string[];
  sector: string | null;
  industry: string | null;
}

export interface Quote {
  /** Gateway symbol name (suffix included) — the normalisation key. */
  symbol: string;
  bid: DecimalString;
  ask: DecimalString;
  last: DecimalString;
  volume: DecimalString | null;
  /** Client receive time (ms). When the frame reached THIS machine. */
  receivedAt: number;
  /**
   * When the BROKER printed the quote (ms, converted from the wire's UTC
   * seconds), or null on a gateway that does not send one.
   *
   * This — not `receivedAt` — is what staleness is judged on. A stalled feed
   * still delivers frames on time, so a fresh `receivedAt` says only that the
   * socket works, never that the price is current.
   */
  brokerTime: number | null;
  /** Direction of the last change, for the flash indicator. */
  direction: 'up' | 'down' | 'flat';
}

export interface Position {
  id: PositionId;
  symbol: string;
  displaySymbol: string;
  side: Side;
  /** Lots. Already converted from MT5 volume units. */
  volume: DecimalString;
  openPrice: DecimalString;
  currentPrice: DecimalString | null;
  stopLoss: DecimalString | null;
  takeProfit: DecimalString | null;
  profit: DecimalString | null;
  /** Gateway does not expose swap on the streamed position shape. */
  swap: DecimalString | null;
  commission: DecimalString | null;
  /** ms epoch, or null when the source omitted it. */
  openTime: number | null;
  comment: string | null;
}

export interface TradingOrder {
  id: OrderId;
  symbol: string;
  displaySymbol: string;
  side: Side;
  kind: OrderKind;
  status: OrderStatus;
  /** Lots. */
  volume: DecimalString;
  filledVolume: DecimalString | null;
  /** Entry price for limit/stop orders. */
  price: DecimalString | null;
  currentPrice: DecimalString | null;
  stopLoss: DecimalString | null;
  takeProfit: DecimalString | null;
  expiration: number | null;
  createdAt: number | null;
  comment: string | null;
}

/** A raw MT5 deal — includes ledger entries, which are separated downstream. */
export type DealKind = 'trade' | 'balance' | 'credit' | 'commission' | 'other';

export interface Deal {
  id: DealId;
  /** Position this deal belongs to, when it is a trade deal. */
  positionId: PositionId | null;
  /**
   * The ORDER this deal executed, when MT5 stamped one. This is what makes a
   * deal — the only record of what a trade actually cost — joinable to the
   * order that asked for it.
   */
  orderId: OrderId | null;
  kind: DealKind;
  /** 0 = opening a position, non-zero = closing/reversing. */
  entry: number | null;
  symbol: string | null;
  displaySymbol: string | null;
  side: Side | null;
  volume: DecimalString | null;
  price: DecimalString | null;
  profit: DecimalString | null;
  swap: DecimalString | null;
  commission: DecimalString | null;
  /** ms epoch. */
  time: number | null;
  comment: string | null;
}

/** Final state of a historical ORDER (from MT5's closed-orders history). */
export type HistoricalOrderStatus =
  'filled' | 'canceled' | 'rejected' | 'expired' | 'working' | 'placing' | 'unknown';

/**
 * One row of the broker's order history: every order that reached a final
 * state — filled, cancelled, rejected, or expired. This is what "Order
 * History" means on the broker's own platform; closed POSITIONS are a
 * different reconstruction (see ClosedPosition).
 */
export interface HistoricalOrder {
  id: string;
  symbol: string;
  displaySymbol: string;
  side: Side;
  kind: 'market' | 'limit' | 'stop' | 'stoplimit' | 'unknown';
  /** Requested size in lots. */
  volumeLots: DecimalString | null;
  /** Filled size in lots. */
  filledLots: DecimalString | null;
  /** The order's own price (limit or stop). Null for market orders. */
  price: DecimalString | null;
  stopLoss: DecimalString | null;
  takeProfit: DecimalString | null;
  status: HistoricalOrderStatus;
  /** ms epoch of the final state change (fill / cancel / expiry). */
  updateTime: number | null;
  /** ms epoch when the order was placed. */
  setupTime: number | null;
  comment: string | null;
}

/** A closed position reconstructed by pairing its opening and closing deals. */
export interface ClosedPosition {
  id: PositionId;
  symbol: string;
  displaySymbol: string;
  side: Side;
  volume: DecimalString;
  openPrice: DecimalString | null;
  closePrice: DecimalString | null;
  openTime: number | null;
  closeTime: number | null;
  /** Gross trading result, before swap and commission. */
  profit: DecimalString | null;
  /**
   * Swap and commission for the position's WHOLE life — entry deal and closing
   * deal both. MT5 charges commission on each, and reading only the closing
   * deal understated every trade by its entry commission. On a partial close
   * the entry's charges are apportioned by the volume that closed.
   */
  swap: DecimalString | null;
  commission: DecimalString | null;
  /**
   * True when the opening deal lies OUTSIDE the fetched window, so openPrice
   * and openTime are unknown rather than missing — the UI must say "opened
   * before range", not render blanks that read as corrupt data.
   */
  openedBeforeRange?: boolean;
}

/** Result of submitting a trade. Never claims `filled`. */
export interface TradeSubmissionResult {
  state: SubmissionState;
  /** Present when the gateway echoed an id; absent on timeout. */
  orderId: OrderId | null;
  /** MT5 retcode when the gateway returned one. */
  retcode: string | null;
  message: string | null;
  requestId: string;
  /**
   * Present when the submission carried an idempotency key the gateway
   * honours, which makes retrying an unknown outcome safe.
   */
  idempotencyKey?: string | undefined;
  /**
   * Why the outcome is `unknown`, when the reason is a technical one worth
   * recording. The trader sees the reconcile banner; this goes to the
   * diagnostics feed so an unreadable response can be identified from a
   * support report instead of reproduced.
   */
  diagnostic?: TradingError | undefined;
}
