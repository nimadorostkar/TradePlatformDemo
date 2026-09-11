import type { MarketApi } from './api/market-api';
import { SUFFIX_DELIMITERS } from './mappers/symbol-suffix';

/**
 * Empirical verification of an account's symbol suffix.
 *
 * The suffix reaches the client as configuration — the gateway's deployment
 * env, or the built-in type map — and a wrong one is invisible until every
 * chart and panel dies: MT5's tick paths answer LENIENTLY for a non-existent
 * suffixed name (base-symbol ticks under an echoed label), while its history
 * path answers STRICTLY with an empty list. That strictness makes history the
 * one cheap witness of whether a symbol dialect truly exists on the account's
 * server. The probe asks for two weeks of DAILY bars (a handful of rows,
 * weekend-proof) per candidate dialect.
 *
 * Outcomes:
 *  - `ok` — the configured dialect serves history; nothing to do.
 *  - `corrected` (suffix '') — HARD evidence: the configured suffixed name
 *    serves no history while the bare stem does. Bare is the only correction
 *    ever made automatically, because several suffixed dialects can coexist
 *    server-wide (each group's) and history alone cannot say which one this
 *    ACCOUNT trades; the bare stem carries no such ambiguity.
 *  - `misconfigured` — the configured dialect is dead but some OTHER suffixed
 *    dialect lives. Choosing it automatically could chart another group's
 *    prices, so this is reported, never adopted: the deployment's
 *    CRM_ACCOUNT_TYPE_SUFFIXES needs the correct entry for this account type.
 *  - `indeterminate` — network failure, or no dialect of the canonical symbol
 *    serves history at all. Changes nothing.
 */

export type SuffixProbeResult =
  | { outcome: 'ok' }
  | { outcome: 'corrected'; suffix: '' }
  | { outcome: 'misconfigured'; configured: string; alive: string[] }
  | { outcome: 'indeterminate' };

/** Universally-listed FX instrument used to test a symbol dialect. */
const PROBE_STEM = 'EURUSD';
const PROBE_WINDOW_SECONDS = 14 * 86_400;

export async function probeSuffix(
  market: MarketApi,
  suffix: string,
  signal?: AbortSignal,
): Promise<SuffixProbeResult> {
  const to = Math.floor(Date.now() / 1000);
  const from = to - PROBE_WINDOW_SECONDS;
  const bars = (symbol: string) =>
    market.dailyBars({ symbol, from, to, resolution: '1D' }, signal).catch(() => null);

  const configured = await bars(PROBE_STEM + suffix);
  // Null: indeterminate (never act on a network failure). Non-empty: real.
  if (configured === null) return { outcome: 'indeterminate' };
  if (configured.length > 0) return { outcome: 'ok' };

  // The configured dialect is confirmed dead. Find who is alive.
  const bare = suffix === '' ? configured : await bars(PROBE_STEM);
  if (bare !== null && bare.length > 0) return { outcome: 'corrected', suffix: '' };

  const alive: string[] = [];
  for (const delimiter of SUFFIX_DELIMITERS) {
    if (delimiter === suffix) continue;
    const answer = await bars(PROBE_STEM + delimiter);
    if (answer !== null && answer.length > 0) alive.push(delimiter);
  }
  if (alive.length > 0) return { outcome: 'misconfigured', configured: suffix, alive };

  return { outcome: 'indeterminate' };
}
