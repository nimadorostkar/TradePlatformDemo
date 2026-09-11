import { dec, decimalStringOf, type DecimalString } from '@/domain/common/decimal';
import type { OrderKind, OrderStatus, Side } from '@/domain/common/models';

/**
 * MT5 / TradingView code tables.
 *
 * Every value here is load-bearing for real-money execution. Sources:
 *   - MT5 action codes + order types: broker-sample/src/types.ts in the working
 *     TradingView integration (proven in production).
 *   - MT5→TV type/status tables: internal/transform/enums.go in the gateway.
 *
 * The gateway's own docs/USAGE.md example uses `"Action":"0"`, which does NOT
 * match the working adapter's `"200"`. The working adapter wins — see
 * docs/integration/contract-discrepancies.md#D2.
 */

/** MT5 `Action` field on /api/Trade/send_request. */
export const MT5_ACTION = {
  ExecutePosition: '200',
  PlacePendingOrder: '201',
  ModifyPosition: '202',
  ModifyOrder: '203',
  RemoveOrder: '204',
} as const;

export type Mt5Action = (typeof MT5_ACTION)[keyof typeof MT5_ACTION];

/** MT5 `Type` field. Even = buy, odd = sell. */
export const MT5_ORDER_TYPE = {
  MarketBuy: 0,
  MarketSell: 1,
  LimitBuy: 2,
  LimitSell: 3,
  StopBuy: 4,
  StopSell: 5,
  StopLimitBuy: 6,
  StopLimitSell: 7,
} as const;

/**
 * MT5 volume is expressed in units where 1.00 lot = 10000.
 * Verified in broker-sample/src/BrokerApiClient.ts (`qty * 10000`) and its
 * inverse in the position/order mappers (`qty / 10000`).
 */
export const MT5_VOLUME_UNITS_PER_LOT = 10_000;

/** Lots → MT5 volume units. Decimal-safe; never `lots * 10000` in float. */
export function lotsToMt5Volume(lots: DecimalString): number {
  return dec(lots).times(MT5_VOLUME_UNITS_PER_LOT).toDecimalPlaces(0).toNumber();
}

/** MT5 volume units → lots. */
export function mt5VolumeToLots(units: string | number): DecimalString {
  return decimalStringOf(dec(units).dividedBy(MT5_VOLUME_UNITS_PER_LOT));
}

/**
 * MT5 EXTENDED volume units per lot.
 *
 * The Manager API exposes each volume limit twice: `VolumeMin` in 1/10000 lot
 * and `VolumeMinExt` in 1/100000000 lot. They are DIFFERENT scales, so the two
 * fields must never be treated interchangeably — reading an `Ext` value with
 * the standard divisor understates the limit by four orders of magnitude.
 */
export const MT5_VOLUME_EXT_UNITS_PER_LOT = 100_000_000;

/** MT5 extended volume units → lots. */
export function mt5VolumeExtToLots(units: string | number): DecimalString {
  return decimalStringOf(dec(units).dividedBy(MT5_VOLUME_EXT_UNITS_PER_LOT));
}

/**
 * Reads a symbol volume limit, picking the divisor that matches the field the
 * gateway actually supplied.
 */
export function symbolVolumeToLots(
  standard: string | null | undefined,
  extended: string | null | undefined,
): DecimalString | null {
  if (standard !== null && standard !== undefined && standard !== '') {
    return mt5VolumeToLots(standard);
  }
  if (extended !== null && extended !== undefined && extended !== '') {
    return mt5VolumeExtToLots(extended);
  }
  return null;
}

/**
 * Resolves the MT5 (action, type) pair for a trade intent.
 * Throws for combinations MT5 does not accept, rather than sending a payload
 * the server would reject or, worse, misinterpret.
 */
export function resolveMt5ActionAndType(params: {
  intent:
    'open' | 'close' | 'place-pending' | 'modify-pending' | 'cancel-pending' | 'modify-position';
  kind: OrderKind;
  side: Side;
}): { action: Mt5Action; type: number } {
  const { intent, kind, side } = params;

  switch (intent) {
    case 'open':
    case 'close':
    case 'modify-position': {
      if (kind !== 'market') {
        throw new Error(`Position actions require a market order type, got "${kind}"`);
      }
      const type = side === 'buy' ? MT5_ORDER_TYPE.MarketBuy : MT5_ORDER_TYPE.MarketSell;
      const action =
        intent === 'modify-position' ? MT5_ACTION.ModifyPosition : MT5_ACTION.ExecutePosition;
      return { action, type };
    }
    case 'place-pending':
    case 'modify-pending':
    case 'cancel-pending': {
      const type = pendingOrderType(kind, side);
      const action =
        intent === 'place-pending'
          ? MT5_ACTION.PlacePendingOrder
          : intent === 'modify-pending'
            ? MT5_ACTION.ModifyOrder
            : MT5_ACTION.RemoveOrder;
      return { action, type };
    }
    default: {
      const exhaustive: never = intent;
      throw new Error(`Unsupported trade intent: ${String(exhaustive)}`);
    }
  }
}

