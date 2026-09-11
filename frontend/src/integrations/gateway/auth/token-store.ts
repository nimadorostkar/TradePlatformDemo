import type { SessionTokens } from './auth-session';

/**
 * Token storage.
 *
 * DEFAULT: in memory only. Tokens do not survive a reload, which is the right
 * trade-off for a real-money terminal — any XSS that can read localStorage can
 * lift a persisted gateway JWT and trade with it.
 *
 * LEGACY MODE: the existing TradingView integration keeps `token` and
 * `crm_token` in localStorage, and an embedding host may still write them
 * there. That behaviour is available behind VITE_ENABLE_LEGACY_AUTH_STORAGE,
 * defaults OFF, and is REFUSED in production by the env validator.
 *
 * We do not describe either option as "secure". The honest statement is in
 * docs/architecture/frontend-architecture.md#auth-storage: browser storage is
 * readable by any script in the origin.
 *
 * The token no longer reaches any URL. WebSocket authentication moved to the
 * `opotrade.jwt.<JWT>` subprotocol, so the credential is not in the connect
 * URL, browser history, referrers, or proxy access logs.
 */

const LEGACY_GATEWAY_TOKEN_KEY = 'token';
const LEGACY_CRM_TOKEN_KEY = 'crm_token';

export interface TokenStoreOptions {
  /** Mirror to localStorage under the legacy keys. Never enable in production. */
  legacyStorage: boolean;
  storage?: Storage;
}

export class TokenStore {
  private tokens: SessionTokens | null = null;
  private readonly legacyStorage: boolean;
  private readonly storage: Storage | null;
  private readonly listeners = new Set<(tokens: SessionTokens | null) => void>();

  constructor(options: TokenStoreOptions) {
    this.legacyStorage = options.legacyStorage;
    this.storage = options.storage ?? (typeof localStorage === 'undefined' ? null : localStorage);

    if (this.legacyStorage) {
      this.tokens = this.readLegacy();
    } else {
      // One-time hygiene: builds from before the legacy flag (and any run with
      // it enabled) persisted the JWT — with the full account-id claim — under
      // these keys, and nothing ever deleted it. With legacy mode off the app
      // ignores the value, but an expired token enumerating every subaccount
      // is still a gift to any XSS or shared-profile snoop, so purge it.
      this.purgeLegacy();
    }
  }

  private purgeLegacy(): void {
    if (!this.storage) return;
    try {
      this.storage.removeItem(LEGACY_GATEWAY_TOKEN_KEY);
      this.storage.removeItem(LEGACY_CRM_TOKEN_KEY);
    } catch {
      // Storage can be blocked entirely (private mode, embedded webview).
    }
  }

  get(): SessionTokens | null {
    return this.tokens;
  }

  /** The value handed to the HTTP client and the WebSocket pool. */
  gatewayToken(): string | null {
    return this.tokens?.gatewayToken ?? null;
  }

  set(tokens: SessionTokens | null): void {
    this.tokens = tokens;
    if (this.legacyStorage) this.writeLegacy(tokens);
    for (const listener of this.listeners) listener(tokens);
  }

  clear(): void {
    this.set(null);
  }

  subscribe(listener: (tokens: SessionTokens | null) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private readLegacy(): SessionTokens | null {
    if (!this.storage) return null;
    try {
      const gatewayToken = this.storage.getItem(LEGACY_GATEWAY_TOKEN_KEY);
      if (!gatewayToken) return null;
      return {
        gatewayToken,
        crmToken: this.storage.getItem(LEGACY_CRM_TOKEN_KEY),
        expiresAt: null,
      };
    } catch {
      // Storage can be blocked entirely (private mode, embedded webview).
      return null;
    }
  }

  private writeLegacy(tokens: SessionTokens | null): void {
    if (!this.storage) return;
    try {
      if (tokens === null) {
        this.storage.removeItem(LEGACY_GATEWAY_TOKEN_KEY);
        this.storage.removeItem(LEGACY_CRM_TOKEN_KEY);
        return;
      }
      this.storage.setItem(LEGACY_GATEWAY_TOKEN_KEY, tokens.gatewayToken);
      if (tokens.crmToken) this.storage.setItem(LEGACY_CRM_TOKEN_KEY, tokens.crmToken);
    } catch {
      // A full or blocked quota must not break an authenticated session.
    }
  }
}
