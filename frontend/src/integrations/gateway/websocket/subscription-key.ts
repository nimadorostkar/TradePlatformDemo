/**
 * Canonical subscription keys and URL construction for the gateway `/ws`
 * endpoint.
 *
 * VERIFIED gateway contract (internal/realtime/{params,ws,dispatch}.go):
 *   - The subscription IS the connect-URL query string. There is NO
 *     subscribe/unsubscribe message protocol.
 *   - Browser auth uses the `opotrade.jwt.<JWT>` WebSocket subprotocol. The
 *     server negotiates only `opotrade.v1`, so the credential is never echoed.
 *   - The server pushes `JSON.stringify(envelope.data)` — the bare data, NOT
 *     the REST envelope — at the configured cadence (WS_PUSH_CADENCE, 3s).
 *   - Dispatch is by `TP`: 1=Tick, 2=Position, 3=User, 4=Order, 5=Tick(daily).
 *   - `login` on the URL is checked against the token's accounts claim.
 */

export type SubscriptionFamily =
  'quote' | 'intraday-bar' | 'daily-bar' | 'account' | 'orders' | 'positions';

export interface SubscriptionParams {
  readonly family: SubscriptionFamily;
  readonly symbol?: string;
  readonly login?: string;
  readonly id?: string;
  readonly offset?: number;
  readonly total?: number;
}

/** The exact query parameters the gateway recognises (ParseParams). */
type WsQuery = Record<string, string>;

/**
 * Builds the verified query for each subscription family.
 *
 * Every shape below is copied from the working integration and cross-checked
 * against the gateway dispatcher:
 *   quote          → src/QuoteSubscription.ts
 *   intraday-bar   → src/TickSubscription.class.ts (Intraday)
 *   daily-bar      → src/TickSubscription.class.ts (Daily) — TP=5 is supported
 *                    by internal/realtime/dispatch.go even though docs/API.md
 *                    documents only TP=1..4 (see contract-discrepancies.md#D4)
 *   account        → broker-sample/src/subscriptions/AccountMetricSubscription
 *   orders         → broker-sample/src/subscriptions/OrderSubscription
 *   positions      → broker-sample/src/subscriptions/PositionSubscription
 */
export function buildSubscriptionQuery(params: SubscriptionParams): WsQuery {
  switch (params.family) {
    case 'quote':
      return {
        symbol: required(params.symbol, 'symbol'),
        id: params.id ?? '1',
        methodtype: 'GetQuotes',
        TP: '1',
        source: 'tv',
      };
    case 'intraday-bar':
      return {
        symbol: required(params.symbol, 'symbol'),
        fromtime: '0',
        totime: '1',
        data: 'dhloc',
        source: 'tv',
        methodtype: 'GetM1History',
        TP: '1',
      };
    case 'daily-bar':
      return {
        symbol: required(params.symbol, 'symbol'),
        fromtime: '0',
        totime: '1',
        methodtype: 'GetLastDailyBar',
        TP: '5',
      };
    case 'account':
      return {
        login: required(params.login, 'login'),
        methodtype: 'GetTradeState',
        TP: '3',
      };
    case 'orders':
      return {
        login: required(params.login, 'login'),
        offset: String(params.offset ?? 0),
        total: String(params.total ?? 1000),
        methodtype: 'GetPagebyPageOrder',
        TP: '4',
        source: 'tv',
      };
    case 'positions':
      return {
        login: required(params.login, 'login'),
        offset: String(params.offset ?? 0),
        total: String(params.total ?? 1000),
        methodtype: 'GetPagebyPagePositionWs',
        TP: '2',
        source: 'tv',
      };
    default: {
      const exhaustive: never = params.family;
      throw new Error(`Unknown subscription family: ${String(exhaustive)}`);
    }
  }
}

/**
 * Stable key for a subscription. Sorting the pairs makes the key independent of
 * insertion order so two identical subscriptions always share one socket.
 *
 * The access token is NEVER part of the key and never appears in diagnostics.
 */
export function subscriptionKey(query: WsQuery): string {
  return Object.entries(query)
    .filter(([, value]) => value !== '')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
}

/** Full connect URL. Credentials must never be added to this URL. */
export function buildSubscriptionUrl(baseWsUrl: string, query: WsQuery): string {
  const url = new URL(`${baseWsUrl.replace(/\/+$/, '')}/ws`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== '') url.searchParams.set(key, value);
  }
  return url.toString();
}

const APPLICATION_PROTOCOL = 'opotrade.v1';
const JWT_PROTOCOL_PREFIX = 'opotrade.jwt.';

/**
 * Browser-compatible authentication without putting a bearer credential in a
 * URL. JWT compact serialization is valid in an RFC 6455 protocol token.
 */
export function buildSubscriptionProtocols(token: string): string[] {
  if (!token) throw new Error('WebSocket access token is required');
  return [APPLICATION_PROTOCOL, `${JWT_PROTOCOL_PREFIX}${token}`];
}

/**
 * A URL safe to log. Removes the token entirely rather than truncating it —
 * even a token prefix is a credential fragment.
 */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.searchParams.has('access_token')) {
      parsed.searchParams.set('access_token', 'REDACTED');
    }
    return parsed.toString();
  } catch {
    return '(unparseable url)';
  }
}

function required(value: string | undefined, name: string): string {
  if (value === undefined || value === '') {
    throw new Error(`Subscription parameter "${name}" is required`);
  }
  return value;
}
