import { z } from 'zod';

/**
 * Boundary schemas hand-derived from the gateway source (the OpenAPI document
 * does not describe the `data` polymorphism). Each block cites the file that
 * produces the shape so it can be re-verified when the gateway changes.
 *
 * Numbers arrive from MT5 as either JSON numbers or numeric strings depending
 * on the field, so `loose*` accepts both and normalises to a string.
 */

/** Accepts a number or numeric string; yields the raw text for Decimal. */
const looseDecimal = z.union([z.number(), z.string()]).transform((v) => String(v));

const looseOptionalDecimal = z
  .union([z.number(), z.string(), z.null()])
  .optional()
  .transform((v) => (v === null || v === undefined || v === '' ? null : String(v)));

const looseInt = z.union([z.number(), z.string()]).transform((v) => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
});

const looseOptionalInt = z
  .union([z.number(), z.string(), z.null()])
  .optional()
  .transform((v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : null;
  });

/** Ticket ids stay strings — MT5 tickets exceed Number.MAX_SAFE_INTEGER. */
const ticketId = z.union([z.string(), z.number()]).transform((v) => String(v));

// ── Authentication ───────────────────────────────────────────────────────────
// internal/httpapi/handlers/handlers.go#Login / CRMLogin → { "token": "..." }

export const tokenResponseSchema = z.object({ token: z.string().min(1) });

// ── CRM accounts ─────────────────────────────────────────────────────────────
// POST {CRM}/client-api/accounts?version=1.0.0 with the CRM bearer.
// Shape mirrors shared/api/CRMApiClient.ts (UserAccount) in the working repo;
// only fields this app actually consumes are required.

export const crmAccountSchema = z.object({
  login: z.union([z.string(), z.number()]).transform((v) => String(v)),
  balance: looseOptionalDecimal,
  equity: looseOptionalDecimal,
  currency: z.string().nullish(),
  margin: looseOptionalDecimal,
  marginFree: looseOptionalDecimal,
  marginLevel: looseOptionalDecimal,
  leverage: looseOptionalDecimal,
  isReadOnly: z.boolean().nullish(),
  isEnabled: z.boolean().nullish(),
  tradingStatus: z.string().nullish(),
  type: z
    .object({
      id: z.number(),
      description: z.string().nullish(),
      title: z.string().nullish(),
      server: z.string().nullish(),
      platform: z.string().nullish(),
    })
    .nullish(),
});

export const crmAccountListSchema = z.array(crmAccountSchema);

export type CrmAccountDto = z.output<typeof crmAccountSchema>;

// ── Gateway account suffixes ─────────────────────────────────────────────────
// POST {gateway}/api/Authentication/accounts with {CRMToken}. The gateway's
// CRM_ACCOUNT_TYPE_SUFFIXES configuration is the DEPLOYMENT's authority on
// which symbol suffix each account group speaks; `suffixKnown` distinguishes
// "no suffix" (ECNPRO) from "not configured" — a client must never build
// symbol names for the latter (internal/auth/crm.go#Account).

export const gatewayAccountSuffixSchema = z.object({
  login: z.union([z.string(), z.number()]).transform((v) => String(v)),
  typeId: z.number().int().nullish(),
  suffix: z.string().default(''),
  suffixKnown: z.boolean().default(false),
  /**
   * "live" | "demo", stated per account by the gateway. Deliberately loose:
   * anything else — absent, null, a value from a newer gateway — is narrowed
   * to `unknown` downstream and renders NO badge. See account-environment.ts.
   */
  accountKind: z.unknown().nullish(),
});

export const gatewayAccountSuffixListSchema = z
  .object({ data: z.array(gatewayAccountSuffixSchema).nullish() })
  .passthrough();

export type GatewayAccountSuffixDto = z.output<typeof gatewayAccountSuffixSchema>;

// ── Symbols (source=tv) ──────────────────────────────────────────────────────
// internal/transform/tvmodels.go#TVSymbolResponse

