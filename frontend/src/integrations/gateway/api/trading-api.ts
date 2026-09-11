import { z } from 'zod';
import type { GatewayHttpClient } from './http-client';
import {
  accountStateSchema,
  mt5DealListSchema,
  tvOrderHistoryListSchema,
  mt5UserResponseSchema,
  tradeResultSchema,
  tvOrderListSchema,
  tvPositionListSchema,
  leverageSchema,
  mt5UserGroupSchema,
  type LeverageState,
} from '../contracts/schemas';
import {
  mapAccountState,
  mapDeal,
  mapTvOrderHistory,
  mapTvOrder,
  mapTvPosition,
  readOnlyFromRights,
} from '../mappers/to-domain';
import type { SymbolSuffixPolicy } from '../mappers/symbol-suffix';
import {
  digitsFromPrice,
  lotsToMt5Volume,
  MT5_ACTION,
  oppositeSide,
  resolveMt5ActionAndType,
} from '../mappers/trade-codes';
import type { DecimalString } from '@/domain/common/decimal';
import type {
  Deal,
  HistoricalOrder,
  OrderKind,
  Position,
  Side,
  TradeSubmissionResult,
  TradingAccount,
  TradingOrder,
} from '@/domain/common/models';
import { asOrderId, newRequestId, toIdString } from '@/domain/common/ids';
import {
  isSuccessRetcode,
  isUnknownRetcode,
  parseRetcode,
  TradingError,
  tradeErrorFromRetcode,
} from '@/domain/common/errors';

/**
 * Account state and trading.
 *
 * Everything that mutates money goes through `sendRequest`, which mirrors the
 * payload constructors proven in broker-sample/src/BrokerApiClient.ts. That
 * path — `POST /api/Trade/send_request` with MT5 action codes 200–204 — is the
 * production path. The anonymous `/api/tv/TVOrder/*` routes are NOT used: they
 * build hardcoded MT5 requests (Login=1010/1020) and are unauthenticated.
 */

export interface OpenPositionRequest {
  login: string;
  gatewaySymbol: string;
  side: Side;
  volumeLots: DecimalString;
  /** Current ask for a buy, bid for a sell. */
  price: DecimalString;
  stopLoss?: DecimalString | null;
  takeProfit?: DecimalString | null;
  digits: number;
}

export interface PlacePendingRequest {
  login: string;
  gatewaySymbol: string;
  side: Side;
  kind: Exclude<OrderKind, 'market'>;
  volumeLots: DecimalString;
  price: DecimalString;
  stopLoss?: DecimalString | null;
  takeProfit?: DecimalString | null;
  digits: number;
}

export interface ModifyPositionRequest {
  login: string;
  gatewaySymbol: string;
  positionId: string;
  side: Side;
  stopLoss: DecimalString | null;
  takeProfit: DecimalString | null;
  digits: number;
}

export interface ClosePositionRequest {
  login: string;
  gatewaySymbol: string;
  positionId: string;
  /** The position's own side; the close order is submitted on the opposite. */
  side: Side;
  volumeLots: DecimalString;
}

export interface ModifyOrderRequest {
  login: string;
  gatewaySymbol: string;
  orderId: string;
  side: Side;
  kind: Exclude<OrderKind, 'market'>;
  volumeLots: DecimalString;
  price: DecimalString;
  stopLoss: DecimalString | null;
  takeProfit: DecimalString | null;
  digits: number;
}

export interface CancelOrderRequest {
  login: string;
  gatewaySymbol: string;
  orderId: string;
  side: Side;
  kind: Exclude<OrderKind, 'market'>;
}

export class TradingApi {
  constructor(
    private readonly http: GatewayHttpClient,
    /** Reads the gateway's advertised capabilities; defaults to none. */
    private readonly supportsIdempotency: () => boolean = () => false,
  ) {}

  // ── Reads ──────────────────────────────────────────────────────────────────

  /** GET /api/User/get_trade_state?login=&source=mt5 (account-scoped). */
  async accountState(
    login: string,
    options: {
      name?: string;
      server?: string | null;
      currency?: string | null;
      readOnly?: boolean;
    } = {},
    signal?: AbortSignal,
  ): Promise<TradingAccount> {
    const response = await this.http.request({
      endpoint: 'account-state',
      path: '/api/User/get_trade_state',
      query: { login, source: 'mt5' },
      schema: accountStateSchema,
      signal,
    });
    return mapAccountState(login, response.data, { ...options, asOf: response.receivedAt });
  }

