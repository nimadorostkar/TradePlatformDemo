import type { z } from 'zod';
import { TradingError } from '@/domain/common/errors';
import { newRequestId } from '@/domain/common/ids';
import { decodeGatewayData, gatewayEnvelopeSchema, parseContract } from '../contracts/envelope';

/**
 * Typed gateway HTTP client.
 *
 * Responsibilities kept here, not in components:
 *   - URL construction (one place, no scattered base URLs)
 *   - bearer token attachment
 *   - timeout + cancellation
 *   - correlation id per request
 *   - envelope parsing + single-layer `data` decode
 *   - runtime schema validation
 *   - normalised TradingError
 *   - bounded retry for SAFE READS ONLY
 *
 * A trading mutation is NEVER retried automatically. New gateways advertise
 * capability-based idempotency, but a mixed-version deployment may not; the
 * explicit trading flow decides whether a same-key retry is safe.
 */

export type TokenProvider = () => string | null;
/**
 * `rejectedToken` is the credential THIS request carried, not whatever the
 * session holds by the time the 401 arrives. A handler that renews needs to
 * tell "the token I hold was refused" from "a request in flight across a
 * renewal was answered late"; only the former says anything about the session.
 */
export type UnauthorizedHandler = (error: TradingError, rejectedToken: string | null) => void;

export interface HttpClientOptions {
  baseUrl: string;
  getToken: TokenProvider;
  onUnauthorized?: UnauthorizedHandler;
  defaultTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface RequestOptions<T> {
  /** Path beginning with `/`, e.g. `/api/Symbol/getsymbolsbymask`. */
  path: string;
  method?: 'GET' | 'POST' | 'DELETE';
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  /**
   * The response schema. `unknown` in the INPUT position is deliberate: these
   * schemas coerce loose gateway values (numeric strings, mixed casing), so
   * their input and output types differ, and binding `T` to the output is what
   * makes the mapper signatures line up.
   */
  schema: z.ZodType<T, z.ZodTypeDef, unknown>;
  signal?: AbortSignal;
  timeoutMs?: number;
  /**
   * Retry budget. Only ever set above 0 for idempotent reads. Defaults to 2 for
   * GET and is FORCED to 0 for POST/DELETE.
   */
  retries?: number;
  /** Skip the envelope and validate the raw body (auth + server-time routes). */
  rawBody?: boolean;
  /** Unwrap one `{ answer: ... }` level after decoding. */
  unwrapAnswer?: boolean;
  /** Label used in error codes and diagnostics. */
  endpoint: string;
  /**
   * Sent as `Idempotency-Key`. Only set for a mutation the gateway is VERIFIED
   * to deduplicate — the capability endpoint reports whether it does. Sending
   * it to a gateway that ignores it would imply a guarantee that does not
   * exist.
   */
  idempotencyKey?: string;
  /**
   * Suppresses the global "session expired" handler for a 401 on this request.
   *
   * Set only on OPTIONAL probes (capability discovery, workspace sync). A
   * deployment that leaves such an endpoint behind a different auth scheme, or
   * removes it, would otherwise sign the trader out of a session that is
   * perfectly valid — and it would happen seconds after they logged in. A
   * genuinely dead token is still caught immediately by the account, position,
   * and order requests, which do not set this.
   */
  tolerateUnauthorized?: boolean;
}

export interface GatewayResponse<T> {
  data: T;
  requestId: string;
  /** Client receive time (ms). Consumers use it for staleness decisions. */
  receivedAt: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const RETRY_BASE_DELAY_MS = 250;

export class GatewayHttpClient {
  private readonly baseUrl: string;
  private readonly getToken: TokenProvider;
  private readonly onUnauthorized: UnauthorizedHandler | undefined;
  private readonly defaultTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.getToken = options.getToken;
    this.onUnauthorized = options.onUnauthorized;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  /**
   * In-flight GETs keyed by endpoint + full URL. A second identical GET that
   * arrives while the first is still running joins it instead of opening a
   * parallel request. Observed live (2026-08-24): duplicated effects fired
   * paired fetches, harmless at 100ms — but during a gateway stall every
   * duplicate rode the full timeout and doubled the load on the exact
   * endpoints that were drowning. Mutations are never deduplicated.
   */
  private readonly inflight = new Map<
    string,
    { promise: Promise<GatewayResponse<unknown>>; abortAll: AbortController; waiters: number }
  >();