export const tvSymbolSchema = z.object({
  ticker: z.string(),
  name: z.string(),
  description: z.string().default(''),
  type: z.string().default(''),
  session: z.string().default('24x7'),
  timezone: z.string().default('Etc/UTC'),
  exchange: z.string().default(''),
  listed_exchange: z.string().default(''),
  format: z.string().default('price'),
  pricescale: looseInt,
  minmov: looseInt,
  volume_precision: looseInt,
  data_status: z.string().default('streaming'),
  has_intraday: z.boolean().default(true),
  has_daily: z.boolean().default(true),
  has_weekly_and_monthly: z.boolean().default(true),
  supported_resolutions: z.array(z.string()).default([]),
  intraday_multipliers: z.array(z.string()).default(['1']),
  has_empty_bars: z.boolean().default(false),
  visible_plots_set: z.string().default('ohlcv'),
  currency_code: z.string().default(''),
  base_name: z.string().default(''),
  full_name: z.string().default(''),
  pro_name: z.string().default(''),
  sector: z.string().default(''),
  industry: z.string().default(''),
  delay: looseInt,
  volume: looseInt,
  // Tradable bounds in LOTS. `volume_precision` is NOT a volume limit — it is
  // VolumeMin cast to an int, and reading it as lots once blocked all trading.
  volume_min_lots: looseOptionalDecimal,
  volume_max_lots: looseOptionalDecimal,
  volume_step_lots: looseOptionalDecimal,
});

export const tvSymbolListSchema = z.array(tvSymbolSchema);
export type TvSymbolDto = z.output<typeof tvSymbolSchema>;

// ── Raw MT5 symbol detail (source=mt5) ───────────────────────────────────────
// Carries the volume/contract/tick fields the TV shape drops. Fields are
// optional because MT5 builds differ; the mapper reports them as unavailable
// rather than substituting zero.

export const mt5SymbolDetailSchema = z
  .object({
    Symbol: z.string().optional(),
    Description: z.string().optional(),
    Digits: looseOptionalInt,
    ContractSize: looseOptionalDecimal,
    VolumeMin: looseOptionalDecimal,
    VolumeMax: looseOptionalDecimal,
    VolumeStep: looseOptionalDecimal,
    VolumeMinExt: looseOptionalDecimal,
    VolumeMaxExt: looseOptionalDecimal,
    VolumeStepExt: looseOptionalDecimal,
    TickSize: looseOptionalDecimal,
    TickValue: looseOptionalDecimal,
    CurrencyBase: z.string().optional(),
    CurrencyProfit: z.string().optional(),
    TradeMode: looseOptionalInt,
    Path: z.string().optional(),
  })
  .passthrough();

export type Mt5SymbolDetailDto = z.output<typeof mt5SymbolDetailSchema>;

// ── Quotes (source=tv) ───────────────────────────────────────────────────────
// internal/transform/funcs.go#QuotesToTV → transform.Quote

export const tvQuoteSchema = z.object({
  symbolname: z.string(),
  status: z.string(),
  bid: looseDecimal,
  ask: looseDecimal,
  lastprice: looseDecimal,
  volume: looseOptionalDecimal,
  /**
   * When the BROKER printed the quote, in UTC unix seconds — the same base as
   * bar times. Optional because a gateway older than the quote-timestamp change
   * omits it entirely; consumers must treat null as "no broker time available"
   * rather than substituting the local clock.
   */
  time: looseOptionalInt,
});

export const tvQuoteListSchema = z.array(tvQuoteSchema);
export type TvQuoteDto = z.output<typeof tvQuoteSchema>;

// ── Bars (source=tv) ─────────────────────────────────────────────────────────
// internal/transform/tvmodels.go#TVTickResponse. `volume` is a nullable int.

export const tvBarSchema = z.object({
  time: looseInt,
  open: looseDecimal,
  high: looseDecimal,
  low: looseDecimal,
  close: looseDecimal,
  volume: looseOptionalDecimal,
});

export const tvBarListSchema = z.array(tvBarSchema);
export type TvBarDto = z.output<typeof tvBarSchema>;

// ── Positions (source=tv) ────────────────────────────────────────────────────
// internal/transform/funcs.go#PositionsToTVPage (REST) and #PositionsToTVWs (WS).
//
// VERIFIED DIFFERENCE: the WebSocket mapping emits `timeCreate` ONLY — it does
// NOT carry priceSL/priceTP. The REST page mapping carries all three. The
// mapper marks SL/TP as unavailable rather than 0 when they are absent.
// Note `Id` is capitalised in the Go struct tag.

