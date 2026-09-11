import { TradingError } from '@/domain/common/errors';
import { parseJwtAccounts, type AuthSession } from '@/integrations/gateway/auth/auth-session';
import { useSessionStore } from '@/stores/session-store';

/**
 * Switches the active trading account behind a FRESH gateway JWT.
 *
 * One JWT's `accounts` claim covers every subaccount, so the switch would
 * work on the existing token — but each switch still renews (QA 2026-08-14):
 *
 *   - the token's expiry extends, so a long session hopping between accounts
 *     never runs into a mid-trade expiry; and
 *   - the TARGET account's authorization is re-checked NOW against the CRM,
 *     not as of the last sign-in — a login revoked since then fails the
 *     switch cleanly instead of failing every account call afterwards.
 *
 * Sequence: renew (`POST /api/Authentication/login` with the CRM token) →
 * verify the replacement token's claim contains the target login → store it
 * (the TokenStore listeners replace every authenticated WebSocket with the
 * new credential) → activate the account, which resets and resynchronises
 * account state through the existing switch machinery. Trading pauses
 * naturally across the switch: the streams drop to idle and the TradingView
 * broker reports Connecting until the new account's state is live.
 *
 * On ANY failure the switch is CANCELLED: the current account stays active on
 * the current (still valid) token, and the thrown error is surfaced by the
 * caller. A failed renewal must never strand the trader between accounts.
 */
export async function switchTradingAccount(auth: AuthSession, login: string): Promise<void> {
  const renewed = await auth.renew();
  if (!renewed) {
    throw new TradingError({
      kind: 'unavailable',
      message:
        'Your session could not be refreshed for the account switch. The current account remains active — please try again.',
      code: 'auth.switch-renewal',
    });
  }

  if (!parseJwtAccounts(renewed.gatewayToken).includes(login)) {
    throw new TradingError({
      kind: 'forbidden',
      message: 'Your session does not authorize this account.',
      code: 'auth.switch-unauthorized',
      retryable: false,
    });
  }

  useSessionStore.getState().setActiveAccount(login);
}
