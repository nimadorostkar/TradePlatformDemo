import { TradingError } from '@/domain/common/errors';
import { z } from 'zod';

/**
 * Host session bootstrap.
 *
 * When this terminal is embedded in the existing OpoFinance client (web or
 * React-Native webview), the host supplies the CRM token via `postMessage`.
 *
 * Two hard rules:
 *   1. The message origin MUST be in the configured allowlist. An unvalidated
 *      postMessage handler is a credential-injection hole: any page that can
 *      frame us could hand us an attacker's session, or read ours back.
 *   2. Tokens are NEVER accepted from URL query parameters. A URL leaks into
 *      history, referrers, and server logs.
 */

const hostMessageSchema = z.object({
  type: z.literal('opotrade:session'),
  crmToken: z.string().min(16),
  username: z.string().max(320).optional(),
});

const FORBIDDEN_CREDENTIAL_PARAMS = ['token', 'access_token', 'crm_token', 'crmToken', 'jwt'];

export type HostSessionMessage = z.infer<typeof hostMessageSchema>;

export interface HostBootstrapOptions {
  allowedOrigins: readonly string[];
  timeoutMs?: number;
  target?: Window;
}

/**
 * Waits for a host session message. Resolves null on timeout, which simply
 * means "no host is present" and the app should show its own login screen.
 */
export function awaitHostSession(
  options: HostBootstrapOptions,
): Promise<HostSessionMessage | null> {
  const { allowedOrigins, timeoutMs = 3_000 } = options;
  const target = options.target ?? (typeof window === 'undefined' ? null : window);

  if (!target || allowedOrigins.length === 0) return Promise.resolve(null);

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve(null);
    }, timeoutMs);

    const onMessage = (event: MessageEvent) => {
      // Origin check FIRST, before the payload is even looked at.
      if (!allowedOrigins.includes(event.origin)) return;

      const parsed = hostMessageSchema.safeParse(event.data);
      if (!parsed.success) return;

      cleanup();
      resolve(parsed.data);
    };

    function cleanup() {
      clearTimeout(timer);
      target?.removeEventListener('message', onMessage);
    }

    target.addEventListener('message', onMessage);

    // Announce readiness to the opener/parent so the host knows to send.
    try {
      for (const origin of allowedOrigins) {
        target.parent?.postMessage({ type: 'opotrade:ready' }, origin);
        target.opener?.postMessage({ type: 'opotrade:ready' }, origin);
      }
    } catch {
      // Cross-origin restrictions on parent/opener are expected and harmless.
    }
  });
}

/** Rejects any attempt to pass a credential through the URL. */
export function assertNoTokenInUrl(search: string): void {
  const params = new URLSearchParams(search);
  for (const forbidden of FORBIDDEN_CREDENTIAL_PARAMS) {
    if (params.has(forbidden)) {
      throw new TradingError({
        kind: 'validation',
        code: 'auth.token-in-url',
        message: 'Sign-in could not be completed securely. Please open the terminal again.',
        detail: `credential parameter "${forbidden}" was present in the URL and was ignored`,
        retryable: false,
      });
    }
  }
}

/** Removes rejected credential parameters without discarding benign UI state. */
export function sanitizedCredentialUrl(href: string): string {
  const url = new URL(href);
  for (const forbidden of FORBIDDEN_CREDENTIAL_PARAMS) url.searchParams.delete(forbidden);
  return `${url.pathname}${url.search}${url.hash}`;
}