export const tvPositionSchema = z.object({
  Id: ticketId,
  profit: looseDecimal,
  qty: looseDecimal,
  side: looseInt,
  symbol: z.string(),
  type: looseInt,
  last: looseDecimal,
  price: looseDecimal,
  timeCreate: looseOptionalInt,
  priceSL: looseOptionalDecimal,
  priceTP: looseOptionalDecimal,
  // Added by the gateway alongside the originals. `qty` remains MT5 units;
  // `qtyLots` is the same value already converted, which removes a whole class
  // of unit bug. Optional so an older gateway still works.
  qtyLots: looseOptionalDecimal,
  swap: looseOptionalDecimal,
  commission: looseOptionalDecimal,
});

export const tvPositionListSchema = z.array(tvPositionSchema);
export type TvPositionDto = z.output<typeof tvPositionSchema>;

// ── Orders (source=tv) ───────────────────────────────────────────────────────
// internal/transform/funcs.go#OrdersToTVStd (REST /Order/get_page) and
// #OrdersToTVV2 (WS GetPagebyPageOrder).
//
// VERIFIED DIFFERENCE: V2 sets `status` from MT5ToTVType(State) while Std sets
// it from MT5ToTVStatus(State). They are DIFFERENT tables over the same input,
// so the same MT5 order can report a different `status` integer over REST vs
// WebSocket. See docs/integration/contract-discrepancies.md#D3.

export const tvOrderSchema = z.object({
  id: ticketId,
  symbol: z.string(),
  side: looseInt,
  type: looseInt,
  qty: looseDecimal,
  limitPrice: looseDecimal,
  stopPrice: looseDecimal,
  last: looseOptionalDecimal,
  status: looseInt,
  stopLoss: looseOptionalDecimal,
  takeProfit: looseOptionalDecimal,
  filledQty: looseOptionalDecimal,
  updateTime: looseOptionalInt,
  message: z.string().nullish(),
  timeSetup: looseOptionalInt,
  qtyLots: looseOptionalDecimal,
  filledQtyLots: looseOptionalDecimal,
  /** Unix seconds; 0 means good-till-cancelled. */
  expiration: looseOptionalInt,
  typeTime: looseOptionalInt,
});

export const tvOrderListSchema = z.array(tvOrderSchema);
export type TvOrderDto = z.output<typeof tvOrderSchema>;

/**
 * Account leverage and the values the BROKER permits.
 *
 * `choices` is authoritative and may be empty — MT5 does not enumerate them,
 * so a deployment that has not been told what is allowed offers nothing rather
 * than a guessed range.
 */
export const leverageSchema = z.object({
  login: looseOptionalInt,
  leverage: looseInt,
  min: looseInt,
  max: looseInt,
  choices: z.array(looseInt).default([]),
});
export type LeverageState = z.output<typeof leverageSchema>;

/**
 * GET /api/User/get without `source=tv` — the raw MT5 user record.
 *
 * Only the MT5 GROUP is read. It is the one field that identifies which set of
 * broker conditions an account trades under, and the only thing a trader can
 * quote back to their broker to establish what kind of account it is. Passthrough
 * keeps the rest, which is deliberately not modelled here: this app has no
 * business rendering a user record.
 */
export const mt5UserGroupSchema = z
  .object({
    answer: z
      .object({
        Group: z.string().optional(),
        group: z.string().optional(),
      })
      .passthrough()
      .optional(),
    Group: z.string().optional(),
    group: z.string().optional(),
  })
  .passthrough();
export type Mt5UserGroupDto = z.output<typeof mt5UserGroupSchema>;

// ── Account trade state (source=mt5) ─────────────────────────────────────────
// internal/domain/user.go#GetTradeState with source != "tv" returns the raw MT5
// body: { retcode, answer: { Login, Balance, Equity, Profit, Margin,
// MarginFree, MarginLevel, MarginLeverage, ... } }.
//
// The WS TP=3 stream returns this SAME raw shape (GetUserServiceData applies no
// TV transform), which is why the working integration reads `data.answer.Balance`.

