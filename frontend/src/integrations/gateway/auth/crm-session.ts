import { z } from 'zod';
import { TradingError } from '@/domain/common/errors';
import {
  crmAccountListSchema,
  gatewayAccountSuffixListSchema,
  tokenResponseSchema,
  type GatewayAccountSuffixDto,
} from '../contracts/schemas';
import { mapCrmAccount, type AccountOption } from '../mappers/to-domain';
import { accountFundsOf, type AccountFunds } from '@/domain/account/account-environment';
import { suffixForAccountType } from '../mappers/symbol-suffix';
import {
  parseJwtAccounts,
  parseJwtExpiry,
  type AuthSession,
  type SessionTokens,
} from './auth-session';
import type { TokenStore } from './token-store';

/**
 * CRM-backed session.
 *
 * Verified flow:
 *   POST {gateway}/api/Authentication/crmlogin  { email, password }  → { token }
 *      (the gateway proxies {CRM}/client-api/login and returns the CRM token)
 *   POST {gateway}/api/Authentication/login  { Username, CRMToken }  → { token }
 *      (the gateway resolves CRM accounts and mints a JWT with an
 *       `accounts` claim — internal/domain/login.go; it also leaves the
 *       session in HttpOnly cookies)
 *   GET  {gateway}/api/Authentication/session → { token, crmToken?, username? }
 *      (cookie-authenticated; restores a reloaded session — AUTH-001)
 *   POST {CRM}/client-api/accounts?version=1.0.0  (CRM bearer)  → UserAccount[]
 *
 * The Authentication routes return bare JSON with 200 — they are NOT enveloped
 * (internal/httpapi/handlers/handlers.go).
 *
 * Gateway requests run with `credentials: 'same-origin'` so the login response
 * can store its HttpOnly cookies and /session can present them. Tokens still
 * live in memory for the app's own use — the cookies are the reload-survival
 * channel, unreadable to page scripts, and never a parallel auth scheme.
 */

export interface CrmSessionOptions {
  gatewayBaseUrl: string;
  crmBaseUrl: string;
  tokenStore: TokenStore;
  fetchImpl?: typeof fetch;
}

export class CrmAuthSession implements AuthSession {
  readonly kind = 'crm-login' as const;

  private readonly gatewayBaseUrl: string;
  private readonly crmBaseUrl: string;
  private readonly tokenStore: TokenStore;
  private readonly fetchImpl: typeof fetch;
  private accountsCache: { accounts: AccountOption[]; at: number } | null = null;
  // The trader's "keep me signed in" choice (MED-02). Every /login exchange —
  // including silent renewals — re-sets the gateway cookies, so the choice
  // must ride along each time or a renewal would silently upgrade a
  // session-only login to a 30-day one (or vice versa).
  private persist = false;