  async request<T>(options: RequestOptions<T>): Promise<GatewayResponse<T>> {
    const method = options.method ?? 'GET';
    if (method !== 'GET') return this.execute(options, method);

    const key = `${options.endpoint} ${this.buildUrl(options.path, options.query)}`;
    let entry = this.inflight.get(key);
    // An entry whose last waiter has already aborted is doomed but still
    // listed until its `finally` runs a microtask later. A caller arriving in
    // that gap — React StrictMode's synchronous unmount/remount is exactly
    // this — must not join it, or it inherits a rejection it never caused.
    if (entry?.abortAll.signal.aborted) {
      this.inflight.delete(key);
      entry = undefined;
    }
    if (!entry) {
      // The shared request runs on its OWN signal. It is aborted only when
      // every subscriber has aborted; a caller that never provided a signal
      // counts as a subscriber that never aborts.
      const abortAll = new AbortController();
      const created = {
        promise: this.execute({ ...options, signal: abortAll.signal }, method).finally(() => {
          if (this.inflight.get(key) === created) this.inflight.delete(key);
        }) as Promise<GatewayResponse<unknown>>,
        abortAll,
        waiters: 0,
      };
      entry = created;
      this.inflight.set(key, entry);
    }

    const shared = entry;
    shared.waiters++;
    const onAbort = () => {
      shared.waiters--;
      if (shared.waiters <= 0) shared.abortAll.abort(options.signal?.reason);
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      return (await shared.promise) as GatewayResponse<T>;
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
    }
  }

  private async execute<T>(
    options: RequestOptions<T>,
    method: 'GET' | 'POST' | 'DELETE',
  ): Promise<GatewayResponse<T>> {
    const isMutation = method !== 'GET';
    const maxAttempts = isMutation ? 1 : Math.max(1, (options.retries ?? 2) + 1);
    const requestId = newRequestId();

    let lastError: TradingError | null = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        return await this.attempt(options, method, requestId);
      } catch (error) {
        const tradingError = TradingError.from(error, { requestId });
        lastError = tradingError;

        const canRetry = !isMutation && tradingError.retryable && attempt < maxAttempts - 1;
        if (!canRetry) break;

        // Exponential backoff with jitter, aborting immediately if the caller
        // has already moved on (symbol/account switch).
        const delay = RETRY_BASE_DELAY_MS * 2 ** attempt + Math.random() * 100;
        await sleep(delay, options.signal);
      }
    }

    throw lastError ?? new TradingError({ kind: 'unknown', message: 'Request failed.', requestId });
  }

