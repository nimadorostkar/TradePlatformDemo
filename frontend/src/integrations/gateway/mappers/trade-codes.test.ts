import { describe, expect, it } from 'vitest';
import type { DecimalString } from '@/domain/common/decimal';
import {
  kindFromMt5Type,
  kindFromTvType,
  lotsToMt5Volume,
  MT5_ACTION,
  MT5_VOLUME_UNITS_PER_LOT,
  mt5VolumeToLots,
  oppositeSide,
  resolveMt5ActionAndType,
  sideFromMt5Type,
  sideFromTvSide,
  statusFromMt5State,
  statusFromTvStatus,
} from './trade-codes';

const lots = (v: string) => v as DecimalString;

describe('volume conversion', () => {
  it('converts lots to MT5 units at 10000 per lot', () => {
    // Verified against broker-sample/src/BrokerApiClient.ts (`qty * 10000`).
    expect(lotsToMt5Volume(lots('1'))).toBe(10_000);
    expect(lotsToMt5Volume(lots('0.01'))).toBe(100);
    expect(lotsToMt5Volume(lots('0.10'))).toBe(1_000);
    expect(lotsToMt5Volume(lots('2.5'))).toBe(25_000);
  });

  it('is decimal-safe for values that break binary floats', () => {
    // 0.07 * 10000 === 700.0000000000001 in IEEE-754 arithmetic.
    expect(lotsToMt5Volume(lots('0.07'))).toBe(700);
    expect(lotsToMt5Volume(lots('0.29'))).toBe(2_900);
    expect(lotsToMt5Volume(lots('1.15'))).toBe(11_500);
  });

  it('round-trips lots through MT5 units', () => {
    for (const value of ['0.01', '0.07', '1', '12.34']) {
      expect(mt5VolumeToLots(lotsToMt5Volume(lots(value)))).toBe(value);
    }
  });

  it('exposes the conversion constant', () => {
    expect(MT5_VOLUME_UNITS_PER_LOT).toBe(10_000);
  });
});

describe('resolveMt5ActionAndType', () => {
  it('uses action 200 with the market type for opening a position', () => {
    expect(resolveMt5ActionAndType({ intent: 'open', kind: 'market', side: 'buy' })).toEqual({
      action: MT5_ACTION.ExecutePosition,
      type: 0,
    });
    expect(resolveMt5ActionAndType({ intent: 'open', kind: 'market', side: 'sell' })).toEqual({
      action: MT5_ACTION.ExecutePosition,
      type: 1,
    });
  });

  it('uses 201 for a pending order with the right type per side', () => {
    expect(
      resolveMt5ActionAndType({ intent: 'place-pending', kind: 'limit', side: 'buy' }),
    ).toEqual({ action: MT5_ACTION.PlacePendingOrder, type: 2 });
    expect(
      resolveMt5ActionAndType({ intent: 'place-pending', kind: 'limit', side: 'sell' }),
    ).toEqual({ action: MT5_ACTION.PlacePendingOrder, type: 3 });
    expect(resolveMt5ActionAndType({ intent: 'place-pending', kind: 'stop', side: 'buy' })).toEqual(
      {
        action: MT5_ACTION.PlacePendingOrder,
        type: 4,
      },
    );
    expect(
      resolveMt5ActionAndType({ intent: 'place-pending', kind: 'stop', side: 'sell' }),
    ).toEqual({ action: MT5_ACTION.PlacePendingOrder, type: 5 });
  });

  it('uses 202/203/204 for modify-position, modify-order and remove', () => {
    expect(
      resolveMt5ActionAndType({ intent: 'modify-position', kind: 'market', side: 'buy' }).action,
    ).toBe(MT5_ACTION.ModifyPosition);
    expect(
      resolveMt5ActionAndType({ intent: 'modify-pending', kind: 'limit', side: 'buy' }).action,
    ).toBe(MT5_ACTION.ModifyOrder);
    expect(
      resolveMt5ActionAndType({ intent: 'cancel-pending', kind: 'limit', side: 'buy' }).action,
    ).toBe(MT5_ACTION.RemoveOrder);
  });

  it('refuses combinations MT5 does not accept', () => {
    // Sending these would produce a payload the server misreads rather than
    // rejects, so the client refuses first.
    expect(() => resolveMt5ActionAndType({ intent: 'open', kind: 'limit', side: 'buy' })).toThrow();
    expect(() =>
      resolveMt5ActionAndType({ intent: 'place-pending', kind: 'market', side: 'buy' }),
    ).toThrow();
  });
});

describe('side and type mapping', () => {
  it('reads MT5 type parity as the side', () => {
    expect(sideFromMt5Type(0)).toBe('buy');
    expect(sideFromMt5Type(1)).toBe('sell');
    expect(sideFromMt5Type(4)).toBe('buy');
    expect(sideFromMt5Type(5)).toBe('sell');
  });

  it('maps MT5 types to order kinds', () => {
    expect(kindFromMt5Type(0)).toBe('market');
    expect(kindFromMt5Type(2)).toBe('limit');
    expect(kindFromMt5Type(4)).toBe('stop');
    expect(kindFromMt5Type(6)).toBe('stop-limit');
  });

  it('maps the TradingView side integer', () => {
    expect(sideFromTvSide(1)).toBe('buy');
    expect(sideFromTvSide(-1)).toBe('sell');
  });

  it('maps the TradingView type integer', () => {
    expect(kindFromTvType(1)).toBe('limit');
    expect(kindFromTvType(2)).toBe('market');
    expect(kindFromTvType(3)).toBe('stop');
    expect(kindFromTvType(4)).toBe('stop-limit');
  });

  it('flips sides', () => {
    expect(oppositeSide('buy')).toBe('sell');
    expect(oppositeSide('sell')).toBe('buy');
  });
});

describe('status mapping', () => {
  it('maps the REST status table (MT5ToTVStatus)', () => {
    expect(statusFromTvStatus(1)).toBe('canceled');
    expect(statusFromTvStatus(2)).toBe('filled');
    expect(statusFromTvStatus(5)).toBe('rejected');
    expect(statusFromTvStatus(6)).toBe('working');
  });

  it('maps raw MT5 order states', () => {
    expect(statusFromMt5State(1)).toBe('working');
    expect(statusFromMt5State(3)).toBe('working'); // partially filled
    expect(statusFromMt5State(4)).toBe('filled');
    expect(statusFromMt5State(6)).toBe('expired');
  });

  it('maps every status the gateway emits, on both transports', () => {
    // The gateway now populates `status` from MT5ToTVStatus on the REST and
    // WebSocket paths alike, so a single table reads both.
    expect(statusFromTvStatus(1)).toBe('canceled');
    expect(statusFromTvStatus(2)).toBe('filled');
    expect(statusFromTvStatus(5)).toBe('rejected');
    expect(statusFromTvStatus(6)).toBe('working');
    // Anything outside the documented codomain stays unknown rather than
    // being guessed at.
    expect(statusFromTvStatus(99)).toBe('unknown');
  });
});
