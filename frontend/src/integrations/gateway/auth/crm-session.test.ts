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

describe('CrmAuthSession registration', () => {
  function sessionWith(fetchImpl: typeof fetch) {
    return new CrmAuthSession({
      gatewayBaseUrl: 'https://trade.example/gateway',
      crmBaseUrl: 'https://trade.example/crm',
      tokenStore: new TokenStore({ legacyStorage: false }),
      fetchImpl,
    });
  }

  it('posts to the CRM register endpoint and returns the new accounts', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 7, email: 'new@example.com', accounts: [100007] }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }),
    ) as unknown as typeof fetch;
    const result = await sessionWith(fetchImpl).register({
      email: 'new@example.com',
      password: 'longenough1',
      name: 'New',
    });
    expect(result).toEqual({ id: 7, email: 'new@example.com', accounts: ['100007'] });
    const [url, init] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock
      .calls[0]!;
    expect(url).toBe('https://trade.example/crm/client-api/register');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      email: 'new@example.com',
      password: 'longenough1',
      name: 'New',
    });
  });

  it('turns a duplicate email into a validation error the form can show', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ error: 'email already registered' }), { status: 409 }),
      ) as unknown as typeof fetch;
    await expect(
      sessionWith(fetchImpl).register({ email: 'dup@example.com', password: 'longenough1' }),
    ).rejects.toMatchObject({ kind: 'validation', code: 'crm.register.conflict' });
  });

  it('relays the CRM validation message on a 400', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'invalid input: password must be 8–128 characters' }), {
        status: 400,
      }),
    ) as unknown as typeof fetch;
    await expect(
      sessionWith(fetchImpl).register({ email: 'x@example.com', password: 'short' }),
    ).rejects.toMatchObject({
      kind: 'validation',
      message: 'invalid input: password must be 8–128 characters',
    });
  });
});

describe('CrmAuthSession profile', () => {
  const profileBody = {
    id: 1,
    email: 'trader@example.com',
    name: 'Demo Trader',
    phone: '+44 20 7946 0958',
    country: 'GB',
    city: 'London',
    language: 'en',
    timezone: 'Europe/London',
    kycStatus: 'verified',
    createdAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-02T00:00:00Z',
  };

  function sessionWith(fetchImpl: typeof fetch, crmToken: string | null = 'crm-token') {
    const store = new TokenStore({ legacyStorage: false });
    if (crmToken) store.set({ gatewayToken: jwt('1010'), crmToken, expiresAt: null });
    return new CrmAuthSession({
      gatewayBaseUrl: 'https://trade.example/gateway',
      crmBaseUrl: 'https://trade.example/crm',
      tokenStore: store,
      fetchImpl,
    });
  }

  it('sends the optional sign-up details only when given', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 8, email: 'n@example.com', accounts: [100008] }), {
        status: 201,
      }),
    ) as unknown as typeof fetch;
    await sessionWith(fetchImpl, null).register({
      email: 'n@example.com',
      password: 'longenough1',
      name: 'N',
      phone: '+1 415 555 0100',
      country: 'US',
      timezone: 'America/Los_Angeles',
    });
    const [, init] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock
      .calls[0]!;
    expect(JSON.parse(String(init.body))).toEqual({
      email: 'n@example.com',
      password: 'longenough1',
      name: 'N',
      phone: '+1 415 555 0100',
      country: 'US',
      timezone: 'America/Los_Angeles',
    });
  });

  it('reads the profile with the CRM bearer', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify(profileBody), { status: 200 }),
      ) as unknown as typeof fetch;
    const profile = await sessionWith(fetchImpl).profile();
    expect(profile).toMatchObject({ country: 'GB', kycStatus: 'verified', city: 'London' });
    const [url, init] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock
      .calls[0]!;
    expect(url).toBe('https://trade.example/crm/client-api/me');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer crm-token');
  });

  it('updates the profile and surfaces a validation refusal', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ...profileBody, city: 'Leeds' }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: 'invalid input: country must be a two-letter ISO code' }),
          {
            status: 400,
          },
        ),
      ) as unknown as typeof fetch;
    const session = sessionWith(fetchImpl);
    const input = {
      name: 'Demo Trader',
      phone: '',
      country: 'GB',
      city: 'Leeds',
      language: 'en',
      timezone: 'Europe/London',
    };
    expect((await session.updateProfile(input)).city).toBe('Leeds');
    const [, init] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock
      .calls[0]!;
    expect(init.method).toBe('PUT');
    await expect(session.updateProfile({ ...input, country: 'Britain' })).rejects.toMatchObject({
      kind: 'validation',
      message: 'invalid input: country must be a two-letter ISO code',
    });
  });

  it('refuses to read a profile without a CRM token', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(sessionWith(fetchImpl, null).profile()).rejects.toMatchObject({
      kind: 'unauthorized',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