  /**
   * GET /api/User/get?login=&source=mt5 — the MT5 user record.
   * Used only to read the `Rights` bitmask for investor/read-only mode.
   * Returns null (not `false`) when the gateway does not expose the flag, so
   * the caller never infers a permission it was not told.
   */
  async tradeDisabled(login: string, signal?: AbortSignal): Promise<boolean | null> {
    try {
      const response = await this.http.request({
        endpoint: 'user-get',
        path: '/api/User/get',
        query: { login, source: 'mt5' },
        schema: mt5UserResponseSchema,
        signal,
      });
      return readOnlyFromRights(response.data.Rights);
    } catch {
      return null;
    }
  }

  /** GET /api/Position/get_page?login=&offset=&total=&source=tv */
  async positions(
    login: string,
    suffix: SymbolSuffixPolicy,
    options: { offset?: number; total?: number } = {},
    signal?: AbortSignal,
  ): Promise<Position[]> {
    const response = await this.http.request({
      endpoint: 'positions-page',
      path: '/api/Position/get_page',
      query: {
        login,
        offset: options.offset ?? 0,
        total: options.total ?? 1000,
        source: 'tv',
      },
      schema: tvPositionListSchema,
      signal,
    });
    return response.data
      .map((dto) => mapTvPosition(dto, suffix))
      .filter((p): p is Position => p !== null);
  }

  /** GET /api/Order/get_page?login=&offset=&total=&source=tv */
  async orders(
    login: string,
    suffix: SymbolSuffixPolicy,
    options: { offset?: number; total?: number } = {},
    signal?: AbortSignal,
  ): Promise<TradingOrder[]> {
    const response = await this.http.request({
      endpoint: 'orders-page',
      path: '/api/Order/get_page',
      query: {
        login,
        offset: options.offset ?? 0,
        total: options.total ?? 1000,
        source: 'tv',
      },
      schema: tvOrderListSchema,
      signal,
    });
    return response.data
      .map((dto) => mapTvOrder(dto, suffix))
      .filter((o): o is TradingOrder => o !== null);
  }

  /**
   * GET /api/Deal/get_page?login=&from=&to=&offset=&index= — raw MT5 deals,
   * fetched to COMPLETION by walking the offset until a short page.
   *
   * Note the gateway quirk (handlers.go#DealGetPage): `index` is the PAGE
   * SIZE (it falls back to `total` when 0) — it is NOT a start offset. We
   * send both so either build works.
   *
   * One request used to be the whole story: an account with more than 500
   * deals in the range silently lost the remainder, which reads exactly like
   * "history is not recorded". The walk is capped; hitting the cap sets
   * `truncated` so the UI can SAY the list is incomplete instead of letting
   * silence imply completeness.
   */
  async deals(
    login: string,
    range: { fromSeconds: number; toSeconds: number },
    suffix: SymbolSuffixPolicy,
    options: { pageSize?: number; maxPages?: number } = {},
    signal?: AbortSignal,
  ): Promise<{ deals: Deal[]; truncated: boolean }> {
    const pageSize = options.pageSize ?? 500;
    const maxPages = options.maxPages ?? 20;

    const all: Deal[] = [];
    let truncated = false;
    for (let page = 0; page < maxPages; page++) {
      const response = await this.http.request({
        endpoint: 'deals-page',
        path: '/api/Deal/get_page',
        query: {
          login,
          from: range.fromSeconds,
          to: range.toSeconds,
          offset: page * pageSize,
          index: pageSize,
          total: pageSize,
        },
        schema: z.union([mt5DealListSchema, z.object({ answer: mt5DealListSchema })]),
        signal,
        timeoutMs: 30_000,
      });
      const rows = Array.isArray(response.data) ? response.data : response.data.answer;
      for (const dto of rows) {
        const deal = mapDeal(dto, suffix);
        if (deal !== null) all.push(deal);
      }
      if (rows.length < pageSize) return { deals: all, truncated: false };
      if (page === maxPages - 1) truncated = true;
    }
    return { deals: all, truncated };
  }

