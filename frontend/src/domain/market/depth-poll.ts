import type { MarketDepthDto } from '@/integrations/gateway/contracts/schemas';

/**
 * Poll pacing for market depth.
 *
 * The gateway serves depth over REST only, so both depth surfaces — the ladder
 * widget and the chart's built-in DOM — poll. They share this policy because
 * they poll the SAME endpoint for the same symbol: two independent cadences
 * would double the request rate and let the two panels show books of different
 * ages.
 *
 * Many brokers publish no Level 2 at all. Against such a feed a fixed cadence
 * is pure waste — measured at ~2 req/s indefinitely, for a permanently empty
 * ladder. So an empty book backs the loop off geometrically instead, and any
 * book with levels snaps it straight back to the base rate: a symbol that
 * starts publishing depth mid-session (a market opening) must recover on its
 * own, which is why this backs off to a cap rather than stopping outright.
 */

/** Cadence for a symbol that IS publishing depth. */
export const DEPTH_POLL_BASE_MS = 1_500;

/**
 * Slowest cadence for a symbol that keeps returning nothing. A 20× reduction
 * on the base rate, still frequent enough that depth appearing is noticed
 * within half a minute.
 */
export const DEPTH_POLL_MAX_MS = 30_000;

/** True when a book carries no tradable level on either side. */
export function isEmptyBook(depth: MarketDepthDto | undefined): boolean {
  return !depth || (depth.bids.length === 0 && depth.asks.length === 0);
}

/**
 * The delay to wait before the next poll.
 *
 * `previousDelayMs` is the delay that produced the response being judged, so
 * the growth is driven by how long this symbol has been empty rather than by a
 * separate counter that could drift out of step with the timer.
 */
export function nextDepthPollDelay(
  previousDelayMs: number,
  depth: MarketDepthDto | undefined,
): number {
  if (!isEmptyBook(depth)) return DEPTH_POLL_BASE_MS;
  const doubled = Math.max(previousDelayMs, DEPTH_POLL_BASE_MS) * 2;
  return Math.min(doubled, DEPTH_POLL_MAX_MS);
}
