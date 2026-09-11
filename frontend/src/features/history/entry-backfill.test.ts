import { describe, expect, it, vi } from 'vitest';
import type { Deal } from '@/domain/common/models';
import type { DecimalString } from '@/domain/common/decimal';
import {
  closedPositionsWithBackfill,
  fetchEntryBackfill,
  missingEntryIdsOf,
} from './entry-backfill';

const SECOND = 1000;

const deal = (overrides: Partial<Deal> & { id: string }): Deal =>
  ({
    positionId: '900',
    orderId: null,
    kind: 'trade',
    entry: 0,
    symbol: 'BTCUSD.',
    displaySymbol: 'BTCUSD',
    side: 'buy',
    volume: '0.01' as DecimalString,
    price: '89525.13' as DecimalString,
    profit: null,
    swap: null,
    commission: null,
    time: 0,
    comment: null,
    ...overrides,
  }) as Deal;

const WINDOW_START_SECONDS = 1_700_000_000;
const WINDOW_START_MS = WINDOW_START_SECONDS * SECOND;

/** A closing deal inside the window whose entry lies before it. */
const exitInWindow = deal({
  id: '2',
  entry: 1,
  side: 'sell',
  price: '62859.19' as DecimalString,
  profit: '-266.66' as DecimalString,
  time: WINDOW_START_MS + 3600 * SECOND,
});

describe('missingEntryIdsOf', () => {
  it('names the positions whose entry was never fetched', () => {
    expect(missingEntryIdsOf([exitInWindow])).toEqual(['900']);
  });

  it('is empty when both legs are in the window', () => {
    const entry = deal({ id: '1', time: WINDOW_START_MS + 60 * SECOND });
    expect(missingEntryIdsOf([entry, exitInWindow])).toEqual([]);
  });

  it('does not repeat a position closed in several parts', () => {
    const second = deal({ ...exitInWindow, id: '3', time: WINDOW_START_MS + 7200 * SECOND });
    expect(missingEntryIdsOf([exitInWindow, second])).toEqual(['900']);
  });
});

describe('fetchEntryBackfill', () => {
  it('asks for nothing when nothing is missing', async () => {
    const fetchDeals = vi.fn();
    expect(await fetchEntryBackfill(WINDOW_START_SECONDS, [], fetchDeals)).toEqual([]);
    expect(fetchDeals).not.toHaveBeenCalled();
  });

  it('stops at the first lookback once the entry is found', async () => {
    const entry = deal({ id: '1', time: WINDOW_START_MS - 86_400 * SECOND });
    const fetchDeals = vi.fn().mockResolvedValue({ deals: [entry] });

    const found = await fetchEntryBackfill(WINDOW_START_SECONDS, ['900'], fetchDeals);

    expect(found).toEqual([entry]);
    expect(fetchDeals).toHaveBeenCalledTimes(1);
    expect(fetchDeals).toHaveBeenCalledWith({
      fromSeconds: WINDOW_START_SECONDS - 365 * 86_400,
      toSeconds: WINDOW_START_SECONDS,
    });
  });

  it('widens to the next lookback when the first comes back without it', async () => {
    const entry = deal({ id: '1', time: WINDOW_START_MS - 900 * 86_400 * SECOND });
    const fetchDeals = vi
      .fn()
      .mockResolvedValueOnce({ deals: [] })
      .mockResolvedValueOnce({ deals: [entry] });

    const found = await fetchEntryBackfill(WINDOW_START_SECONDS, ['900'], fetchDeals);

    expect(found).toEqual([entry]);
    expect(fetchDeals).toHaveBeenCalledTimes(2);
    // The second sweep starts where the first one did NOT already look.
    expect(fetchDeals).toHaveBeenLastCalledWith({
      fromSeconds: WINDOW_START_SECONDS - 5 * 365 * 86_400,
      toSeconds: WINDOW_START_SECONDS - 365 * 86_400,
    });
  });

  it('gives up rather than sweeping forever', async () => {
    const fetchDeals = vi.fn().mockResolvedValue({ deals: [] });
    const found = await fetchEntryBackfill(WINDOW_START_SECONDS, ['900'], fetchDeals);

    expect(found).toEqual([]);
    expect(fetchDeals).toHaveBeenCalledTimes(2);
  });

  it('keeps every deal of a missing position, not only its entry', async () => {
    // A position partly closed before the range needs those exits too, or the
    // entry commission is apportioned against the wrong volume.
    const entry = deal({ id: '1', volume: '0.03' as DecimalString });
    const earlyExit = deal({ id: '2', entry: 1, side: 'sell', volume: '0.01' as DecimalString });
    const unrelated = deal({ id: '9', positionId: '555' });
    const fetchDeals = vi.fn().mockResolvedValue({ deals: [entry, earlyExit, unrelated] });

    const found = await fetchEntryBackfill(WINDOW_START_SECONDS, ['900'], fetchDeals);

    expect(found.map((d) => d.id)).toEqual(['1', '2']);
  });
});

describe('closedPositionsWithBackfill', () => {
  it('restores the open price and time the row used to hide', () => {
    const entry = deal({ id: '1', time: WINDOW_START_MS - 86_400 * SECOND });

    const rows = closedPositionsWithBackfill([exitInWindow], [entry], WINDOW_START_MS);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.openedBeforeRange).toBeUndefined();
    expect(rows[0]?.openPrice).toBe('89525.13');
    expect(rows[0]?.openTime).toBe(WINDOW_START_MS - 86_400 * SECOND);
    // The P/L the row already showed is unchanged by learning its own entry.
    expect(rows[0]?.profit).toBe('-266.66');
  });

  it('recovers the entry commission along with the price', () => {
    const entry = deal({
      id: '1',
      commission: '-0.04' as DecimalString,
      time: WINDOW_START_MS - 86_400 * SECOND,
    });

    const rows = closedPositionsWithBackfill([exitInWindow], [entry], WINDOW_START_MS);

    expect(rows[0]?.commission).toBe('-0.04');
  });

  it('does not let a wider fetch widen the period itself', () => {
    // Both legs of this one predate the window; it must not appear just
    // because we went looking for somebody else's entry.
    const oldEntry = deal({ id: '7', positionId: '555', time: WINDOW_START_MS - 200 * SECOND });
    const oldExit = deal({
      id: '8',
      positionId: '555',
      entry: 1,
      side: 'sell',
      time: WINDOW_START_MS - 100 * SECOND,
    });
    const entry = deal({ id: '1', time: WINDOW_START_MS - 86_400 * SECOND });

    const rows = closedPositionsWithBackfill(
      [exitInWindow],
      [entry, oldEntry, oldExit],
      WINDOW_START_MS,
    );

    expect(rows.map((row) => row.id)).toEqual(['900']);
  });

  it('is the plain pairing when there was nothing to recover', () => {
    const rows = closedPositionsWithBackfill([exitInWindow], [], WINDOW_START_MS);
    expect(rows[0]?.openedBeforeRange).toBe(true);
  });
});
