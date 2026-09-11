import { describe, expect, it, vi } from 'vitest';
import { TokenStore } from './token-store';
import { CrmAuthSession } from './crm-session';

function jwt(accounts?: string, expiresAt = Date.now() + 60 * 60_000): string {
  const payload = btoa(
    JSON.stringify({ ...(accounts === undefined ? {} : { accounts }), exp: expiresAt / 1000 }),
  )
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `header.${payload}.signature`;
}

function account(login: string) {
  return {
    login,
    currency: 'USD',
    isEnabled: true,
    isReadOnly: false,
    type: { id: 57, description: 'ECN', server: 'Broker-Live', platform: 'MT5' },
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('CrmAuthSession account authorization', () => {
  it('fails closed when the gateway JWT has no accounts claim', async () => {
    const store = new TokenStore({ legacyStorage: false });
    store.set({ gatewayToken: jwt(), crmToken: 'crm-token', expiresAt: null });
    // A fresh Response per call: the CRM list and the gateway suffix lookup
    // now run in PARALLEL, so a single shared body would be read twice. The
    // suffix route failing to parse this payload degrades to the fallback
    // map, exactly as a gateway without the endpoint would.
    const fetchImpl = vi
      .fn()
      .mockImplementation(() => Promise.resolve(jsonResponse([account('1010')])));
    const session = new CrmAuthSession({
      gatewayBaseUrl: 'https://trade.example/gateway',
      crmBaseUrl: 'https://trade.example/crm',
      tokenStore: store,
      fetchImpl,
    });

    await expect(session.listAccounts()).resolves.toEqual([]);
  });

  it('exposes only logins present in the signed gateway claim', async () => {
    const store = new TokenStore({ legacyStorage: false });
    store.set({ gatewayToken: jwt('1010'), crmToken: 'crm-token', expiresAt: null });
    const fetchImpl = vi
      .fn()
      .mockImplementation(() => Promise.resolve(jsonResponse([account('1010'), account('2020')])));
    const session = new CrmAuthSession({
      gatewayBaseUrl: 'https://trade.example/gateway',
      crmBaseUrl: 'https://trade.example/crm',
      tokenStore: store,
      fetchImpl,
    });

    const accounts = await session.listAccounts();
    expect(accounts.map((item) => item.login)).toEqual(['1010']);
  });

  it('restores a cookie-held session into the token store (AUTH-001)', async () => {
    const store = new TokenStore({ legacyStorage: false });
    const restoredJwt = jwt('1010');
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        token: restoredJwt,
        crmToken: 'crm-restored',
        username: 'alice@example.com',
      }),
    );
    const session = new CrmAuthSession({
      gatewayBaseUrl: 'https://trade.example/gateway',
      crmBaseUrl: 'https://trade.example/crm',
      tokenStore: store,
      fetchImpl,
    });

    const restored = await session.restore();
    expect(restored).toEqual({ username: 'alice@example.com' });
    expect(store.get()?.gatewayToken).toBe(restoredJwt);
    expect(store.get()?.crmToken).toBe('crm-restored');
    // The restore call must carry same-origin credentials or the HttpOnly
    // session cookie never reaches the gateway.
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://trade.example/gateway/api/Authentication/session');
    expect(init.credentials).toBe('same-origin');
  });

  it('refuses to restore a session whose CRM token is gone, and clears it server-side', async () => {
    const store = new TokenStore({ legacyStorage: false });
    const fetchImpl = vi
      .fn()
      // /session answers with a valid JWT but no CRM token — a terminal booted
      // from this could never list accounts, so it must not boot at all.
      .mockResolvedValueOnce(jsonResponse({ token: jwt('1010'), username: 'alice@example.com' }))
      // the follow-up logout that clears the server's half
      .mockResolvedValueOnce(jsonResponse({ loggedOut: true }));
    const session = new CrmAuthSession({
      gatewayBaseUrl: 'https://trade.example/gateway',
      crmBaseUrl: 'https://trade.example/crm',
      tokenStore: store,
      fetchImpl,
    });

    await expect(session.restore()).resolves.toBeNull();
    expect(store.get()).toBeNull();
    const logoutCall = fetchImpl.mock.calls[1] as [string, RequestInit];
    expect(logoutCall[0]).toBe('https://trade.example/gateway/api/Authentication/logout');
    expect(logoutCall[1].method).toBe('POST');
  });

  it('returns null (and stores nothing) when there is no session to restore', async () => {
    const store = new TokenStore({ legacyStorage: false });
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{}', { status: 401 }));
    const session = new CrmAuthSession({
      gatewayBaseUrl: 'https://trade.example/gateway',
      crmBaseUrl: 'https://trade.example/crm',
      tokenStore: store,
      fetchImpl,
    });

    await expect(session.restore()).resolves.toBeNull();
    expect(store.get()).toBeNull();
  });

  it('degrades a network failure during restore to "no session", never a throw', async () => {
    const store = new TokenStore({ legacyStorage: false });
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('network down'));
    const session = new CrmAuthSession({
      gatewayBaseUrl: 'https://trade.example/gateway',
      crmBaseUrl: 'https://trade.example/crm',
      tokenStore: store,
      fetchImpl,
    });

    await expect(session.restore()).resolves.toBeNull();
  });

  it('invalidates the account cache when renewal changes claims', async () => {
    const store = new TokenStore({ legacyStorage: false });
    store.set({ gatewayToken: jwt('1010'), crmToken: 'crm-token', expiresAt: null });
    const replacement = jwt('2020');
    // Routed by URL rather than call order: listAccounts also asks the gateway
    // for its per-account suffixes (404 here → built-in map fallback).
    const crmResponses = [jsonResponse([account('1010')]), jsonResponse([account('2020')])];
    const fetchImpl = vi.fn().mockImplementation((url: string) => {
      if (url.includes('client-api/accounts')) {
        return Promise.resolve(crmResponses.shift() ?? new Response('exhausted', { status: 500 }));
      }
      if (url.includes('/api/Authentication/login')) {
        return Promise.resolve(jsonResponse({ token: replacement }));
      }
      return Promise.resolve(new Response('not found', { status: 404 }));
    });
    const session = new CrmAuthSession({
      gatewayBaseUrl: 'https://trade.example/gateway',
      crmBaseUrl: 'https://trade.example/crm',
      tokenStore: store,
      fetchImpl,
    });

    expect((await session.listAccounts()).map((item) => item.login)).toEqual(['1010']);
    await expect(session.renew()).resolves.not.toBeNull();
    expect((await session.listAccounts()).map((item) => item.login)).toEqual(['2020']);
    // Both CRM fetches ran — the cached pre-renewal list was NOT reused.
    expect(crmResponses).toHaveLength(0);
  });
});

