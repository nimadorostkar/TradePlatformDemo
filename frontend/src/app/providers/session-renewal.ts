import { TradingError } from '@/domain/common/errors';
import type { GatewayHttpClient } from '@/integrations/gateway/api/http-client';
import { serverTimeSchema } from '@/integrations/gateway/contracts/schemas';

/** Renew the gateway JWT before it expires so long-running terminals survive. */
export const SESSION_RENEW_SKEW_MS = 60_000;
export const SESSION_RENEW_RETRY_MS = 15_000;

/** How often a signed-in terminal actively verifies its JWT with the gateway. */
export const SESSION_VALIDATE_INTERVAL_MS = 20 * 60_000;

export type TokenValidity = 'valid' | 'invalid' | 'indeterminate';

/**
 * Asks the gateway whether the current JWT is still accepted, via the cheapest
 * authenticated route. Only a definitive 401 reports `invalid`: a network
 * failure or a server error proves nothing about the token, and treating it as
 * proof would sign a trader out over a dropped packet.
 */
export async function validateGatewayToken(
  http: GatewayHttpClient,
  signal?: AbortSignal,
): Promise<TokenValidity> {
  try {
    await http.request({
      endpoint: 'session-validate',
      path: '/api/Test/getServerTime',
      schema: serverTimeSchema,
      rawBody: true,
      tolerateUnauthorized: true,
      signal,
    });
    return 'valid';
  } catch (error) {
    if (error instanceof TradingError && error.kind === 'unauthorized') return 'invalid';
    return 'indeterminate';
  }
}

/**
 * Upper bound on a single timer hop.
 *
 * One long setTimeout is wrong twice over: the delay is a signed 32-bit int,
 * so anything above ~24.8 days OVERFLOWS AND FIRES IMMEDIATELY (a terminal
 * that signs in and then hammers the CRM in a renewal loop); and browsers
 * pause timers while a laptop sleeps, so even a legal multi-day delay drifts
 * by the length of every nap. Walking to the due time in bounded hops that
 * recompute against Date.now() on each hop caps both errors at one chunk.
 */
export const SESSION_RENEW_CHUNK_MS = 6 * 60 * 60 * 1000;

/**
 * Arms a timer that calls `onDue` `skewMs` before `expiresAt`, walking long
 * delays in chunks (see SESSION_RENEW_CHUNK_MS). Returns a cancel function,
 * or null for a token without a parseable expiry — such a token relies on the
 * gateway's authoritative 401 instead of inventing a lifetime.
 *
 * `minDelayMs` floors the final hop, so a malformed or unexpectedly short
 * replacement token cannot create a zero-delay renewal loop.
 */
export function armSessionRenewal(
  expiresAt: number | null,
  onDue: () => void,
  options: { skewMs?: number; chunkMs?: number; minDelayMs?: number; now?: () => number } = {},
): (() => void) | null {
  if (expiresAt === null) return null;
  const {
    skewMs = SESSION_RENEW_SKEW_MS,
    chunkMs = SESSION_RENEW_CHUNK_MS,
    minDelayMs = 0,
    now = Date.now,
  } = options;

  let timer: ReturnType<typeof setTimeout>;
  const arm = () => {
    const due = Math.max(minDelayMs, expiresAt - now() - skewMs);
    timer = due <= chunkMs ? setTimeout(onDue, due) : setTimeout(arm, chunkMs);
  };
  arm();
  return () => clearTimeout(timer);
}

/** A failed renewal is retryable only while the current JWT is still valid. */
export function canRetrySessionRenewal(expiresAt: number | null, now = Date.now()): boolean {
  return expiresAt !== null && now < expiresAt;
}
