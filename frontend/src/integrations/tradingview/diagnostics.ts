/**
 * Production-safe TradingView integration diagnostics.
 *
 * When chart trading or the DOM is unavailable, the widget just renders
 * without those affordances — nothing in the UI says WHY. That turned a stale
 * deployment into a multi-hour QA cycle. These helpers put the gating values
 * (and only the gating values) on the console: booleans, connection states,
 * capability flags, and symbol names. Never tokens, logins, balances, or any
 * other account data.
 *
 * Healthy states log NOTHING — silence means every gate was open, so a single
 * warning line is meaningful rather than lost in noise.
 */

const PREFIX = '[tradingview]';

/** De-duplicates repeated identical warnings (e.g. per-poll or per-call). */
const lastReported = new Map<string, string>();

/**
 * Warns once per distinct payload for a given diagnostic key. A repeat of the
 * SAME degraded state stays quiet; a change (different reason, recovery then
 * re-degradation) reports again.
 */
export function warnOnce(key: string, message: string, details: Record<string, unknown>): void {
  const payload = JSON.stringify(details);
  if (lastReported.get(key) === payload) return;
  lastReported.set(key, payload);
  console.warn(PREFIX, message, details);
}

/** Clears a key so the next degradation reports even if identical. */
export function clearDiagnostic(key: string): void {
  lastReported.delete(key);
}