describe('CrmAuthSession symbol-suffix resolution', () => {
  function sessionWith(routes: (url: string) => Response | Promise<Response>) {
    const store = new TokenStore({ legacyStorage: false });
    store.set({
      gatewayToken: jwt('3030,4040'),
      crmToken: 'crm-token',
      expiresAt: null,
    });
    return new CrmAuthSession({
      gatewayBaseUrl: 'https://trade.example/gateway',
      crmBaseUrl: 'https://trade.example/crm',
      tokenStore: store,
      fetchImpl: vi.fn().mockImplementation((url: string) => Promise.resolve(routes(url))),
    });
  }

  const envelope = (data: unknown) => ({ data, success: true, errorMessage: null, message: null });

  function crmAccount(login: string, typeId: number) {
    return {
      login,
      currency: 'USD',
      isEnabled: true,
      isReadOnly: false,
      type: { id: typeId, description: 'Any', server: 'Broker-Live', platform: 'MT5' },
    };
  }

  it('prefers the gateway-configured suffix over the built-in type map', async () => {
    // The live failure this pins down: the built-in map says type 64 speaks
    // "#", but the DEPLOYMENT's gateway is configured with no suffix for that
    // group. Trusting the local map produced "EURUSD#" requests that MT5
    // answered with nothing — every symbol showed "No price available".
    const session = sessionWith((url) => {
      if (url.includes('/api/Authentication/accounts')) {
        return jsonResponse(
          envelope([{ login: '3030', typeId: 64, suffix: '', suffixKnown: true }]),
        );
      }
      return jsonResponse([crmAccount('3030', 64)]);
    });

    const accounts = await session.listAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.suffix).toBe('');
  });

  it('falls back to the built-in map when the gateway does not serve suffixes', async () => {
    // Older gateway: the endpoint 404s. The account list must still load,
    // with the type map in charge exactly as before.
    const session = sessionWith((url) => {
      if (url.includes('/api/Authentication/accounts')) {
        return new Response('not found', { status: 404 });
      }
      return jsonResponse([crmAccount('3030', 57)]);
    });

    const accounts = await session.listAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.suffix).toBe('.');
  });

  it('treats suffixKnown:false as silence, keeping the built-in mapping', async () => {
    // The operator has not configured this type yet; the gateway says so
    // honestly. The account stays usable on the fallback rather than
    // disappearing from the selector.
    const session = sessionWith((url) => {
      if (url.includes('/api/Authentication/accounts')) {
        return jsonResponse(
          envelope([{ login: '3030', typeId: 60, suffix: '', suffixKnown: false }]),
        );
      }
      return jsonResponse([crmAccount('3030', 60)]);
    });

    const accounts = await session.listAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.suffix).toBe('#');
  });

  it('excludes an account whose suffix no source knows', async () => {
    // Building symbol names for it would send wrong symbols to MT5.
    const session = sessionWith((url) => {
      if (url.includes('/api/Authentication/accounts')) {
        return jsonResponse(
          envelope([{ login: '4040', typeId: 99, suffix: '', suffixKnown: false }]),
        );
      }
      return jsonResponse([crmAccount('4040', 99)]);
    });

    await expect(session.listAccounts()).resolves.toEqual([]);
  });

  it('admits a type OUTSIDE the built-in map when the gateway vouches for it', async () => {
    // The whole point of deployment-configured suffixes: a new account group
    // becomes tradable with a gateway env change, no frontend release.
    const session = sessionWith((url) => {
      if (url.includes('/api/Authentication/accounts')) {
        return jsonResponse(
          envelope([{ login: '4040', typeId: 99, suffix: '&', suffixKnown: true }]),
        );
      }
      return jsonResponse([crmAccount('4040', 99)]);
    });

    const accounts = await session.listAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.suffix).toBe('&');
  });
});