function pendingOrderType(kind: OrderKind, side: Side): number {
  switch (kind) {
    case 'limit':
      return side === 'buy' ? MT5_ORDER_TYPE.LimitBuy : MT5_ORDER_TYPE.LimitSell;
    case 'stop':
      return side === 'buy' ? MT5_ORDER_TYPE.StopBuy : MT5_ORDER_TYPE.StopSell;
    case 'stop-limit':
      return side === 'buy' ? MT5_ORDER_TYPE.StopLimitBuy : MT5_ORDER_TYPE.StopLimitSell;
    case 'market':
      throw new Error('A market order cannot be placed as a pending order');
    default: {
      const exhaustive: never = kind;
      throw new Error(`Unsupported order kind: ${String(exhaustive)}`);
    }
  }
}

export function oppositeSide(side: Side): Side {
  return side === 'buy' ? 'sell' : 'buy';
}

/** MT5 order type integer → domain side. Even = buy. */
export function sideFromMt5Type(mt5Type: number): Side {
  return mt5Type % 2 === 0 ? 'buy' : 'sell';
}

/** MT5 order type integer → domain kind. */
export function kindFromMt5Type(mt5Type: number): OrderKind {
  switch (mt5Type) {
    case 0:
    case 1:
      return 'market';
    case 2:
    case 3:
      return 'limit';
    case 4:
    case 5:
      return 'stop';
    case 6:
    case 7:
      return 'stop-limit';
    default:
      return 'market';
  }
}

/**
 * TradingView side integer (Buy=1, Sell=-1) → domain side.
 * Used for the `source=tv` payloads, where `side` is already mapped by the
 * gateway (transform/enums.go#SideFromType / GetSideType).
 */
export function sideFromTvSide(tvSide: number): Side {
  return tvSide >= 0 ? 'buy' : 'sell';
}

export function tvSideOf(side: Side): number {
  return side === 'buy' ? 1 : -1;
}

/** TradingView order-type integer (transform/enums.go#MT5ToTVType). */
export function kindFromTvType(tvType: number): OrderKind {
  switch (tvType) {
    case 1:
      return 'limit';
    case 2:
      return 'market';
    case 3:
      return 'stop';
    case 4:
      return 'stop-limit';
    default:
      return 'market';
  }
}

export function tvTypeOf(kind: OrderKind): number {
  switch (kind) {
    case 'limit':
      return 1;
    case 'market':
      return 2;
    case 'stop':
      return 3;
    case 'stop-limit':
      return 4;
    default:
      return 2;
  }
}

/**
 * TradingView order-status integer → domain status.
 *
 * Verified against transform/enums.go#MT5ToTVStatus, whose codomain is
 * {1 Canceled, 2 Filled, 4 Placing, 5 Rejected, 6 Working}.
 */
export function statusFromTvStatus(tvStatus: number): OrderStatus {
  switch (tvStatus) {
    case 1:
      return 'canceled';
    case 2:
      return 'filled';
    case 3:
      return 'expired';
    case 4:
      return 'placing';
    case 5:
      return 'rejected';
    case 6:
      return 'working';
    default:
      return 'unknown';
  }
}

/**
 * MT5 order STATE → domain status.
 *
 * Needed because the WebSocket order stream (`OrdersToTVV2`) puts the value of
 * `MT5ToTVType(State)` into `status`, not `MT5ToTVStatus(State)` — a genuine
 * gateway inconsistency. Callers on the WS path must use this function against
 * the ORIGINAL MT5 state semantics; see docs/integration/contract-discrepancies.md#D3.
 */
export function statusFromMt5State(state: number): OrderStatus {
  switch (state) {
    case 0:
      return 'placing';
    case 1:
      return 'working';
    case 2:
      return 'canceled';
    case 3:
      return 'working'; // partially filled
    case 4:
      return 'filled';
    case 5:
      return 'rejected';
    case 6:
      return 'expired';
    default:
      return 'unknown';
  }
}

/**
 * Reverses `MT5ToTVType` so a WS `status` integer can be read back as the MT5
 * state it was derived from. The mapping is many-to-one ({0,1}→2, {2,3}→1,
 * {4,5}→3, {6,7}→4, everything else→0), so the inverse is ambiguous. We return
 * the CANDIDATE SET and let the caller decide, rather than guessing.
 */
export function mt5StatesForTvType(tvType: number): readonly number[] {
  switch (tvType) {
    case 2:
      return [0, 1];
    case 1:
      return [2, 3];
    case 3:
      return [4, 5];
    case 4:
      return [6, 7];
    default:
      return [];
  }
}

/** Number of decimal digits in a price, used for the MT5 `digits` field. */
export function digitsFromPrice(price: DecimalString | null | undefined): number {
  if (price === null || price === undefined) return 0;
  return dec(price).decimalPlaces();
}