  /**
   * GET /api/History/get_page?source=tv — the broker's ORDER history: every
   * order that reached a final state (filled, cancelled, rejected, expired),
   * date-ranged and broker-clock-corrected by the gateway. Same walk-to-
   * completion contract as `deals`.
   */
  async orderHistory(
    login: string,
    range: { fromSeconds: number; toSeconds: number },
    suffix: SymbolSuffixPolicy,
    options: { pageSize?: number; maxPages?: number } = {},
    signal?: AbortSignal,
  ): Promise<{ orders: HistoricalOrder[]; truncated: boolean }> {
    const pageSize = options.pageSize ?? 500;
    const maxPages = options.maxPages ?? 20;

    const all: HistoricalOrder[] = [];
    let truncated = false;
    for (let page = 0; page < maxPages; page++) {
      const response = await this.http.request({
        endpoint: 'order-history-page',
        path: '/api/History/get_page',
        query: {
          login,
          from: range.fromSeconds,
          to: range.toSeconds,
          offset: page * pageSize,
          total: pageSize,
          source: 'tv',
        },
        schema: tvOrderHistoryListSchema,
        signal,
        timeoutMs: 30_000,
      });
      for (const dto of response.data) {
        const order = mapTvOrderHistory(dto, suffix);
        if (order !== null) all.push(order);
      }
      if (response.data.length < pageSize) return { orders: newestFirst(all), truncated: false };
      if (page === maxPages - 1) truncated = true;
    }
    return { orders: newestFirst(all), truncated };
  }

  // ── Mutations ──────────────────────────────────────────────────────────────

  async openPosition(
    request: OpenPositionRequest,
    signal?: AbortSignal,
  ): Promise<TradeSubmissionResult> {
    const { action, type } = resolveMt5ActionAndType({
      intent: 'open',
      kind: 'market',
      side: request.side,
    });

    return this.sendRequest(
      {
        action,
        login: request.login,
        symbol: request.gatewaySymbol,
        type,
        volume: lotsToMt5Volume(request.volumeLots),
        typeFill: 0,
        priceOrder: Number(request.price),
        priceSL:
          request.stopLoss === null || request.stopLoss === undefined
            ? 0
            : Number(request.stopLoss),
        priceTP:
          request.takeProfit === null || request.takeProfit === undefined
            ? 0
            : Number(request.takeProfit),
        digits: request.digits,
      },
      signal,
    );
  }

  /**
   * GET /api/Account/leverage — the login's leverage and what it may become.
   *
   * Leverage is a property of the ACCOUNT, not of a symbol or an order: MT5
   * has no per-symbol leverage, and brokers offering "dynamic leverage"
   * enforce it server-side. The permitted values are a broker policy the
   * gateway states, so they are read, never assumed.
   */
  async leverage(login: string, signal?: AbortSignal): Promise<LeverageState> {
    const response = await this.http.request({
      endpoint: 'leverage-get',
      path: '/api/Account/leverage',
      query: { login },
      schema: leverageSchema,
      signal,
    });
    return response.data;
  }

  /**
   * GET /api/User/get — the account's MT5 GROUP, or null when unreported.
   *
   * The group is what actually determines an account's trading conditions, and
   * it is the only identifier a trader can put to their broker to establish
   * what kind of account they are on. Everything the terminal otherwise shows
   * about "environment" describes the GATEWAY — which MT5 server it talks to —
   * and a deployment can serve many groups through one gateway. QA traded on an
   * account for a whole session unable to tell what it was (2026-08-21).
   *
   * Never inferred from: no demo/live judgement is made here, because MT5 has
   * no such flag on a user and this broker's group names carry no marker. The
   * fact is reported; reading it is the trader's and the broker's business.
   */
  async accountGroup(login: string, signal?: AbortSignal): Promise<string | null> {
    const response = await this.http.request({
      endpoint: 'user-get',
      path: '/api/User/get',
      query: { login },
      schema: mt5UserGroupSchema,
      signal,
    });
    const data = response.data;
    const group = data.answer?.Group ?? data.answer?.group ?? data.Group ?? data.group ?? null;
    return group !== null && group.trim() !== '' ? group : null;
  }

  /**
   * POST /api/Account/leverage — writes it.
   *
   * Answered from the record as re-read by the gateway, so the caller reflects
   * what the server actually holds rather than what was asked for.
   */
  async setLeverage(login: string, leverage: number, signal?: AbortSignal): Promise<LeverageState> {
    const response = await this.http.request({
      endpoint: 'leverage-set',
      path: '/api/Account/leverage',
      method: 'POST',
      body: { login, leverage },
      schema: leverageSchema,
      signal,
    });
    return response.data;
  }

