import { pairDealsIntoClosedPositions } from '@/integrations/gateway/mappers/to-domain';
import type { ClosedPosition, Deal } from '@/domain/common/models';

/**
 * Recovering the entry deal of a position that opened before the range.
 *
 * History fetches one window of deals, so a position opened in June and closed
 * in August has no entry deal in an August window. The row rendered the
 * literal text "before range" where its open price and open time belong —
 * while still showing a full profit for it, which is only possible because the
 * data exists. It does exist: it is one window earlier, and the same paginated
 * endpoint will return it.
 *
 * This matters beyond cosmetics. The entry deal also carries the entry
 * commission, so a row without it understates what the trade cost.
 */

/**
 * How far back to hunt, tried in order and stopped as soon as every missing
 * entry is accounted for. The ordinary case — opened days before a 90-day
 * window — costs one extra fetch, and the six-year sweep almost never runs.
 */
export const BACKFILL_LOOKBACKS_SECONDS = [365 * 86_400, 5 * 365 * 86_400];

/** MT5 DEAL_ENTRY values that open a leg: a plain entry, and a reversal. */
const ENTRY_OPENS_LEG = new Set([0, 2]);

/** Positions that closed inside the window but whose entry was never fetched. */
export function missingEntryIdsOf(deals: readonly Deal[]): string[] {
  const ids = pairDealsIntoClosedPositions(deals)
    .filter((row) => row.openedBeforeRange)
    .map((row) => row.id as string);
  return [...new Set(ids)].sort();
}

export type DealPageFetcher = (range: {
  fromSeconds: number;
  toSeconds: number;
}) => Promise<{ deals: Deal[] }>;

/**
 * Walks backwards from the window start until every missing entry is found.
 *
 * Returns every deal belonging to a still-missing position, not just the entry
 * itself: a position partially closed before the range needs those exits too,
 * or the entry's commission would be apportioned against the wrong volume.
 */
export async function fetchEntryBackfill(
  windowStartSeconds: number,
  missingIds: readonly string[],
  fetchDeals: DealPageFetcher,
  lookbacks: readonly number[] = BACKFILL_LOOKBACKS_SECONDS,
): Promise<Deal[]> {
  if (missingIds.length === 0) return [];

  const outstanding = new Set(missingIds);
  const found: Deal[] = [];
  let coveredFrom = windowStartSeconds;

  for (const lookback of lookbacks) {
    const fromSeconds = windowStartSeconds - lookback;
    if (fromSeconds >= coveredFrom) continue;

    const page = await fetchDeals({ fromSeconds, toSeconds: coveredFrom });
    for (const deal of page.deals) {
      if (deal.positionId !== null && outstanding.has(deal.positionId)) found.push(deal);
    }
    for (const deal of page.deals) {
      if (deal.positionId !== null && deal.entry !== null && ENTRY_OPENS_LEG.has(deal.entry)) {
        outstanding.delete(deal.positionId);
      }
    }

    coveredFrom = fromSeconds;
    if (outstanding.size === 0) break;
  }

  return found;
}

/**
 * Pairs the window's deals together with anything recovered from before it.
 *
 * Rows whose exit also predates the window are dropped: widening the fetch
 * must not widen what the selected period claims to cover.
 */
export function closedPositionsWithBackfill(
  deals: readonly Deal[],
  older: readonly Deal[],
  windowStartMs: number,
): ClosedPosition[] {
  if (older.length === 0) return pairDealsIntoClosedPositions(deals);
  return pairDealsIntoClosedPositions([...older, ...deals]).filter(
    (row) => row.closeTime === null || row.closeTime >= windowStartMs,
  );
}
