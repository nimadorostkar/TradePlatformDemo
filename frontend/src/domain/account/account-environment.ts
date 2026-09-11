/**
 * What kind of money an account holds — and, crucially, whether we know.
 *
 * The terminal badged every account "LIVE" because it read one deployment-wide
 * `TRADING_MODE` variable: a statement about the SERVER, rendered on the screen
 * where orders are placed, where it reads as a statement about the ACCOUNT.
 *
 * The 2026-08-26 retest called the unsafe default the actual defect, and it is
 * right. A client placing an order on a demo account believing it is real
 * money — or the reverse — is a misrepresentation either way, and "LIVE" is
 * the guess that cannot be walked back. So there is no guess: an account whose
 * kind the server has not stated is `unknown`, and `unknown` renders NO badge.
 *
 * Why this is not derived in the client:
 *
 *   MT5 cannot answer it. Fetching `/api/group/get` for a demo-signature group
 *   (`Opoforex\ECNPRO-APP-SF-USD-B`) and a live one (`Opoforex\ECNPRO-USD-B`)
 *   on 2026-08-26 returned configurations identical in EVERY field — same
 *   PermissionsFlags, same Company, same ten symbol paths, same swap settings.
 *   Only the group NAME differs. There is no demo flag on an MT5 group here,
 *   and none on an MT5 user either (`Rights` encodes trade-disabled and
 *   investor, never demo).
 *
 *   That leaves the group name, and matching it in the client is exactly what
 *   must not happen: "-SF-" is a convention whose meaning lives in the broker's
 *   product catalogue, it is equally readable as "swap-free", and it would
 *   mislabel silently the day a group is renamed.
 *
 * So the server states it, per account, on the account list, and the client
 * only renders what it is told.
 */

export type AccountFunds = 'demo' | 'live' | 'unknown';

/**
 * Narrows whatever the gateway sent into a kind we will render.
 *
 * Anything unrecognised — absent, null, empty, a typo, a value from a newer
 * gateway — becomes `unknown`. Never `live`.
 */
export function accountFundsOf(accountKind: unknown): AccountFunds {
  if (typeof accountKind !== 'string') return 'unknown';
  const value = accountKind.trim().toLowerCase();
  if (value === 'demo') return 'demo';
  if (value === 'live') return 'live';
  return 'unknown';
}

/** Whether a badge should be rendered at all. `unknown` says nothing. */
export function hasBadge(funds: AccountFunds): boolean {
  return funds !== 'unknown';
}

export const FUNDS_LABEL: Record<Exclude<AccountFunds, 'unknown'>, string> = {
  demo: 'DEMO',
  live: 'LIVE',
};

/**
 * Demo gets its own colour token, not merely different text — the retest asked
 * for a visually distinct treatment, and two words in the same amber differ by
 * one glance's worth of attention.
 */
export const FUNDS_TONE: Record<Exclude<AccountFunds, 'unknown'>, 'warning' | 'info'> = {
  demo: 'info',
  live: 'warning',
};

export const FUNDS_DESCRIPTION: Record<AccountFunds, string> = {
  demo: 'Demo funds',
  live: 'REAL MONEY',
  unknown: 'Account type not confirmed by the trading server',
};