  async placePendingOrder(
    request: PlacePendingRequest,
    signal?: AbortSignal,
  ): Promise<TradeSubmissionResult> {
    const { action, type } = resolveMt5ActionAndType({
      intent: 'place-pending',
      kind: request.kind,
      side: request.side,
    });

    return this.sendRequest(
      {
        action,
        login: request.login,
        symbol: request.gatewaySymbol,
        type,
        volume: lotsToMt5Volume(request.volumeLots),
        // typeFill 2 (Return) is what the working adapter sends for pending
        // orders; 0 (Fill-or-Kill) is used for market execution.
        typeFill: 2,
        priceOrder: Number(request.price),
        priceTrigger: 0,
        priceSL:
          request.stopLoss === null || request.stopLoss === undefined
            ? 0
            : Number(request.stopLoss),
        priceTP:
          request.takeProfit === null || request.takeProfit === undefined
            ? 0
            : Number(request.takeProfit),
        digits: request.digits,
        typetime: 0,
      },
      signal,
    );
  }

  async modifyPosition(
    request: ModifyPositionRequest,
    signal?: AbortSignal,
  ): Promise<TradeSubmissionResult> {
    const { action, type } = resolveMt5ActionAndType({
      intent: 'modify-position',
      kind: 'market',
      side: request.side,
    });

    return this.sendRequest(
      {
        action,
        login: request.login,
        symbol: request.gatewaySymbol,
        type,
        position: request.positionId,
        // 0 clears the level — this is MT5's own encoding for "no stop".
        priceSL: request.stopLoss === null ? 0 : Number(request.stopLoss),
        priceTP: request.takeProfit === null ? 0 : Number(request.takeProfit),
        digits: request.digits,
      },
      signal,
    );
  }

  async closePosition(
    request: ClosePositionRequest,
    signal?: AbortSignal,
  ): Promise<TradeSubmissionResult> {
    // A close is an ExecutePosition on the OPPOSITE side carrying the position id.
    const { action, type } = resolveMt5ActionAndType({
      intent: 'close',
      kind: 'market',
      side: oppositeSide(request.side),
    });

    return this.sendRequest(
      {
        action,
        login: request.login,
        symbol: request.gatewaySymbol,
        type,
        volume: lotsToMt5Volume(request.volumeLots),
        typeFill: 0,
        position: request.positionId,
      },
      signal,
    );
  }

  async modifyOrder(
    request: ModifyOrderRequest,
    signal?: AbortSignal,
  ): Promise<TradeSubmissionResult> {
    const { action, type } = resolveMt5ActionAndType({
      intent: 'modify-pending',
      kind: request.kind,
      side: request.side,
    });

    return this.sendRequest(
      {
        action,
        login: request.login,
        order: request.orderId,
        symbol: request.gatewaySymbol,
        type,
        priceOrder: Number(request.price),
        priceTrigger: 0,
        priceSL: request.stopLoss === null ? 0 : Number(request.stopLoss),
        priceTP: request.takeProfit === null ? 0 : Number(request.takeProfit),
        digits: request.digits || digitsFromPrice(request.price),
        typetime: 0,
        volume: lotsToMt5Volume(request.volumeLots),
      },
      signal,
    );
  }

  async cancelOrder(
    request: CancelOrderRequest,
    signal?: AbortSignal,
  ): Promise<TradeSubmissionResult> {
    const { action, type } = resolveMt5ActionAndType({
      intent: 'cancel-pending',
      kind: request.kind,
      side: request.side,
    });

    return this.sendRequest(
      {
        action,
        login: request.login,
        order: request.orderId,
        symbol: request.gatewaySymbol,
        type,
      },
      signal,
    );
  }