  constructor(options: CrmSessionOptions) {
    this.gatewayBaseUrl = options.gatewayBaseUrl.replace(/\/+$/, '');
    this.crmBaseUrl = options.crmBaseUrl.replace(/\/+$/, '');
    this.tokenStore = options.tokenStore;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  getTokens(): SessionTokens | null {
    return this.tokenStore.get();
  }

  /** Full email+password sign-in. */
  async signIn(
    email: string,
    password: string,
    options?: { remember?: boolean },
    signal?: AbortSignal,
  ): Promise<SessionTokens> {
    this.persist = options?.remember === true;
    const crmToken = await this.crmLogin(email, password, this.persist, signal);
    const tokens = await this.exchange(crmToken, email, signal);
    this.tokenStore.set(tokens);
    this.accountsCache = null;
    return tokens;
  }

  remembered(): boolean {
    return this.persist;
  }

  /**
   * Self-service registration against the CRM's user store. Creates the user
   * and one funded demo account; the caller then signs in normally. The CRM
   * is called directly (same-origin /crm), exactly like the account list.
   */
  async register(
    input: { email: string; password: string; name?: string } & Partial<ProfileInput>,
    signal?: AbortSignal,
  ): Promise<{ id: number; email: string; accounts: string[] }> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.crmBaseUrl}/client-api/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: input.email,
          password: input.password,
          name: input.name ?? '',
          // Optional profile details; the CRM validates and defaults them.
          ...(input.phone ? { phone: input.phone } : {}),
          ...(input.country ? { country: input.country } : {}),
          ...(input.city ? { city: input.city } : {}),
          ...(input.language ? { language: input.language } : {}),
          ...(input.timezone ? { timezone: input.timezone } : {}),
        }),
        signal,
        credentials: 'omit',
      });
    } catch (error) {
      throw TradingError.from(error);
    }
    const body = (await response.json().catch(() => ({}))) as {
      id?: number;
      email?: string;
      accounts?: Array<number | string>;
      error?: string;
    };
    if (response.status === 201 && typeof body.id === 'number') {
      return {
        id: body.id,
        email: body.email ?? input.email,
        accounts: (body.accounts ?? []).map(String),
      };
    }
    if (response.status === 409) {
      throw new TradingError({
        kind: 'validation',
        message: 'That email is already registered — sign in instead.',
        code: 'crm.register.conflict',
      });
    }
    if (response.status === 400) {
      throw new TradingError({
        kind: 'validation',
        message: body.error ?? 'Please check the details and try again.',
        code: 'crm.register.invalid',
      });
    }
    throw new TradingError({
      kind: 'unavailable',
      message: 'Could not create the account right now.',
      code: `crm.register.${response.status}`,
    });
  }

  /**
   * The signed-in user's CRM profile (GET /client-api/me). Distinct from the
   * trading account: this is the person, not the login.
   */
  async profile(signal?: AbortSignal): Promise<UserProfile> {
    const response = await this.crmFetch('/client-api/me', { method: 'GET', signal });
    return parseProfile(await response.json());
  }

  /** Replaces the user-editable profile fields (PUT /client-api/me). */
  async updateProfile(input: ProfileInput, signal?: AbortSignal): Promise<UserProfile> {
    const response = await this.crmFetch('/client-api/me', {
      method: 'PUT',
      body: JSON.stringify(input),
      signal,
    });
    return parseProfile(await response.json());
  }

  /** Changes the password; the CRM revokes every other session. */
  async changePassword(
    input: { currentPassword: string; newPassword: string },
    signal?: AbortSignal,
  ): Promise<void> {
    await this.crmFetch('/client-api/password', {
      method: 'POST',
      body: JSON.stringify(input),
      signal,
    });
  }

  /**
   * A CRM call with the session's bearer. Non-2xx answers become the
   * TradingError kinds the UI already knows how to show.
   */
  private async crmFetch(path: string, init: RequestInit): Promise<Response> {
    const tokens = this.tokenStore.get();
    if (!tokens?.crmToken) {
      throw new TradingError({
        kind: 'unauthorized',
        message: 'Sign in again to load your profile.',
        code: 'auth.no-crm-token',
      });
    }
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.crmBaseUrl}${path}`, {
        ...init,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens.crmToken}` },
        credentials: 'omit',
      });
    } catch (error) {
      throw TradingError.from(error);
    }
    if (response.ok) return response;
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    if (response.status === 401) {
      throw new TradingError({
        kind: 'unauthorized',
        message: 'Your session has expired — sign in again.',
        code: 'crm.profile.unauthorized',
      });
    }
    if (response.status === 400 || response.status === 403) {
      throw new TradingError({
        kind: 'validation',
        message: body.error ?? 'Please check the details and try again.',
        code: `crm.profile.${response.status}`,
      });
    }
    throw new TradingError({
      kind: 'unavailable',
      message: 'The profile service is not available right now.',
      code: `crm.profile.${response.status}`,
    });
  }

  /** Exchanges an externally-supplied CRM token (host bootstrap path). */
  async signInWithCrmToken(
    crmToken: string,
    username: string,
    signal?: AbortSignal,
  ): Promise<SessionTokens> {
    const tokens = await this.exchange(crmToken, username, signal);
    this.tokenStore.set(tokens);
    this.accountsCache = null;
    return tokens;
  }

  /**
   * Restores the session the gateway holds in its HttpOnly cookies (AUTH-001).
   * Returns null when there is none (or it expired) — the caller then falls
   * back to the host-bootstrap / sign-in flow. Never throws: a network error
   * during restore must degrade to "signed out", not crash the boot.
   */
  async restore(signal?: AbortSignal): Promise<{ username: string | null } | null> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.gatewayBaseUrl}/api/Authentication/session`, {
        method: 'GET',
        signal,
        credentials: 'same-origin',
      });
    } catch {
      return null;
    }
    // 204: the gateway's explicit "this browser has no session" — the normal
    // pre-login answer, distinct from a failed restoration (MED-10).
    if (response.status === 204) return null;
    if (!response.ok) return null;

    let parsed: { token?: unknown; crmToken?: unknown; username?: unknown; remembered?: unknown };
    try {
      parsed = (await response.json()) as typeof parsed;
    } catch {
      return null;
    }
    if (typeof parsed.token !== 'string' || parsed.token === '') return null;
    // The gateway reports the original remember-me choice so renewals keep it.
    this.persist = parsed.remembered === true;

    // A session without its CRM token cannot list accounts (and so cannot
    // resolve the symbol-suffix policy) — restoring it would boot the trader
    // into a terminal that can only fail. Treat it as "no session" and clear
    // the server's half so the next visit starts clean at sign-in.
    const crmToken =
      typeof parsed.crmToken === 'string' && parsed.crmToken !== '' ? parsed.crmToken : null;
    if (crmToken === null) {
      void this.fetchImpl(`${this.gatewayBaseUrl}/api/Authentication/logout`, {
        method: 'POST',
        credentials: 'same-origin',
      }).catch(() => {});
      return null;
    }

    this.tokenStore.set({
      gatewayToken: parsed.token,
      crmToken,
      expiresAt: parseJwtExpiry(parsed.token),
    });
    this.accountsCache = null;
    return { username: typeof parsed.username === 'string' ? parsed.username : null };
  }

  async renew(signal?: AbortSignal): Promise<SessionTokens | null> {
    const current = this.tokenStore.get();
    // No refresh endpoint exists. Without a CRM token there is nothing to
    // exchange, and reauthentication is the only correct answer.
    if (!current?.crmToken) return null;

    try {
      const tokens = await this.exchange(current.crmToken, '', signal);
      this.tokenStore.set(tokens);
      // A renewed JWT can carry a different account claim after a permission
      // change. Never reuse a list filtered against the previous token.
      this.accountsCache = null;
      return tokens;
    } catch {
      return null;
    }
  }

  async listAccounts(signal?: AbortSignal): Promise<AccountOption[]> {
    // The account list changes rarely; a short cache avoids re-fetching on
    // every reconnect without risking a stale trading permission.
    if (this.accountsCache && Date.now() - this.accountsCache.at < 60_000) {
      return this.accountsCache.accounts;
    }

    const tokens = this.tokenStore.get();
    if (!tokens?.crmToken) {
      throw new TradingError({
        kind: 'unauthorized',
        message: 'Sign in again to load your trading accounts.',
        code: 'auth.no-crm-token',
      });
    }

    // The CRM list and the gateway suffix map share only the CRM token, and
    // measured cold loads put the CRM call at a 5.3–6.4 s FLOOR with the
    // gateway call bimodal at 100 ms / 6 s. Awaited in series they stacked to
    // ~12 s of blank terminal; in parallel the wait is the slower of the two.
    const gatewaySuffixesPromise = this.fetchGatewaySuffixes(tokens.crmToken, signal);

    const response = await this.fetchImpl(`${this.crmBaseUrl}/client-api/accounts?version=1.0.0`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokens.crmToken}`,
      },
      body: '{}',
      signal,
      credentials: 'omit',
    });

    if (response.status === 401) {
      throw new TradingError({
        kind: 'unauthorized',
        message: 'Your session has expired. Please sign in again.',
        code: 'crm.401',
      });
    }
    if (!response.ok) {
      throw new TradingError({
        kind: 'unavailable',
        message: 'Could not load your trading accounts.',
        code: `crm.${response.status}`,
      });
    }

    const parsed = crmAccountListSchema.safeParse(await response.json());
    if (!parsed.success) {
      throw new TradingError({
        kind: 'contract',
        message: 'The account service returned unexpected data.',
        code: 'contract.crm-accounts',
        detail: parsed.error.issues
          .slice(0, 3)
          .map((i) => i.message)
          .join('; '),
      });
    }

    // The gateway's per-deployment CRM_ACCOUNT_TYPE_SUFFIXES configuration is
    // the authority on which symbol suffix each account group speaks. The
    // built-in type map is only the fallback — it encodes ONE broker's
    // convention, and a group it gets wrong shows "no price available" on
    // every symbol (Social PRO, live QA 2026-08-14). Tolerant: an older
    // gateway without the endpoint simply leaves the fallback in charge.
    // (Started above, before the CRM fetch — see gatewaySuffixesPromise.)
    const gatewaySuffixes = await gatewaySuffixesPromise;

    // Filters, all required:
    //   1. some source must KNOW the account's suffix policy, else we would
    //      send wrong symbol names to MT5;
    //   2. the login must be in the gateway JWT's `accounts` claim, else every
    //      account-scoped call returns 403.
    //
    // NOTE deliberately absent: re-issuing the gateway JWT per account. The
    // token's `accounts` claim covers every subaccount at once (the gateway's
    // HasAccount check authorizes any login in the claim), so an account
    // switch needs no token renewal — renewal happens on expiry only.
    const claimed = new Set(parseJwtAccounts(tokens.gatewayToken));
    const accounts = parsed.data
      .map(mapCrmAccount)
      .map((a) => ({
        ...a,
        suffix: resolveSuffix(a, gatewaySuffixes),
        kind: resolveKind(a, gatewaySuffixes),
      }))
      .filter((a) => a.suffix !== null)
      .filter((a) => a.enabled)
      // Missing/malformed claims own no accounts. Falling back to every CRM
      // account leaks unusable account metadata and contradicts the gateway's
      // fail-closed AccountsAuthorize middleware.
      .filter((a) => claimed.has(a.login));

    this.accountsCache = { accounts, at: Date.now() };
    return accounts;
  }

  /**
   * Fetches the gateway's authoritative per-account symbol suffixes, keyed by
   * login. Null when the deployment does not serve the endpoint (older
   * gateway) or the request fails — never an exception: the account list must
   * load on the fallback map rather than not at all.
   */
  private async fetchGatewaySuffixes(
    crmToken: string,
    signal?: AbortSignal,
  ): Promise<Map<string, GatewayAccountSuffixDto> | null> {
    try {
      const response = await this.fetchImpl(`${this.gatewayBaseUrl}/api/Authentication/accounts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ CRMToken: crmToken }),
        signal,
        credentials: 'omit',
      });
      // 204: the gateway's explicit "this browser has no session" — the normal
      // pre-login answer, distinct from a failed restoration (MED-10).
      if (response.status === 204) return null;
      if (!response.ok) return null;

      const parsed = gatewayAccountSuffixListSchema.safeParse(await response.json());
      if (!parsed.success || !parsed.data.data) return null;
      return new Map(parsed.data.data.map((entry) => [entry.login, entry]));
    } catch {
      return null;
    }
  }

  signOut(): void {
    this.tokenStore.clear();
    this.accountsCache = null;
    // Clear the server-held cookies too, or the next reload on this browser
    // would silently restore the session that was just signed out of.
    // Fire-and-forget: local sign-out must not depend on the network.
    void this.fetchImpl(`${this.gatewayBaseUrl}/api/Authentication/logout`, {
      method: 'POST',
      credentials: 'same-origin',
    }).catch(() => {});
  }

  // ── internals ──────────────────────────────────────────────────────────────

  // The remember choice has to ride on THIS request as well as the /login
  // exchange below. The CRM token minted here is what every later restore
  // re-presents to re-mint the 30-minute gateway JWT, so a CRM token issued
  // for a short session ends the 30-day cookie early — as a password prompt.
  private async crmLogin(
    email: string,
    password: string,
    remember: boolean,
    signal?: AbortSignal,
  ): Promise<string> {
    const token = await this.postForToken(
      `${this.gatewayBaseUrl}/api/Authentication/crmlogin`,
      { email, password, Remember: remember },
      signal,
      'Incorrect email or password.',
    );
    return token;
  }

  private async exchange(
    crmToken: string,
    username: string,
    signal?: AbortSignal,
  ): Promise<SessionTokens> {
    // Field names are PascalCase to match the gateway's userLoginBody struct
    // tags (`Username`, `Password`, `CRMToken`).
    const gatewayToken = await this.postForToken(
      `${this.gatewayBaseUrl}/api/Authentication/login`,
      { Username: username, Password: '', CRMToken: crmToken, Remember: this.persist },
      signal,
      'Your account could not be authorised for trading.',
    );

    return {
      gatewayToken,
      crmToken,
      expiresAt: parseJwtExpiry(gatewayToken),
    };
  }

  private async postForToken(
    url: string,
    body: Record<string, string | boolean>,
    signal: AbortSignal | undefined,
    unauthorizedMessage: string,
  ): Promise<string> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
        // same-origin (not omit): the login response sets the HttpOnly session
        // cookies that make a reload survivable. Cross-origin requests still
        // carry nothing.
        credentials: 'same-origin',
      });
    } catch (error) {
      throw new TradingError({
        kind: 'network',
        message: 'Cannot reach the trading server.',
        code: 'auth.network',
        detail: error instanceof Error ? error.message : String(error),
      });
    }

    if (response.status === 401) {
      throw new TradingError({
        kind: 'unauthorized',
        message: unauthorizedMessage,
        code: 'auth.401',
        retryable: false,
      });
    }
    if (!response.ok) {
      throw new TradingError({
        kind: 'unavailable',
        message: 'Sign-in is temporarily unavailable.',
        code: `auth.${response.status}`,
      });
    }

    const parsed = tokenResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      throw new TradingError({
        kind: 'contract',
        message: 'The sign-in service returned unexpected data.',
        code: 'contract.auth-token',
      });
    }
    return parsed.data.token;
  }
}

/**
 * One account's symbol suffix, from the strongest source that KNOWS it:
 * the gateway's deployment configuration first, the built-in type map second,
 * null when neither does. `suffixKnown: false` from the gateway is treated as
 * silence, not as an answer — the operator has not configured that type yet,
 * and the fallback map keeps the account usable exactly as before.
 */
function resolveSuffix(
  account: AccountOption,
  gatewaySuffixes: Map<string, { suffix: string; suffixKnown: boolean }> | null,
): string | null {
  const fromGateway = gatewaySuffixes?.get(account.login);
  if (fromGateway?.suffixKnown) return fromGateway.suffix;
  return suffixForAccountType(account.typeId);
}

/**
 * Whether the account holds real money, as STATED by the gateway.
 *
 * The CRM list does not carry it and MT5 cannot answer it (see
 * domain/account/account-environment). The gateway's per-login answer — the
 * same one that already supplies the symbol suffix — is the only source, and
 * an account it says nothing about stays `unknown`, which shows no badge.
 */
function resolveKind(
  account: AccountOption,
  gatewaySuffixes: Map<string, GatewayAccountSuffixDto> | null,
): AccountFunds {
  return accountFundsOf(gatewaySuffixes?.get(account.login)?.accountKind);
}

/** The user-editable part of the CRM profile. */
export interface ProfileInput {
  name: string;
  phone: string;
  /** ISO 3166-1 alpha-2, or '' when not given. */
  country: string;
  city: string;
  /** BCP 47 tag ('en'). */
  language: string;
  /** IANA zone ('UTC'). */
  timezone: string;
}

export type KycStatus = 'unverified' | 'pending' | 'verified';

export interface UserProfile extends ProfileInput {
  id: number;
  email: string;
  kycStatus: KycStatus;
  createdAt: string;
  updatedAt: string | null;
}

const profileSchema = z.object({
  id: z.number(),
  email: z.string(),
  name: z.string().default(''),
  phone: z.string().default(''),
  country: z.string().default(''),
  city: z.string().default(''),
  language: z.string().default('en'),
  timezone: z.string().default('UTC'),
  kycStatus: z.enum(['unverified', 'pending', 'verified']).catch('unverified'),
  createdAt: z.string(),
  updatedAt: z.string().nullish(),
});

function parseProfile(raw: unknown): UserProfile {
  const parsed = profileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new TradingError({
      kind: 'contract',
      message: 'The profile service answered in an unexpected shape.',
      code: 'crm.profile.shape',
    });
  }
  return { ...parsed.data, updatedAt: parsed.data.updatedAt ?? null };
}