export const mt5AccountAnswerSchema = z
  .object({
    Login: z.union([z.string(), z.number()]).optional(),
    Currency: z.string().optional(),
    CurrencyDigits: looseOptionalInt,
    Balance: looseOptionalDecimal,
    Credit: looseOptionalDecimal,
    Equity: looseOptionalDecimal,
    Profit: looseOptionalDecimal,
    Margin: looseOptionalDecimal,
    MarginFree: looseOptionalDecimal,
    MarginLevel: looseOptionalDecimal,
    MarginLeverage: looseOptionalDecimal,
  })
  .passthrough();

export const mt5AccountResponseSchema = z
  .object({
    retcode: z.string().optional(),
    answer: mt5AccountAnswerSchema,
  })
  .passthrough();

export type Mt5AccountAnswerDto = z.output<typeof mt5AccountAnswerSchema>;

/** Accepts either the wrapper or a bare answer object (WS vs REST framing). */
export const accountStateSchema = z.union([
  mt5AccountResponseSchema.transform((v) => v.answer),
  mt5AccountAnswerSchema,
]);

// ── User record (source=mt5) ─────────────────────────────────────────────────

export const mt5UserAnswerSchema = z
  .object({
    Login: z.union([z.string(), z.number()]).optional(),
    Name: z.string().optional(),
    Group: z.string().optional(),
    Leverage: looseOptionalDecimal,
    Rights: looseOptionalInt,
  })
  .passthrough();

export const mt5UserResponseSchema = z.union([
  z
    .object({ answer: mt5UserAnswerSchema })
    .passthrough()
    .transform((v) => v.answer),
  mt5UserAnswerSchema,
]);

/**
 * MT5 Manager API `EnUsersRights` flags.
 *
 * Values confirmed against two independent implementations of the Manager API
 * protocol. Note `USER_RIGHT_DEFAULT = 0x163`, which INCLUDES
 * `USER_RIGHT_PASSWORD (0x02)` — so bit 1 is set on virtually every account and
 * must never be read as a trading restriction.
 *
 * When `Rights` is absent the account is NOT assumed tradable-or-not; see
 * `readOnlyFromRights`.
 */
export const MT5_RIGHT_ENABLED = 0x01; // client allowed to connect
export const MT5_RIGHT_PASSWORD = 0x02; // client allowed to change password
export const MT5_RIGHT_TRADE_DISABLED = 0x04; // client trading disabled
export const MT5_RIGHT_INVESTOR = 0x08; // client is investor (read-only)
export const MT5_RIGHT_READONLY = 0x200; // client is readonly

// ── Deals (history) ──────────────────────────────────────────────────────────
// /api/Deal/get_page returns the raw MT5 body. MT5 casing varies by build, so
// both cases are accepted at the boundary and normalised in the mapper.

export const mt5DealSchema = z
  .object({
    Deal: ticketId.optional(),
    deal: ticketId.optional(),
    // The ORDER this deal executed. MT5 stamps it on every trade deal, and it
    // is what lets a fill price be attributed to the order that requested it.
    Order: ticketId.optional(),
    order: ticketId.optional(),
    OrderID: ticketId.optional(),
    orderId: ticketId.optional(),
    PositionID: ticketId.optional(),
    positionID: ticketId.optional(),
    PositionId: ticketId.optional(),
    positionId: ticketId.optional(),
    Position: ticketId.optional(),
    position: ticketId.optional(),
    Action: looseOptionalInt,
    action: looseOptionalInt,
    Entry: looseOptionalInt,
    entry: looseOptionalInt,
    Symbol: z.string().optional(),
    symbol: z.string().optional(),
    Volume: looseOptionalDecimal,
    volume: looseOptionalDecimal,
    VolumeExt: looseOptionalDecimal,
    volumeExt: looseOptionalDecimal,
    Price: looseOptionalDecimal,
    price: looseOptionalDecimal,
    Profit: looseOptionalDecimal,
    profit: looseOptionalDecimal,
    Storage: looseOptionalDecimal,
    storage: looseOptionalDecimal,
    Swap: looseOptionalDecimal,
    swap: looseOptionalDecimal,
    Commission: looseOptionalDecimal,
    commission: looseOptionalDecimal,
    Time: looseOptionalInt,
    time: looseOptionalInt,
    Comment: z.string().nullish(),
    comment: z.string().nullish(),
  })
  .passthrough();

