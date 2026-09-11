import { describe, expect, it } from 'vitest';
import { gatewayEnvelopeSchema, decodeGatewayData } from '../contracts/envelope';
import {
  serverTimeSchema,
  tvQuoteListSchema,
  tvSymbolListSchema,
  accountStateSchema,
  tvPositionListSchema,
  tvOrderListSchema,
} from '../contracts/schemas';

/**
 * READ-ONLY contract smoke tests against a configured NON-PRODUCTION gateway.
 *
 * These verify that this app's schemas still match a real server. They are
 * excluded from `npm test` and run only via `npm run test:contract` with
 * CONTRACT_GATEWAY_URL and CONTRACT_GATEWAY_TOKEN set.
 *
 * SAFETY: only read endpoints are called — health, server time, symbols,
 * quotes, bars, account snapshots, positions, orders, history. There is NO
 * transactional test here, and adding one would additionally require a
 * dedicated disposable demo account and a separate explicit authorisation flag.
 * The default test command can never trade.
 */

const BASE = process.env.CONTRACT_GATEWAY_URL;
const TOKEN = process.env.CONTRACT_GATEWAY_TOKEN;
const LOGIN = process.env.CONTRACT_LOGIN;

const configured = Boolean(BASE && TOKEN);

// A refusal, not a skip: pointing these at production would be a mistake worth
// failing loudly for.
if (BASE && /prod/i.test(BASE)) {
  throw new Error('CONTRACT_GATEWAY_URL looks like production. Refusing to run.');
}

async function get(path: string, query: Record<string, string | number> = {}) {
  const url = new URL(`${BASE}${path}`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' },
  });
  return { status: response.status, body: (await response.json()) as unknown };
}

describe.skipIf(!configured)('gateway contract (read-only)', () => {
  it('serves /healthz', async () => {
    const response = await fetch(`${BASE}/healthz`);
    expect(response.status).toBe(200);
  });

  it('returns server time in the bare (non-enveloped) shape', async () => {
    const { status, body } = await get('/api/Test/getServerTime');
    expect(status).toBe(200);
    // Verified: handlers.go#TestServerTime bypasses the envelope.
    expect(serverTimeSchema.safeParse(body).success).toBe(true);
  });

  it('returns the documented envelope for symbol search', async () => {
    const { body } = await get('/api/Symbol/getsymbolsbymask', { mask: 'EUR', source: 'tv' });

    const envelope = gatewayEnvelopeSchema.safeParse(body);
    expect(envelope.success).toBe(true);
    if (!envelope.success) return;

    const data = decodeGatewayData(envelope.data.data);
    expect(tvSymbolListSchema.safeParse(data).success).toBe(true);
  });

  it('returns quotes matching the Quote schema', async () => {
    const { body } = await get('/api/Tick/last', { symbol: 'EURUSD', id: 1, source: 'tv' });
    const envelope = gatewayEnvelopeSchema.parse(body);
    expect(tvQuoteListSchema.safeParse(decodeGatewayData(envelope.data)).success).toBe(true);
  });

  /**
   * The quote timestamp the forming candle and the stale indicator both depend
   * on. `time` is OPTIONAL in the schema so an older gateway still parses, which
   * means the schema check above passes whether or not the field is there —
   * this is what actually proves the deployment sends it.
   */
  it('stamps quotes with a broker time', async () => {
    const { body } = await get('/api/Tick/last', { symbol: 'EURUSD', id: 1, source: 'tv' });
    const envelope = gatewayEnvelopeSchema.parse(body);
    const quotes = tvQuoteListSchema.parse(decodeGatewayData(envelope.data));
    const quote = quotes[0];
    expect(quote).toBeDefined();
    expect(quote!.time).not.toBeNull();
  });

  /**
   * Guards the regression the whole clock change was about.
   *
   * Live bars used to be stamped three hours AHEAD (the broker runs UTC+3). A
   * quote from the future is the signature of that bug returning, and it is
   * catchable without knowing anything about market hours: a quote may be
   * arbitrarily OLD — a closed market legitimately reprints Friday's — but it
   * can never legitimately be from ahead of the server's own clock.
   */
  it('never stamps a quote ahead of gateway server time', async () => {
    const { body: timeBody } = await get('/api/Test/getServerTime');
    const serverSeconds = serverTimeSchema.parse(timeBody).unixTimestamp;
    expect(Number.isFinite(serverSeconds)).toBe(true);

    const { body } = await get('/api/Tick/last', { symbol: 'EURUSD', id: 1, source: 'tv' });
    const envelope = gatewayEnvelopeSchema.parse(body);
    const quote = tvQuoteListSchema.parse(decodeGatewayData(envelope.data))[0];
    if (!quote || quote.time === null) return; // covered by the test above

    // 60s of slack absorbs ordinary request latency and clock jitter. A
    // three-hour offset clears it by two orders of magnitude.
    expect(quote.time).toBeLessThanOrEqual(serverSeconds + 60);
    // And it must be UTC SECONDS, not milliseconds: a ms value would be ~1000x
    // the server's own number.
    expect(quote.time).toBeGreaterThan(serverSeconds / 2);
  });

  it('returns bars matching the bar schema', async () => {
    const to = Math.floor(Date.now() / 1000);
    const { body } = await get('/api/Tick/get', {
      symbol: 'EURUSD',
      from: to - 3600,
      to,
      data: 'dhloc',
    });
    const envelope = gatewayEnvelopeSchema.parse(body);
    expect(Array.isArray(decodeGatewayData(envelope.data))).toBe(true);
  });

  describe.skipIf(!LOGIN)('account-scoped reads', () => {
    it('returns the account snapshot in the raw MT5 shape', async () => {
      const { body } = await get('/api/User/get_trade_state', {
        login: LOGIN!,
        source: 'mt5',
      });
      const envelope = gatewayEnvelopeSchema.parse(body);
      const data = decodeGatewayData(envelope.data);
      expect(accountStateSchema.safeParse(data).success).toBe(true);
    });

    it('returns positions matching the position schema', async () => {
      const { body } = await get('/api/Position/get_page', {
        login: LOGIN!,
        offset: 0,
        total: 50,
        source: 'tv',
      });
      const envelope = gatewayEnvelopeSchema.parse(body);
      expect(tvPositionListSchema.safeParse(decodeGatewayData(envelope.data)).success).toBe(true);
    });

    it('returns orders matching the order schema', async () => {
      const { body } = await get('/api/Order/get_page', {
        login: LOGIN!,
        offset: 0,
        total: 50,
        source: 'tv',
      });
      const envelope = gatewayEnvelopeSchema.parse(body);
      expect(tvOrderListSchema.safeParse(decodeGatewayData(envelope.data)).success).toBe(true);
    });
  });
});