  private async attempt<T>(
    options: RequestOptions<T>,
    method: 'GET' | 'POST' | 'DELETE',
    requestId: string,
  ): Promise<GatewayResponse<T>> {
    const url = this.buildUrl(options.path, options.query);
    const controller = new AbortController();
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;

    const timer = setTimeout(
      () => controller.abort(new DOMException('timeout', 'TimeoutError')),
      timeoutMs,
    );
    const onExternalAbort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', onExternalAbort, { once: true });

    const headers: Record<string, string> = {
      Accept: 'application/json',
      // Traceable end to end; the gateway logs unknown headers harmlessly.
      'X-Request-Id': requestId,
    };
    const token = this.getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
        credentials: 'omit',
      });
    } catch (error) {
      if (controller.signal.aborted) {
        const isTimeout =
          controller.signal.reason instanceof DOMException &&
          controller.signal.reason.name === 'TimeoutError';
        throw new TradingError({
          kind: isTimeout ? 'timeout' : 'canceled',
          message: isTimeout ? 'The trading server did not respond in time.' : 'Request canceled.',
          code: isTimeout ? 'http.timeout' : 'http.canceled',
          requestId,
          // A timed-out READ is safe to retry; a mutation's retry policy is
          // enforced separately in request().
          retryable: isTimeout,
        });
      }
      throw new TradingError({
        kind: 'network',
        code: 'http.network',
        message: 'Cannot reach the trading server.',
        detail: error instanceof Error ? error.message : String(error),
        requestId,
        retryable: true,
      });
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onExternalAbort);
    }

    const text = await response.text();
    const receivedAt = Date.now();

    if (response.status === 401) {
      const error = new TradingError({
        kind: 'unauthorized',
        code: 'http.401',
        message: 'Your session has expired. Please sign in again.',
        requestId,
        retryable: false,
      });
      if (!options.tolerateUnauthorized) this.onUnauthorized?.(error, token);
      throw error;
    }

    if (response.status === 403) {
      throw new TradingError({
        kind: 'forbidden',
        code: 'http.403',
        message: 'This account is not available on your session.',
        detail: 'The requested login is not in the token accounts claim.',
        requestId,
        retryable: false,
      });
    }

    if (response.status >= 500) {
      throw new TradingError({
        kind: 'unavailable',
        code: `http.${response.status}`,
        message: 'The trading server is temporarily unavailable.',
        requestId,
        retryable: true,
      });
    }

    let parsedBody: unknown;
    try {
      parsedBody = text === '' ? null : JSON.parse(text);
    } catch {
      throw new TradingError({
        kind: 'contract',
        code: `contract.${options.endpoint}`,
        message: 'The trading server returned an unreadable response.',
        detail: `non-JSON body (${text.length} bytes)`,
        requestId,
        retryable: false,
      });
    }

    // The two Authentication routes and /api/Test/getServerTime are NOT
    // enveloped (verified in handlers.go), so they bypass envelope parsing.
    if (options.rawBody) {
      if (!response.ok) {
        throw new TradingError({
          kind: response.status === 400 ? 'validation' : 'unknown',
          code: `http.${response.status}`,
          message: 'The trading server rejected the request.',
          requestId,
          retryable: false,
        });
      }
      return {
        data: parseContract(options.schema, parsedBody, { endpoint: options.endpoint, requestId }),
        requestId,
        receivedAt,
      };
    }

    const envelope = gatewayEnvelopeSchema.safeParse(parsedBody);
    if (!envelope.success) {
      throw new TradingError({
        kind: 'contract',
        code: `contract.${options.endpoint}.envelope`,
        message: 'The trading server returned an unexpected response.',
        detail: envelope.error.issues
          .map((i) => i.message)
          .slice(0, 3)
          .join('; '),
        requestId,
        retryable: false,
      });
    }

    if (!envelope.data.success) {
      // A failure envelope can still carry a body, and on the trade route that
      // body is where the gateway states whether the submission reached MT5
      // (`{outcome, message}` — internal/domain/trade.go). Throwing it away
      // turned "submitted, result unreadable" into a flat "could not complete",
      // which is the difference between "reconcile" and "nothing happened".
      throw new TradingError({
        kind: response.status === 400 ? 'validation' : 'unavailable',
        code: `gateway.${options.endpoint}`,
        message:
          envelope.data.errorMessage?.trim() ||
          envelope.data.message?.trim() ||
          'The trading server could not complete this request.',
        requestId,
        retryable: false,
        payload: decodeGatewayData(envelope.data.data),
      });
    }

    let payload = decodeGatewayData(envelope.data.data);
    if (options.unwrapAnswer) {
      payload = unwrapOne(payload);
    }

    return {
      data: parseContract(options.schema, payload, { endpoint: options.endpoint, requestId }),
      requestId,
      receivedAt,
    };
  }

  private buildUrl(
    path: string,
    query?: Record<string, string | number | boolean | undefined | null>,
  ): string {
    const url = new URL(`${this.baseUrl}${path}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null || value === '') continue;
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }
}

function unwrapOne(value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value) && 'answer' in value) {
    return (value as { answer: unknown }).answer;
  }
  return value;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