export const mt5DealListSchema = z.array(mt5DealSchema);
export type Mt5DealDto = z.output<typeof mt5DealSchema>;

/**
 * /api/History/get_page?source=tv — the gateway's TV mapping of MT5's
 * closed-orders history (filled, cancelled, rejected, expired), one row per
 * ORDER. Times are unix SECONDS, already converted to UTC by the gateway.
 * `qty`/`filledQty` are MT5 1/10000-lot units; `qtyLots`/`filledQtyLots` are
 * real lots (see the gateway's docs/VOLUME-UNITS.md).
 */
export const tvOrderHistorySchema = z
  .object({
    id: z.union([z.string(), z.number()]).transform((v) => String(v)),
    symbol: z.string(),
    side: z.number(),
    type: z.number(),
    qty: z.number().nullish(),
    qtyLots: z.number().nullish(),
    filledQty: z.number().nullish(),
    filledQtyLots: z.number().nullish(),
    limitPrice: z.number().nullish(),
    stopPrice: z.number().nullish(),
    stopLoss: z.number().nullish(),
    takeProfit: z.number().nullish(),
    status: z.number(),
    updateTime: z.number().nullish(),
    timeSetup: z.number().nullish(),
    // When the order reached its FINAL state, or absent while it is still
    // working. `updateTime` falls back to the setup time for TradingView's
    // benefit; this one does not, so an unfinished order can be rendered as
    // unfinished rather than as completed the moment it was placed.
    timeDone: z.number().nullish(),
    message: z.string().nullish(),
  })
  .passthrough();

export const tvOrderHistoryListSchema = z.array(tvOrderHistorySchema);
export type TvOrderHistoryDto = z.output<typeof tvOrderHistorySchema>;

/**
 * MT5 deal actions that represent an actual trade. Everything else (balance,
 * credit, commission, tax, bonus, …) is a ledger entry and must not be shown
 * as a closed position. Preserved from the working integration's history fix.
 */
export const MT5_TRADE_DEAL_ACTIONS = new Set([0, 1]);
/** Deal actions 13/14 additionally appear as buy/sell-cancel variants. */
export const MT5_TRADE_DEAL_ACTIONS_EXTENDED = new Set([0, 1, 13, 14]);

// ── Trade result ─────────────────────────────────────────────────────────────
// The gateway's POST /api/Trade/send_request with source=tv returns
// transform.PlacedOrder (internal/transform/tvmodels.go). The .NET-era shape
// `{ order, mTresult, answer }` is ALSO accepted because the working staging
// backend returns it — see docs/integration/contract-discrepancies.md#D1.

/**
 * The gateway's tri-state verdict (`transform.TradeOutcome`). Unrecognised
 * values are kept as-is rather than dropped: a value this app does not know is
 * still better evidence than the `status` integer it would otherwise fall back
 * to, and `interpretTradeResult` treats anything it cannot classify as unknown.
 */
const tradeOutcome = z.string().nullish();

export const placedOrderSchema = z
  .object({
    id: ticketId,
    symbol: z.string().default(''),
    side: looseOptionalInt,
    type: looseOptionalInt,
    qty: looseOptionalDecimal,
    status: looseOptionalInt,
    message: z.string().nullish(),
    avgPrice: looseOptionalDecimal,
    filledQty: looseOptionalDecimal,
    limitPrice: looseOptionalDecimal,
    stopPrice: looseOptionalDecimal,
    stopLoss: looseOptionalDecimal,
    takeProfit: looseOptionalDecimal,
    updateTime: looseOptionalInt,

    // The shipped gateway states MT5's verdict explicitly instead of leaving it
    // to be inferred. `outcome` is the field to branch on: `status` is derived
    // by an EXACT-match retcode table (transform/enums.go#GetStatusType) that
    // real MT5 values ("10009 Done") never match, so it defaults to 5 —
    // "rejected" — on perfectly good orders.
    outcome: tradeOutcome,
    resultRetcode: z.string().nullish(),
    retcodeDescription: z.string().nullish(),
    qtyLots: looseOptionalDecimal,
    filledQtyLots: looseOptionalDecimal,
  })
  .passthrough();