  /**
   * POST /api/Trade/send_request.
   *
   * NEVER automatically retried. A gateway that advertises trade idempotency
   * receives a stable key, but a timeout still resolves to `unknown` and the
   * caller reconciles authoritative state before offering a same-key retry.
   */
  private async sendRequest(
    payload: Record<string, string | number>,
    signal?: AbortSignal,
  ): Promise<TradeSubmissionResult> {
    const requestId = newRequestId();

    // Sent only when the gateway reports that it deduplicates. Where it does,
    // a retry of a timed-out submission returns the ORIGINAL result instead of
    // opening a second position.
    const idempotencyKey = this.supportsIdempotency() ? requestId : undefined;

    let response;
    try {
      response = await this.http.request({
        endpoint: 'trade-send-request',
        path: '/api/Trade/send_request',
        method: 'POST',
        body: { ...payload, source: 'tv', clientRequestId: requestId },
        schema: tradeResultSchema,
        idempotencyKey,
        signal,
        // MT5 execution plus the gateway's own settle-and-poll cycle
        // (200ms + up to 3 × 100ms) needs headroom.
        timeoutMs: 25_000,
      });
    } catch (error) {
      const tradingError = TradingError.from(error, { requestId });
      if (tradingError.kind === 'timeout') {
        // The request may well have executed. Saying "failed" would be a lie.
        return {
          state: 'unknown',
          orderId: null,
          retcode: null,
          message: this.supportsIdempotency()
            ? 'The outcome is unknown — reconciling. Retrying with the same key is safe.'
            : 'The outcome is unknown — reconciling with the trading server.',
          requestId,
          idempotencyKey,
        };
      }
      if (tradingError.kind === 'contract') {
        // The submission reached the gateway and the gateway answered — this
        // app just could not read the answer. Every gateway path that produces
        // an unreadable reply (an empty dealer body, a result poll that came
        // back in an unexpected shape) has ALREADY sent the request to MT5, so
        // the order may be live. Reporting a hard failure would tell the trader
        // nothing happened and invite an immediate resubmit — a duplicate
        // position. Reconcile instead, and keep the parse detail for support.
        return {
          state: 'unknown',
          orderId: null,
          retcode: null,
          message:
            'The trading server’s reply could not be read — reconciling. Check Positions before retrying.',
          requestId,
          idempotencyKey,
          diagnostic: tradingError,
        };
      }

      // A gateway failure envelope whose body says the outcome is undecided.
      // `unknownOutcome` (internal/domain/trade.go) rides on success=false for
      // "the result could not be read from MT5" and "a submission with this key
      // is still in flight" — both of which mean the order may be live. Only
      // the body distinguishes those from "submission not attempted".
      const stated = statedOutcome(tradingError.payload);
      if (stated?.outcome === 'unknown') {
        return {
          state: 'unknown',
          orderId: null,
          retcode: null,
          message:
            stated.message ??
            'The outcome is unknown — reconciling. Check Positions before retrying.',
          requestId,
          idempotencyKey,
          diagnostic: tradingError,
        };
      }

      throw tradingError;
    }

    return interpretTradeResult(response.data, requestId);
  }
}

/**
 * Normalises every trade-result shape into one domain result.
 *
 * Shapes accepted (see docs/integration/contract-discrepancies.md#D1):
 *   A. `PlaceOrderAnswer` — raw MT5, carries `ResultRetcode`
 *   B. `PlacedOrder` — the Go gateway's source=tv transform, which now states
 *      the verdict outright as `outcome` + `resultRetcode`
 *   C. `{ order, mTresult, answer }` — the .NET-era shape
 *   D. `{ order: 0, status: 5, outcome: "unknown", … }` — the gateway's
 *      "submitted, result not readable" fallback
 *
 * Precedence is by AUTHORITY, not by shape: `outcome` first (the gateway states
 * it and tells clients to branch on it), then MT5's own retcode, then the
 * legacy `mTresult`, and only last the derived `status` integer.
 *
 * `status` is last for a reason. The gateway derives it with an exact-match
 * table (`transform/enums.go#GetStatusType`) keyed on `"10009"`, while MT5
 * actually sends `"10009 Done"` — so every real retcode falls through to the
 * default, 5, which reads as Rejected. Branching on it first reported accepted
 * orders as refused.
 *
 * The result is `accepted` only when the server said so, and NEVER `filled`:
 * a fill is confirmed by the authoritative position/order state, not by the
 * mutation response. Anything undecided is `unknown` — never a failure, because
 * the order may be live.
 */
