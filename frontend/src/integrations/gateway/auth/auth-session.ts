import type { AccountOption } from '../mappers/to-domain';

/**
 * Authentication is expressed as an interface with swappable adapters, because
 * this platform can run standalone (it owns the login screen) or be launched
 * from an existing TradePlatform client (it receives a session).
 *
 * Only flows VERIFIED in the two reference repositories are implemented:
 *   1. CRM login  → POST {gateway}/api/Authentication/crmlogin
 *   2. JWT exchange → POST {gateway}/api/Authentication/login  { Username, CRMToken }
 *   3. Host bootstrap via postMessage, origin-allowlisted
 *
 * There is deliberately NO refresh-token flow. The gateway has no refresh
 * endpoint (verified in internal/httpapi/handlers/mount.go — only /login and
 * /crmlogin exist). When the gateway JWT expires we re-run the CRM exchange if
 * we still hold a CRM token, otherwise we require reauthentication.
 */

export interface SessionTokens {
  /** Gateway JWT used as REST Bearer auth and in the WS credential subprotocol. */
  gatewayToken: string;
  /** CRM access token, needed to list accounts and to re-mint the gateway JWT. */
  crmToken: string | null;
  /** Local expiry estimate parsed from the JWT — for UX only. */
  expiresAt: number | null;
}

export interface AuthSession {
  readonly kind: 'crm-login' | 'host-bootstrap';
  getTokens(): SessionTokens | null;
  /** Lists the MT5 accounts this session may trade. */
  listAccounts(signal?: AbortSignal): Promise<AccountOption[]>;
  /**
   * Re-mints the gateway JWT. Returns null when reauthentication is required
   * (no CRM token available) rather than pretending a refresh exists.
   */
  renew(signal?: AbortSignal): Promise<SessionTokens | null>;
  signOut(): void;
  /** Whether this session was created with "keep me signed in" (MED-02). */
  remembered?(): boolean;
}

/**
 * Parses a JWT's `exp` for UX only (proactive re-auth prompts).
 * The backend remains authoritative — a token this parser considers valid can
 * still be rejected, and that rejection is what the app acts on.
 */
export function parseJwtExpiry(token: string): number | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const payload = parts[1];
  if (!payload) return null;
  try {
    const json = JSON.parse(base64UrlDecode(payload)) as { exp?: unknown };
    if (typeof json.exp !== 'number') return null;
    return json.exp * 1000;
  } catch {
    return null;
  }
}

/** Reads the `accounts` claim so the UI can pre-filter unusable logins. */
export function parseJwtAccounts(token: string): string[] {
  const parts = token.split('.');
  const payload = parts[1];
  if (parts.length !== 3 || !payload) return [];
  try {
    const json = JSON.parse(base64UrlDecode(payload)) as { accounts?: unknown };
    if (typeof json.accounts !== 'string' || json.accounts === '') return [];
    return json.accounts
      .split(',')
      .map((a) => a.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function base64UrlDecode(value: string): string {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
  const binary = atob(padded);
  // Decode as UTF-8 — a JWT payload can legitimately contain non-ASCII.
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function isExpired(expiresAt: number | null, skewMs = 30_000): boolean {
  if (expiresAt === null) return false;
  return Date.now() + skewMs >= expiresAt;
}
