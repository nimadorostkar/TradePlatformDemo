import type { Quote } from '@/domain/common/models';

/**
 * Price staleness — how old the BROKER says a quote is.
 *
 * Deliberately separate from the transport staleness in the subscription pool
 * (`VITE_QUOTE_STALE_AFTER_MS`, four push cadences). That one answers "is the
 * socket still delivering?"; this one answers "is this price still real?".
 * They are not the same question: over a weekend the socket keeps delivering
 * frames perfectly on time, and every one of them repeats Friday's close.
 *
 * Rendering that as a live price is how a trader ends up believing a number
 * that stopped being true two days ago.
 */

/**
 * How old a quote may be before it is presented as stale.
 *
 * Well above any plausible disagreement between the trader's clock and the
 * broker's — a second or two of skew must never light this up — and comfortably
 * above the ~3s push cadence, so an ordinary quiet minute on a thin instrument
 * does not flicker the badge on and off.
 */
export const QUOTE_STALE_AFTER_MS = 90_000;

/**
 * Age of a quote in milliseconds, or null when the gateway sent no broker
 * timestamp and the age is therefore unknowable.
 */
export function quoteAgeMs(quote: Quote | undefined, now: number = Date.now()): number | null {
  if (!quote || quote.brokerTime === null) return null;
  return now - quote.brokerTime;
}

/**
 * Whether a quote should be presented as stale.
 *
 * Returns false when there is no broker timestamp. A gateway older than the
 * quote-timestamp change cannot support this check, and flagging every price on
 * such a deployment as stale would train users to ignore the indicator — which
 * costs more than not having it.
 */
export function isQuoteStale(
  quote: Quote | undefined,
  now: number = Date.now(),
  thresholdMs: number = QUOTE_STALE_AFTER_MS,
): boolean {
  const age = quoteAgeMs(quote, now);
  if (age === null) return false;
  return age > thresholdMs;
}

/** Human-readable age, for the tooltip explaining why a price is dimmed. */
export function formatQuoteAge(ageMs: number): string {
  const seconds = Math.floor(ageMs / 1000);
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 90) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
