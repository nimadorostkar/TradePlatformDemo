import { describe, expect, it, vi } from 'vitest';
import { TradingApi } from './trading-api';
import type { GatewayHttpClient } from './http-client';
import { SymbolSuffixPolicy } from '../mappers/symbol-suffix';

const ecn = new SymbolSuffixPolicy('.');
const range = { fromSeconds: 1_700_000_000, toSeconds: 1_700_100_000 };

function dealRow(id: number) {
  return {
    Deal: String(id),
    PositionID: String(id),
    Action: 0,
    Entry: 0,
    Symbol: 'EURUSD.',
    Volume: 10_000,
    Price: 1.08,
    Time: 1_700_000_000 + id,
  };
}

function orderRow(id: number) {
  return { id: String(id), symbol: 'EURUSD.', side: 1, type: 1, status: 2, qtyLots: 0.01 };
}

/** An http double that serves pre-baked pages and records each request. */
function pagedHttp(pages: unknown[][]) {
  const calls: Array<Record<string, unknown>> = [];
  const request = vi.fn(async ({ query }: { query: Record<string, unknown> }) => {
    calls.push(query);
    const page = Math.floor(Number(query.offset) / Number(query.total));
    return { data: pages[page] ?? [], requestId: 'r', receivedAt: 0 };
  });
  return { http: { request } as unknown as GatewayHttpClient, calls };
}

describe('deals — walk to completion', () => {
  // One request used to be the whole story: >500 deals in the range silently
  // lost the remainder, which reads exactly like "history is not recorded".
  it('walks the offset until a short page and concatenates', async () => {
    const { http, calls } = pagedHttp([
      Array.from({ length: 3 }, (_, i) => dealRow(i)),
      Array.from({ length: 3 }, (_, i) => dealRow(3 + i)),
      [dealRow(6)],
    ]);
    const api = new TradingApi(http);

    const result = await api.deals('1001', range, ecn, { pageSize: 3 });

    expect(result.deals).toHaveLength(7);
    expect(result.truncated).toBe(false);
    expect(calls.map((c) => c.offset)).toEqual([0, 3, 6]);
    // The gateway quirk: `index` is the PAGE SIZE and must equal `total`.
    expect(calls.every((c) => c.index === 3 && c.total === 3)).toBe(true);
  });

  it('stops after one request when the first page is short', async () => {
    const { http, calls } = pagedHttp([[dealRow(1)]]);
    const api = new TradingApi(http);

    const result = await api.deals('1001', range, ecn, { pageSize: 500 });

    expect(result.deals).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });

  it('reports truncation instead of silently capping', async () => {
    const full = Array.from({ length: 2 }, (_, i) => dealRow(i));
    const { http } = pagedHttp([full, full, full, full]);
    const api = new TradingApi(http);

    const result = await api.deals('1001', range, ecn, { pageSize: 2, maxPages: 2 });

    expect(result.deals).toHaveLength(4);
    expect(result.truncated).toBe(true);
  });
});

describe('orderHistory — the broker order-history endpoint', () => {
  it('requests /api/History/get_page with source=tv and maps the rows', async () => {
    const { http, calls } = pagedHttp([[orderRow(1), orderRow(2)]]);
    const api = new TradingApi(http);

    const result = await api.orderHistory('1001', range, ecn, { pageSize: 10 });

    expect(result.orders).toHaveLength(2);
    expect(result.orders[0]).toMatchObject({ displaySymbol: 'EURUSD', status: 'filled' });
    expect(calls[0]).toMatchObject({ login: '1001', source: 'tv', offset: 0, total: 10 });
  });

  it('walks pages exactly like deals', async () => {
    const { http, calls } = pagedHttp([[orderRow(1), orderRow(2)], [orderRow(3)]]);
    const api = new TradingApi(http);

    const result = await api.orderHistory('1001', range, ecn, { pageSize: 2 });

    expect(result.orders).toHaveLength(3);
    expect(calls.map((c) => c.offset)).toEqual([0, 2]);
  });
});

/**
 * BUG-G, 2026-08-20 retest: the two History sub-tabs sorted opposite ways.
 * Closed positions were newest-first; Orders came back in the gateway's own
 * oldest-first walk order, so an order the trader had just placed landed at the
 * bottom of fifty rows.
 */
describe('orderHistory — most recent first', () => {
  const finished = (id: number, timeDone: number, timeSetup = timeDone - 60) => ({
    ...orderRow(id),
    timeSetup,
    timeDone,
  });

  it('returns the newest order first, whatever order the pages arrive in', async () => {
    const { http } = pagedHttp([[finished(1, 1_700_000_100), finished(2, 1_700_000_900)]]);
    const api = new TradingApi(http);

    const result = await api.orderHistory('1001', range, ecn, { pageSize: 10 });

    expect(result.orders.map((o) => o.id)).toEqual(['2', '1']);
  });

  it('sorts across every page, not within each one', async () => {
    // The newest row sitting on the LAST page is exactly the case a per-page
    // sort would get wrong, and exactly where a just-placed order lands.
    const { http } = pagedHttp([
      [finished(1, 1_700_000_100), finished(2, 1_700_000_200)],
      [finished(3, 1_700_009_000)],
    ]);
    const api = new TradingApi(http);

    const result = await api.orderHistory('1001', range, ecn, { pageSize: 2 });

    expect(result.orders.map((o) => o.id)).toEqual(['3', '2', '1']);
  });

  it('falls back to when an order was placed if it never reached a final state', async () => {
    const working = { ...orderRow(9), status: 6, timeSetup: 1_700_005_000 };
    const { http } = pagedHttp([[finished(1, 1_700_000_100), working]]);
    const api = new TradingApi(http);

    const result = await api.orderHistory('1001', range, ecn, { pageSize: 10 });

    // A working order has no final time; ordering it as if it were at the
    // epoch would bury the most recent thing the trader did.
    expect(result.orders.map((o) => o.id)).toEqual(['9', '1']);
  });
});