export const legacyTradeResultSchema = z
  .object({
    order: z.object({ id: ticketId }).passthrough(),
    mTresult: looseOptionalInt,
    answer: z.string().nullish(),
  })
  .passthrough();

/** Raw PlaceOrderAnswer (source omitted / non-tv) from internal/transform/upstream.go. */
export const placeOrderAnswerSchema = z
  .object({
    Order: ticketId,
    Symbol: z.string().default(''),
    Type: z
      .union([z.string(), z.number()])
      .optional()
      .transform((v) => (v === undefined ? null : String(v))),
    Volume: looseOptionalDecimal,
    PriceOrder: looseOptionalDecimal,
    PriceSL: looseOptionalDecimal,
    PriceTP: looseOptionalDecimal,
    Comment: z.string().nullish(),
    ResultRetcode: z
      .union([z.string(), z.number()])
      .optional()
      .transform((v) => (v === undefined ? null : String(v))),
    ResultPrice: looseOptionalDecimal,
    ResultVolume: looseOptionalDecimal,
  })
  .passthrough();

/**
 * The gateway's "the submission left, the result did not come back" object
 * (`internal/domain/trade.go#unknownOutcome`):
 *
 *   { order: 0, status: 5, outcome: "unknown", resultRetcode: "", message: "…" }
 *
 * `order` is a NUMBER here, not the legacy `{ order: { id } }` object, and
 * there is no `id`/`Order` — so it matched none of the three order shapes and
 * arrived as "the trading server returned data this app does not understand".
 * That reading was wrong in the worst direction: the order may well be live.
 */
export const tradeUnknownOutcomeSchema = z
  .object({
    order: z.union([z.string(), z.number()]),
    status: looseOptionalInt,
    outcome: z.string(),
    resultRetcode: z.string().nullish(),
    message: z.string().nullish(),
  })
  .passthrough();

export const tradeResultSchema = z.union([
  placeOrderAnswerSchema,
  legacyTradeResultSchema,
  placedOrderSchema,
  tradeUnknownOutcomeSchema,
]);

export type TradeResultDto = z.output<typeof tradeResultSchema>;

// ── Server time ──────────────────────────────────────────────────────────────
// internal/httpapi/handlers/handlers.go#TestServerTime is NOT enveloped; it
// returns a bare { "unixTimestamp": "..." } with 200.

export const serverTimeSchema = z.object({
  unixTimestamp: z.union([z.string(), z.number()]).transform((v) => Number(v)),
  // broker_clock − UTC, in seconds. Additive (newer gateways only); the
  // broker's trading-day boundary cannot be derived client-side without it.
  brokerOffsetSeconds: z
    .union([z.string(), z.number()])
    .transform((v) => Number(v))
    .nullish(),
});

// ── Market depth ─────────────────────────────────────────────────────────────
// /api/Tick/get_marketdepth. The gateway now classifies the raw MT5 book into
// bids and asks and states its own volume unit, so the ladder no longer has to
// guess. `unclassified` counts entries whose side code it did not recognise —
// surfaced rather than silently dropped.

const depthLevelSchema = z.object({
  price: looseDecimal,
  volume: looseDecimal,
  /** True for a market order resting at no specific price. */
  market: z.boolean().nullish(),
});

export const marketDepthSchema = z.object({
  symbol: z.string(),
  /** The gateway states this explicitly; do not assume. */
  volumeUnit: z.string().default('lots'),
  bids: z.array(depthLevelSchema).default([]),
  asks: z.array(depthLevelSchema).default([]),
  /** True when the best bid is at or above the best ask. */
  crossed: z.boolean().nullish(),
  unclassified: looseOptionalInt,
  /**
   * Whether the gateway actually holds a book subscription for this symbol.
   *
   * Depth is delivered to subscribers only, so an empty ladder means one of two
   * very different things — the instrument publishes no depth, or the gateway
   * was never able to ask. Absent on a gateway too old to say, which is read as
   * "no claim either way" rather than as a failure.
   */
  subscribed: z.boolean().nullish(),
  /** Why the subscription is absent, when the gateway knows. */
  subscribeError: z.string().nullish(),
});

export type MarketDepthDto = z.output<typeof marketDepthSchema>;
export type DepthLevelDto = z.output<typeof depthLevelSchema>;