describe('CrmAuthSession keep-me-signed-in', () => {
  function signInSession(fetchImpl: ReturnType<typeof vi.fn>) {
    return new CrmAuthSession({
      gatewayBaseUrl: 'https://trade.example/gateway',
      crmBaseUrl: 'https://trade.example/crm',
      tokenStore: new TokenStore({ legacyStorage: false }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
  }

  function bodyOf(fetchImpl: ReturnType<typeof vi.fn>, urlEnd: string): Record<string, unknown> {
    const call = fetchImpl.mock.calls.find(([url]) => String(url).endsWith(urlEnd));
    if (!call) throw new Error(`no request to ${urlEnd}`);
    return JSON.parse(String((call[1] as RequestInit).body)) as Record<string, unknown>;
  }

  // The choice has to reach BOTH requests. /login sets the cookie lifetime,
  // but /crmlogin mints the CRM token those cookies carry — and every restore
  // re-presents that token to re-mint the 30-minute gateway JWT. A 30-day
  // cookie around a short-session CRM token ends as a password prompt, which
  // is precisely what the trader unchecked the box to avoid.
  it.each([true, false])(
    'sends the remember choice (%s) to crmlogin and login',
    async (remember) => {
      const fetchImpl = vi
        .fn()
        .mockImplementation(() => Promise.resolve(jsonResponse({ token: jwt('1010') })));
      await signInSession(fetchImpl).signIn('a@b.c', 'pw', { remember });

      expect(bodyOf(fetchImpl, '/api/Authentication/crmlogin').Remember).toBe(remember);
      expect(bodyOf(fetchImpl, '/api/Authentication/login').Remember).toBe(remember);
    },
  );

  // Signing in without the option at all is the un-remembered case, not an
  // absent one: the gateway must hear "false" rather than guess a default.
  it('treats an absent option as not remembered', async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementation(() => Promise.resolve(jsonResponse({ token: jwt('1010') })));
    await signInSession(fetchImpl).signIn('a@b.c', 'pw');

    expect(bodyOf(fetchImpl, '/api/Authentication/crmlogin').Remember).toBe(false);
    expect(bodyOf(fetchImpl, '/api/Authentication/login').Remember).toBe(false);
  });
});