export function interpretTradeResult(data: unknown, requestId: string): TradeSubmissionResult {
  const record = (data ?? {}) as Record<string, unknown>;

  // MT5's retcode, under either spelling: `ResultRetcode` on the raw answer,
  // `resultRetcode` on the gateway's transform.
  const rawRetcode = firstString(record.ResultRetcode) ?? firstString(record.resultRetcode) ?? null;
  const retcode = rawRetcode ? parseRetcode(rawRetcode).code || rawRetcode : null;

  const orderId = firstId(record.Order, record.id, unwrapLegacyOrderId(record.order));
  const message =
    firstString(record.Comment) ??
    firstString(record.message) ??
    firstString(record.retcodeDescription) ??
    firstString(record.answer) ??
    null;

  const accepted = (): TradeSubmissionResult => ({
    state: 'accepted',
    orderId: orderId ? asOrderId(orderId) : null,
    retcode,
    message,
    requestId,
  });

  const undecided = (why: string): TradeSubmissionResult => ({
    state: 'unknown',
    orderId: orderId ? asOrderId(orderId) : null,
    retcode,
    message: why,
    requestId,
  });

  // ── 1. The gateway's stated verdict ──────────────────────────────────────
  const outcome = firstString(record.outcome)?.toLowerCase();
  if (outcome === 'accepted') return accepted();
  if (outcome === 'rejected') {
    throw rawRetcode
      ? tradeErrorFromRetcode(rawRetcode, message ?? undefined, requestId)
      : new TradingError({
          kind: 'rejected',
          code: 'mt5.rejected',
          message: message?.trim() || 'The trade server rejected this request.',
          requestId,
          retryable: false,
        });
  }
  // "unknown", or a word this app has never seen. Either way it is not a
  // verdict we may act on, and guessing from `status` next would be worse.
  if (outcome !== undefined) {
    return undecided(
      message?.trim() || 'The outcome is unknown — reconciling. Check Positions before retrying.',
    );
  }

  // ── 2. MT5's own retcode ─────────────────────────────────────────────────
  if (rawRetcode) {
    if (isUnknownRetcode(rawRetcode)) {
      return undecided(
        'The trade server timed out — reconciling. Check Positions before retrying.',
      );
    }
    if (!isSuccessRetcode(rawRetcode)) {
      throw tradeErrorFromRetcode(rawRetcode, message ?? undefined, requestId);
    }
    return accepted();
  }

  // ── 3. Legacy `{ order, mTresult, answer }`. mTresult 0 = rejected. ───────
  if (record.order && typeof record.order === 'object') {
    if (record.mTresult === 0) {
      throw new TradingError({
        kind: 'rejected',
        code: 'mt5.rejected',
        message: message?.trim() || 'The trade server rejected this request.',
        requestId,
        retryable: false,
      });
    }
    return accepted();
  }

  // ── 4. Last resort: the derived TradingView status integer. ──────────────
  if (record.status === 5) {
    throw new TradingError({
      kind: 'rejected',
      code: 'mt5.rejected',
      message: message?.trim() || 'The trade server rejected this request.',
      requestId,
      retryable: false,
    });
  }

  return accepted();
}

function firstString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** Reads a gateway verdict out of a body that rode along with a failure. */
function statedOutcome(
  payload: unknown,
): { outcome: string; message: string | undefined } | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const record = payload as Record<string, unknown>;
  const outcome = firstString(record.outcome)?.toLowerCase();
  if (!outcome) return undefined;
  return { outcome, message: firstString(record.message) };
}

/** The legacy shape nests the ticket as `{ order: { id } }`. */
function unwrapLegacyOrderId(order: unknown): unknown {
  if (order && typeof order === 'object' && !Array.isArray(order)) {
    return (order as Record<string, unknown>).id;
  }
  return undefined;
}

/** First candidate that yields a real ticket. `0` is MT5 for "no ticket". */
function firstId(...candidates: unknown[]): string | null {
  for (const candidate of candidates) {
    const id = toIdString(candidate);
    if (id && id !== '0') return id;
  }
  return null;
}

export { MT5_ACTION };

/**
 * Order history, most recent first.
 *
 * The gateway walks its pages oldest-first, which put the order a trader had
 * just placed at the bottom of fifty rows while the closed-positions tab beside
 * it showed the newest at the top — two views of the same afternoon, sorted
 * opposite ways (2026-08-20 retest, BUG-G). Ordered by when the order REACHED
 * its final state, falling back to when it was placed for a row the broker
 * never stamped.
 */
function newestFirst(orders: HistoricalOrder[]): HistoricalOrder[] {
  const at = (order: HistoricalOrder) => order.updateTime ?? order.setupTime ?? 0;
  return [...orders].sort((a, b) => at(b) - at(a));
}
