import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { GatewayHttpClient } from './http-client';
import type { TradingError } from '@/domain/common/errors';

/**
 * The client's authentication and header behaviour.
 *
 * The 401 path is the sharp edge here. It ends a trader's session, so it has to
 * fire on a genuinely dead token and NOT fire for an optional feature the
 * deployment simply does not serve — the second case would sign someone out
 * seconds after they logged in, with no explanation they could act on.
 */

function respond(status: number, body: unknown = { data: {}, success: true }): typeof fetch {
  return vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
  ) as unknown as typeof fetch;
}

function client(options: {
  fetchImpl: typeof fetch;
  onUnauthorized?: (error: TradingError) => void;
  token?: string | null;
}) {
  return new GatewayHttpClient({
    baseUrl: 'https://gateway.test',
    getToken: () => options.token ?? 'token',
    onUnauthorized: options.onUnauthorized,
    fetchImpl: options.fetchImpl,
  });
}

const ok = z.unknown();

describe('401 handling', () => {
  it('ends the session on a 401 from a core request', async () => {
    const onUnauthorized = vi.fn();
    const http = client({ fetchImpl: respond(401), onUnauthorized });

    await expect(
      http.request({ endpoint: 'positions', path: '/api/Position/get_page', schema: ok }),
    ).rejects.toMatchObject({ kind: 'unauthorized', code: 'http.401' });

    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('does NOT end the session on a 401 from an optional probe', async () => {
    const onUnauthorized = vi.fn();
    const http = client({ fetchImpl: respond(401), onUnauthorized });

    // A gateway that puts an optional endpoint behind a different auth scheme,
    // or removes it, must not be able to sign a valid session out.
    await expect(
      http.request({
        endpoint: 'capabilities',
        path: '/api/Capabilities',
        schema: ok,
        tolerateUnauthorized: true,
      }),
    ).rejects.toMatchObject({ kind: 'unauthorized' });

    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('still rejects a tolerated 401, so the caller cannot mistake it for data', async () => {
    const http = client({ fetchImpl: respond(401) });

    await expect(
      http.request({
        endpoint: 'workspace-get',
        path: '/api/Workspace/get',
        schema: ok,
        tolerateUnauthorized: true,
      }),
    ).rejects.toThrow();
  });

  it('does not retry a 401 — a dead token will not revive', async () => {
    const fetchImpl = respond(401);
    const http = client({ fetchImpl, onUnauthorized: vi.fn() });

    await expect(
      http.request({ endpoint: 'orders', path: '/api/Order/get_page', schema: ok }),
    ).rejects.toThrow();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('request headers', () => {
  /** The headers actually sent on the last call. */
  async function headersFor(options: Parameters<GatewayHttpClient['request']>[0]) {
    const fetchImpl = respond(200);
    const http = client({ fetchImpl });
    await http.request(options).catch(() => {});
    const init = (fetchImpl as unknown as { mock: { calls: [URL, RequestInit][] } }).mock
      .calls[0][1];
    return init.headers as Record<string, string>;
  }

  it('sends a correlation id on every request', async () => {
    const headers = await headersFor({
      endpoint: 'symbols',
      path: '/api/Symbol/getsymbolsbymask',
      schema: ok,
    });
    expect(headers['X-Request-Id']).toMatch(/\S/);
  });

  it('sends the bearer token', async () => {
    const headers = await headersFor({ endpoint: 'symbols', path: '/api/x', schema: ok });
    expect(headers.Authorization).toBe('Bearer token');
  });

  it('sends Idempotency-Key only when one is supplied', async () => {
    const without = await headersFor({ endpoint: 'trade', path: '/api/x', schema: ok });
    expect(without['Idempotency-Key']).toBeUndefined();

    const withKey = await headersFor({
      endpoint: 'trade',
      path: '/api/Trade/send_request',
      method: 'POST',
      body: {},
      schema: ok,
      idempotencyKey: 'key-123',
    });
    expect(withKey['Idempotency-Key']).toBe('key-123');
  });
});

describe('in-flight GET dedupe', () => {
  it('joins a concurrent identical GET instead of opening a second request', async () => {
    let release!: (r: Response) => void;
    const gate = new Promise<Response>((resolve) => (release = resolve));
    const fetchImpl = vi.fn(async () => gate) as unknown as typeof fetch;
    const http = client({ fetchImpl });

    const opts = { endpoint: 'market-depth', path: '/api/Tick/get_marketdepth', schema: ok };
    const first = http.request(opts);
    const second = http.request(opts);
    release(new Response(JSON.stringify({ data: { a: 1 }, success: true }), { status: 200 }));

    const [r1, r2] = await Promise.all([first, second]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(r1.data).toEqual(r2.data);
  });

  it('keeps the shared request alive when only one of two callers aborts', async () => {
    let release!: (r: Response) => void;
    const gate = new Promise<Response>((resolve) => (release = resolve));
    const fetchImpl = vi.fn(
      async (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
          void gate.then(resolve);
        }),
    ) as unknown as typeof fetch;
    const http = client({ fetchImpl });

    const aborter = new AbortController();
    const opts = { endpoint: 'quotes', path: '/api/Tick/last', schema: ok };
    const abandoned = http.request({ ...opts, signal: aborter.signal });
    const patient = http.request(opts);

    aborter.abort();
    release(new Response(JSON.stringify({ data: { bid: 1 }, success: true }), { status: 200 }));

    // The patient caller still gets its answer off the one shared request.
    await expect(patient).resolves.toMatchObject({ data: { bid: 1 } });
    await expect(abandoned).resolves.toMatchObject({ data: { bid: 1 } });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('aborts the shared request once every caller has abandoned it', async () => {
    const seen: AbortSignal[] = [];
    const fetchImpl = vi.fn(
      async (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          if (init?.signal) {
            seen.push(init.signal);
            init.signal.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError')),
            );
          }
        }),
    ) as unknown as typeof fetch;
    const http = client({ fetchImpl });

    const aborter = new AbortController();
    const opts = {
      endpoint: 'symbols-by-mask',
      path: '/api/Symbol/getsymbolsbymask',
      schema: ok,
      retries: 0,
    };
    const request = http.request({ ...opts, signal: aborter.signal });

    aborter.abort();
    await expect(request).rejects.toMatchObject({ kind: 'canceled' });
    expect(seen[0]?.aborted).toBe(true);
  });

  it('does not join a request whose last caller aborted a moment ago', async () => {
    // React StrictMode unmounts and remounts an effect synchronously: the
    // first mount's abort and the second mount's identical GET land in the
    // same tick, before the doomed entry's `finally` has evicted it.
    let calls = 0;
    const fetchImpl = vi.fn(
      async (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          calls += 1;
          const mine = calls;
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
          if (mine === 2) {
            resolve(
              new Response(JSON.stringify({ data: 'second', success: true }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
              }),
            );
          }
        }),
    ) as unknown as typeof fetch;
    const http = client({ fetchImpl });
    const opts = {
      endpoint: 'symbols-by-mask',
      path: '/api/Symbol/getsymbolsbymask',
      schema: ok,
      retries: 0,
    };

    const first = new AbortController();
    const doomed = http.request({ ...opts, signal: first.signal });
    first.abort();
    const second = http.request({ ...opts, signal: new AbortController().signal });

    await expect(doomed).rejects.toMatchObject({ kind: 'canceled' });
    await expect(second).resolves.toMatchObject({ data: 'second' });
    expect(calls).toBe(2);
  });

  it('never deduplicates a mutation', async () => {
    const fetchImpl = respond(200);
    const http = client({ fetchImpl });

    const opts = {
      endpoint: 'order-send',
      path: '/api/Trade/send',
      method: 'POST' as const,
      body: { volume: 1 },
      schema: ok,
    };
    await Promise.all([http.request(opts), http.request(opts)]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
