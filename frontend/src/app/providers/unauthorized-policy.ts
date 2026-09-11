import type { TradingError } from '@/domain/common/errors';
import type { UnauthorizedHandler } from '@/integrations/gateway/api/http-client';

/**
 * What a gateway 401 means for the session.
 *
 * A 401 says the gateway rejected THAT credential. It does not say the trader
 * must sign in again: the gateway has no refresh endpoint, but a still-valid
 * CRM token can mint a replacement JWT, and the ways a live token dies —
 * a rotated signing secret, a server-side invalidation — leave the CRM session
 * untouched. Signing out on the first 401 throws away a session that one
 * silent exchange would have saved.
 *
 * This is the same policy the periodic validation in `AuthenticatedApp`
 * already applies (see SESSION_VALIDATE_INTERVAL_MS): one silent renewal, and
 * only a failed renewal ends the session. It lived in only one of the two
 * places a dead token is discovered, so which path noticed first decided
 * whether the trader was offered a renewal or a sign-in screen.
 *
 * Three rules keep that from becoming a renewal loop against the CRM:
 *
 *   - a 401 answering a credential the session no longer holds is IGNORED.
 *     It was in flight across a renewal or an account switch and proves
 *     nothing about the token now in hand;
 *   - concurrent 401s share ONE attempt. A dead session fails every open
 *     request at once, and that must not become a dozen exchanges;
 *   - each credential is renewed at most ONCE. A 401 on the very token a
 *     silent renewal just produced means renewing did not help, so the
 *     session is over.
 */
export interface UnauthorizedPolicyOptions {
  /** The credential the session holds right now, or null when signed out. */
  currentToken: () => string | null;
  /** One renewal attempt, resolving to the replacement JWT or null. */
  renew: () => Promise<string | null>;
  /** Called once the session is definitively over. */
  onExpired: (error: TradingError) => void;
}

export function createUnauthorizedHandler(options: UnauthorizedPolicyOptions): UnauthorizedHandler {
  const { currentToken, renew, onExpired } = options;

  let inFlight: Promise<string | null> | null = null;
  let renewedInto: string | null = null;

  return (error, rejectedToken) => {
    // A request carrying no credential at all cannot be answered by renewing
    // one; it is a bug or a sign-out race, and the session it belongs to is
    // already gone.
    if (rejectedToken === null) {
      onExpired(error);
      return;
    }

    // Rule 1: stale credential, already replaced. Say nothing.
    if (rejectedToken !== currentToken()) return;

    // Rule 3: this token IS a silent renewal's output and the gateway still
    // refuses it. Renewing again would only repeat the exchange.
    if (rejectedToken === renewedInto) {
      onExpired(error);
      return;
    }

    // Rule 2: one attempt, shared by every 401 in the burst.
    inFlight ??= renew()
      // `renew` reports failure by resolving null, but a handler that can be
      // skipped by an unexpected throw would strand the session in limbo.
      .catch(() => null)
      .finally(() => {
        inFlight = null;
      });

    void inFlight.then((replacement) => {
      if (replacement === null) {
        onExpired(error);
        return;
      }
      renewedInto = replacement;
    });
  };
}
