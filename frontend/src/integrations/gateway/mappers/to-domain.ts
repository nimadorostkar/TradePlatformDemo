import {
  add,
  cmp,
  decimalStringOf,
  div,
  isNegative,
  isZero,
  mul,
  sub,
  toDecimalString,
  toDecimalStringOrZero,
  ZERO,
  type DecimalString,
} from '@/domain/common/decimal';
import { asAccountLogin, asDealId, asOrderId, asPositionId, toIdString } from '@/domain/common/ids';
import type {
  ClosedPosition,
  Deal,
  DealKind,
  HistoricalOrder,
  HistoricalOrderStatus,
  Position,
  Quote,
  TradingAccount,
  TradingOrder,
  TradingSymbol,
} from '@/domain/common/models';
import type {
  CrmAccountDto,
  Mt5AccountAnswerDto,
  Mt5DealDto,
  Mt5SymbolDetailDto,
  TvOrderDto,
  TvOrderHistoryDto,
  TvPositionDto,
  TvQuoteDto,
  TvSymbolDto,
} from '../contracts/schemas';
import {
  MT5_RIGHT_INVESTOR,
  MT5_RIGHT_READONLY,
  MT5_RIGHT_TRADE_DISABLED,
} from '../contracts/schemas';
import type { AccountFunds } from '@/domain/account/account-environment';
import type { SymbolSuffixPolicy } from './symbol-suffix';
import {
  kindFromTvType,
  mt5VolumeToLots,
  symbolVolumeToLots,
  sideFromTvSide,
  statusFromTvStatus,
} from './trade-codes';

/**
 * Raw gateway DTO → canonical domain model.
 *
 * The single rule enforced here: a field the gateway did not supply becomes
 * `null`, never `0`. A zero stop-loss and an absent stop-loss mean completely
 * different things to a trader.
 */

// ── Symbols ──────────────────────────────────────────────────────────────────

/** Derives price decimals from TradingView's pricescale (10^digits). */
export function digitsFromPricescale(pricescale: number): number {
  if (!Number.isFinite(pricescale) || pricescale <= 1) return 0;
  return Math.round(Math.log10(pricescale));
}

/**
 * Removes the account group's marker from an instrument's TYPE.
 *
 * MT5 derives the type from the symbol PATH, which on a suffixed deployment
 * carries the group marker — so GBPUSD! on a Standard account reported its type
 * as "Forex!" in the details panel. The suffix identifies the account GROUP and
 * never the asset class.
 *
 * `SymbolSuffixPolicy.toDisplay` is deliberately not used: it strips only when
 * what remains is a known SYMBOL, which is the right rule for a ticker and no
 * rule at all for a word like "Forex".
 */
function stripGroupSuffix(type: string, suffix: string): string {
  if (!type || !suffix || !type.endsWith(suffix)) return type;
  const stem = type.slice(0, -suffix.length);
  // Never reduce a type to nothing: a marker on its own is not a type, and an
  // empty string would render as a blank row rather than as unavailable.
  return stem === '' ? type : stem;
}

export function mapTvSymbol(
  dto: TvSymbolDto,
  suffix: SymbolSuffixPolicy,
  detail?: Mt5SymbolDetailDto,
): TradingSymbol {
  const gatewayName = dto.name || dto.ticker;
  return {
    name: gatewayName,
    displayName: suffix.toDisplay(gatewayName),
    description: dto.description,
    // MT5 derives an instrument's type from its symbol PATH, which on a
    // suffixed deployment carries the account group's marker — so GBPUSD! on a
    // Standard account reported its type as "Forex!". The suffix identifies the
    // GROUP, never the asset class, and the same policy that strips it from the
    // symbol name strips it here (2026-08-21).
    type: stripGroupSuffix(dto.type, suffix.suffix),
    exchange: dto.exchange,
    digits: detail?.Digits ?? digitsFromPricescale(dto.pricescale),
    pricescale: dto.pricescale,
    minMove: dto.minmov || 1,
    // The TV symbol shape does NOT carry real volume limits — `volume_precision`
    // is VolumeMin cast to an int by the gateway transform. Only the raw MT5
    // detail can supply them, so without it they stay unavailable.
    //
    // MT5 reports these in VOLUME UNITS, not lots: `VolumeMin` of 100 means
    // 0.01 lots. Passing the raw value through made the order ticket reject
    // every realistic order with "Minimum volume is 100".
    // The gateway now publishes these already in lots. The raw MT5 record is
    // consulted only when talking to an older gateway that does not.
    volumeMin:
      toDecimalString(dto.volume_min_lots) ??
      symbolVolumeToLots(detail?.VolumeMin, detail?.VolumeMinExt),
    volumeMax:
      toDecimalString(dto.volume_max_lots) ??
      symbolVolumeToLots(detail?.VolumeMax, detail?.VolumeMaxExt),
    volumeStep:
      toDecimalString(dto.volume_step_lots) ??
      symbolVolumeToLots(detail?.VolumeStep, detail?.VolumeStepExt),
    contractSize: toDecimalString(detail?.ContractSize),
    // MT5 reports TickSize/TickValue as 0 to mean "not specified — use the
    // point (10^-digits)". A LIVE zero must map to ABSENT, never pass through:
    // it flows into TradingView's price math as a divisor, and a zero minTick
    // kills the whole trading surface ("[big.js] Division by zero" — dead
    // Order Ticket, no chart Trade actions, broken DOM price grid). Every
    // consumer already handles null by falling back to the digits-derived
    // point, which is exactly MT5's own semantics for the zero.
    tickSize: positiveDecimal(detail?.TickSize),
    tickValue: positiveDecimal(detail?.TickValue),
    // The PROFIT currency — what one unit of price movement pays out in, and
    // therefore what the account-currency conversion starts from. Only the raw
    // MT5 record knows it. The TV shape's currency_code is NOT a fallback: the
    // gateway fills it with CurrencyBase on the by-name route and the SYMBOL
    // NAME on the by-mask route (transform/funcs.go, Blocks A/B), and trusting
    // it converted EURUSD's USD figures through an EUR→USD rate they did not
    // need — Order info showed every value ×1.17 (2026-08-24 staging).
    currencyCode: detail?.CurrencyProfit || null,
    session: dto.session,
    timezone: dto.timezone,
    supportedResolutions: dto.supported_resolutions,
    sector: dto.sector || null,
    industry: dto.industry || null,
  };
}

/**
 * A strictly positive decimal, or null. Used for fields where zero is MT5's
 * encoding of "not specified" (TickSize, TickValue) — a zero kept as a value
 * would be used as a divisor downstream.
 */
function positiveDecimal(value: unknown): DecimalString | null {
  const parsed = toDecimalString(value);
  if (parsed === null) return null;
  return isZero(parsed) || isNegative(parsed) ? null : parsed;
}

// ── Quotes ───────────────────────────────────────────────────────────────────

/**
 * A tick, or null when the tick carries no prices.
 *
 * MT5 sends 0 for a price it does not have — a symbol whose feed has not
 * started, or one the account's group cannot see. Coercing that to the string
 * "0" produced a quote object that every consumer's `if (!quote)` guard
 * happily accepted: the order ticket rendered a 0.00000 face and left BUY and
 * SELL enabled, and a market order could be submitted at a price of zero.
 *
 * "No prices" is not a price. A tick without a positive bid AND ask does not
 * become a quote, so the guards that already exist everywhere start working —
 * the ticket disables itself and says why, and the grids show a dash. A symbol
 * that was quoting and then sends zeros keeps its last real quote, which the
 * staleness badge is there to mark.
 */
export function mapTvQuote(
  dto: TvQuoteDto,
  previous?: Quote,
  receivedAt = Date.now(),
  requestedSymbol?: string,
): Quote | null {
  const bid = positiveDecimal(dto.bid);
  const ask = positiveDecimal(dto.ask);
  if (bid === null || ask === null) return null;
  const last = toDecimalStringOrZero(dto.lastprice);

  let direction: Quote['direction'] = 'flat';
  if (previous) {
    const delta = Number(last) - Number(previous.last);
    direction = delta > 0 ? 'up' : delta < 0 ? 'down' : previous.direction;
  }

  return {
    // The REQUESTED symbol wins over the echoed one. Every consumer looks the
    // quote up under the name it subscribed with; MT5 is free to label the
    // tick with a group-normalised variant of that name, and trusting the
    // echo strands the quote under a key nobody reads — live prices on the
    // wire, dashes in every panel.
    symbol: requestedSymbol ?? dto.symbolname,
    bid,
    ask,
    last,
    volume: toDecimalString(dto.volume),
    receivedAt,
    // The wire carries UTC SECONDS; the rest of the client works in ms. A
    // non-positive value is MT5's "unset", not 1970 — treat it as absent.
    brokerTime: dto.time !== null && dto.time > 0 ? dto.time * 1000 : null,
    direction,
  };
}

// ── Account ──────────────────────────────────────────────────────────────────

export function mapAccountState(
  login: string,
  dto: Mt5AccountAnswerDto,
  options: {
    name?: string;
    server?: string | null;
    /** From the CRM accounts list — see the currency fallback below. */
    currency?: string | null;
    readOnly?: boolean;
    asOf?: number;
  } = {},
): TradingAccount {
  const marginLevel = toDecimalString(dto.MarginLevel);
  return {
    login: asAccountLogin(login),
    name: options.name ?? login,
    // This trading server's get_trade_state answer carries no Currency at all,
    // and a null here nulls every account-currency conversion downstream — the
    // Order info block showed "—" for pip/trade value and margin on a healthy
    // USD account (2026-08-24). The CRM accounts list DOES know the deposit
    // currency, so it fills in wherever MT5 stays silent; MT5 still wins when
    // it does answer, being the closer authority.
    currency: dto.Currency ?? options.currency ?? null,
    server: options.server ?? null,
    balance: toDecimalStringOrZero(dto.Balance),
    // Null, not zero: a server that does not report credit and one that
    // reports none are different facts, and only the second may be shown as 0.
    credit: toDecimalString(dto.Credit),
    equity: toDecimalStringOrZero(dto.Equity),
    profit: toDecimalStringOrZero(dto.Profit),
    margin: toDecimalStringOrZero(dto.Margin),
    marginFree: toDecimalStringOrZero(dto.MarginFree),
    // MT5 reports 0 margin level when no margin is in use. That is "not
    // applicable", not "0%", so it is surfaced as unavailable.
    marginLevel: marginLevel && Number(marginLevel) > 0 ? marginLevel : null,
    leverage: toDecimalString(dto.MarginLeverage),
    readOnly: options.readOnly ?? false,
    asOf: options.asOf ?? Date.now(),
  };
}

/**
 * Reads the MT5 `Rights` bitmask, or null when the field is absent.
 *
 * Three distinct flags all mean "this account cannot place trades":
 * TRADE_DISABLED, INVESTOR (read-only login), and READONLY.
 *
 * Deliberately does NOT consider `USER_RIGHT_PASSWORD (0x02)`. That bit means
 * "may change password", it is part of MT5's default rights mask, and reading
 * it as a restriction marks nearly every real account read-only.
 */
export function readOnlyFromRights(rights: number | null | undefined): boolean | null {
  if (rights === null || rights === undefined) return null;
  const cannotTrade = MT5_RIGHT_TRADE_DISABLED | MT5_RIGHT_INVESTOR | MT5_RIGHT_READONLY;
  return (rights & cannotTrade) !== 0;
}

export interface AccountOption {
  login: string;
  name: string;
  /**
   * Whether this account holds real money, as STATED by the gateway — never
   * inferred here. `unknown` until the server says, and `unknown` shows no
   * badge rather than guessing "live". See domain/account/account-environment.
   */
  kind: AccountFunds;
  typeId: number | null;
  server: string | null;
  currency: string | null;
  readOnly: boolean;
  enabled: boolean;
  /**
   * The symbol suffix this account's MT5 group speaks, resolved at list time:
   * the GATEWAY's per-deployment configuration when it reports one
   * (suffixKnown), otherwise the built-in type map. Empty string is a real
   * answer (ECNPRO); null means no source knows — such an account must never
   * build symbol names.
   */
  suffix: string | null;
}

export function mapCrmAccount(dto: CrmAccountDto): AccountOption {
  const typeId = dto.type?.id ?? null;
  const label = dto.type?.description || dto.type?.title || 'Account';
  return {
    login: dto.login,
    name: `${label} ${dto.login}`,
    // The CRM does not state it; the gateway's per-login answer is merged in
    // by listAccounts. Unknown until then, which is the safe reading.
    kind: 'unknown',
    typeId,
    server: dto.type?.server ?? null,
    currency: dto.currency ?? null,
    // The CRM is authoritative for investor/read-only status; if it does not
    // say, we do NOT infer tradability from UI state.
    readOnly: dto.isReadOnly === true,
    enabled: dto.isEnabled !== false,
    // Resolved by the caller against the gateway's answer; the CRM itself
    // knows nothing about MT5 symbol naming.
    suffix: null,
  };
}

// ── Positions ────────────────────────────────────────────────────────────────

export function mapTvPosition(dto: TvPositionDto, suffix: SymbolSuffixPolicy): Position | null {
  const id = toIdString(dto.Id);
  if (!id) return null;
  // Same rule as orders: a position with no symbol cannot be shown, valued or
  // closed, and the library would try to subscribe a quote for nothing.
  if (!dto.symbol.trim()) return null;

  return {
    id: asPositionId(id),
    symbol: dto.symbol,
    displaySymbol: suffix.toDisplay(dto.symbol),
    side: sideFromTvSide(dto.side),
    // Prefer the gateway's own conversion; fall back to converting the MT5
    // units ourselves when talking to an older gateway.
    volume: dto.qtyLots !== null ? toDecimalStringOrZero(dto.qtyLots) : mt5VolumeToLots(dto.qty),
    openPrice: toDecimalStringOrZero(dto.price),
    currentPrice: toDecimalString(dto.last),
    // Both the REST and WS mappings now carry these. MT5 still encodes "no
    // level" as 0.0, so a zero maps to null rather than showing a stop at zero.
    stopLoss: nullIfZero(dto.priceSL),
    takeProfit: nullIfZero(dto.priceTP),
    profit: toDecimalString(dto.profit),
    swap: toDecimalString(dto.swap),
    commission: toDecimalString(dto.commission),
    openTime: dto.timeCreate !== null && dto.timeCreate > 0 ? dto.timeCreate * 1000 : null,
    comment: null,
  };
}

// ── Orders ───────────────────────────────────────────────────────────────────

export function mapTvOrder(dto: TvOrderDto, suffix: SymbolSuffixPolicy): TradingOrder | null {
  const id = toIdString(dto.id);
  if (!id) return null;
  // A record with no symbol is not an order anyone can act on — it cannot be
  // priced, rendered, modified or cancelled. It must also never reach the
  // charting library, which subscribes QUOTES for every row it is given and
  // has nothing to ask the datafeed for. `mapTvOrderHistory` has always
  // refused these; live orders are the ones that become Account Manager rows,
  // and they were let through.
  if (!dto.symbol.trim()) return null;

  const kind = kindFromTvType(dto.type);
  const price = kind === 'stop' ? toDecimalString(dto.stopPrice) : toDecimalString(dto.limitPrice);

  const filledLots =
    dto.filledQtyLots !== null
      ? toDecimalString(dto.filledQtyLots)
      : dto.filledQty === null
        ? null
        : mt5VolumeToLots(dto.filledQty);

  return {
    id: asOrderId(id),
    symbol: dto.symbol,
    displaySymbol: suffix.toDisplay(dto.symbol),
    side: sideFromTvSide(dto.side),
    kind,
    // REST and WS now BOTH populate `status` from MT5ToTVStatus, so one table
    // reads both. The WS path previously used an order-TYPE table, which made
    // filled and rejected indistinguishable.
    status: statusFromTvStatus(dto.status),
    volume: dto.qtyLots !== null ? toDecimalStringOrZero(dto.qtyLots) : mt5VolumeToLots(dto.qty),
    filledVolume: filledLots,
    price: nullIfZeroString(price),
    currentPrice: nullIfZero(dto.last),
    stopLoss: nullIfZero(dto.stopLoss),
    takeProfit: nullIfZero(dto.takeProfit),
    // 0 means good-till-cancelled — an absent expiry, not 1970.
    expiration: dto.expiration !== null && dto.expiration > 0 ? dto.expiration * 1000 : null,
    createdAt: dto.timeSetup !== null && dto.timeSetup > 0 ? dto.timeSetup * 1000 : null,
    comment: dto.message?.trim() || null,
  };
}

// ── Deals & history ──────────────────────────────────────────────────────────

/** Tolerates both MT5 casings at the boundary only. */
function pick<T>(...values: (T | null | undefined)[]): T | null {
  for (const value of values) {
    if (value !== null && value !== undefined && value !== ('' as unknown as T)) return value;
  }
  return null;
}

function dealKindFromAction(action: number | null): DealKind {
  if (action === null) return 'other';
  if (action === 0 || action === 1) return 'trade';
  if (action === 2) return 'balance';
  if (action === 3) return 'credit';
  if (action === 4 || action === 5 || action === 6) return 'commission';
  return 'other';
}

export function mapDeal(dto: Mt5DealDto, suffix: SymbolSuffixPolicy): Deal | null {
  const id = toIdString(pick(dto.Deal, dto.deal));
  if (!id) return null;

  const positionRaw = toIdString(
    pick(
      dto.PositionID,
      dto.positionID,
      dto.PositionId,
      dto.positionId,
      dto.Position,
      dto.position,
    ),
  );
  const action = pick(dto.Action, dto.action);
  const symbol = pick(dto.Symbol, dto.symbol);
  const entry = pick(dto.Entry, dto.entry);
  const kind = dealKindFromAction(action);
  const volumeUnits = pick(dto.Volume, dto.volume, dto.VolumeExt, dto.volumeExt);
  const time = pick(dto.Time, dto.time);

  const orderRaw = toIdString(pick(dto.Order, dto.order, dto.OrderID, dto.orderId));

  return {
    id: asDealId(id),
    positionId: positionRaw ? asPositionId(positionRaw) : null,
    orderId: orderRaw && orderRaw !== '0' ? asOrderId(orderRaw) : null,
    kind,
    entry,
    symbol,
    displaySymbol: symbol ? suffix.toDisplay(symbol) : null,
    // MT5 deal action 0 = buy, 1 = sell for trade deals; other actions have no side.
    side: kind === 'trade' && action !== null ? (action === 0 ? 'buy' : 'sell') : null,
    // A deposit or a credit has no volume and no price, and MT5 says so with
    // a zero. Kept as "0" the row claimed to have been dealt at a price of
    // zero, while Symbol and Side beside it correctly showed a dash.
    volume: volumeUnits === null ? null : nullIfZeroString(mt5VolumeToLots(volumeUnits)),
    price: nullIfZero(pick(dto.Price, dto.price)),
    profit: toDecimalString(pick(dto.Profit, dto.profit)),
    swap: toDecimalString(pick(dto.Storage, dto.storage, dto.Swap, dto.swap)),
    commission: toDecimalString(pick(dto.Commission, dto.commission)),
    time: time !== null && time > 0 ? time * 1000 : null,
    comment: pick(dto.Comment, dto.comment)?.trim() || null,
  };
}

/**
 * One row of /api/History/get_page?source=tv — a historical ORDER in its
 * final state. Times arrive as UTC seconds; volumes in real lots via
 * `qtyLots` (with the raw 1/10000-lot `qty` as fallback for older gateways).
 */
export function mapTvOrderHistory(
  dto: TvOrderHistoryDto,
  suffix: SymbolSuffixPolicy,
): HistoricalOrder | null {
  if (!dto.id || !dto.symbol) return null;

  const lots = (real: number | null | undefined, tenThousandths: number | null | undefined) => {
    if (typeof real === 'number' && real > 0) return toDecimalString(real);
    if (typeof tenThousandths === 'number' && tenThousandths > 0) {
      return toDecimalString(tenThousandths / 10_000);
    }
    return null;
  };
  const price = (value: number | null | undefined) =>
    typeof value === 'number' && value > 0 ? toDecimalString(value) : null;
  const timeMs = (seconds: number | null | undefined) =>
    typeof seconds === 'number' && seconds > 0 ? seconds * 1000 : null;

  return {
    id: dto.id,
    symbol: dto.symbol,
    displaySymbol: suffix.toDisplay(dto.symbol),
    side: dto.side === -1 ? 'sell' : 'buy',
    kind: tvOrderKind(dto.type),
    volumeLots: lots(dto.qtyLots, dto.qty),
    filledLots: lots(dto.filledQtyLots, dto.filledQty),
    price: price(dto.limitPrice) ?? price(dto.stopPrice),
    stopLoss: price(dto.stopLoss),
    takeProfit: price(dto.takeProfit),
    status: tvOrderHistoryStatus(dto.status),
    // `timeDone` is the authority: it is the instant the order reached its
    // final state, and null while it has not. `updateTime` is the older
    // compatibility field, which falls back to the setup time — reading that
    // first would put the PLACED time back in the final-state column of every
    // row, which is the whole of the defect being fixed here. A gateway too
    // old to send `timeDone` at all still gets the old field.
    updateTime: dto.timeDone === undefined ? timeMs(dto.updateTime) : timeMs(dto.timeDone),
    setupTime: timeMs(dto.timeSetup),
    comment: dto.message?.trim() || null,
  };
}

/** TV numeric order type → domain kind. */
function tvOrderKind(type: number): HistoricalOrder['kind'] {
  switch (type) {
    case 1:
      return 'limit';
    case 2:
      return 'market';
    case 3:
      return 'stop';
    case 4:
      return 'stoplimit';
    default:
      return 'unknown';
  }
}

/** TV numeric order status → domain status. 3 (Inactive) is MT5 "expired". */
function tvOrderHistoryStatus(status: number): HistoricalOrderStatus {
  switch (status) {
    case 1:
      return 'canceled';
    case 2:
      return 'filled';
    case 3:
      return 'expired';
    case 4:
      return 'placing';
    case 5:
      return 'rejected';
    case 6:
      return 'working';
    default:
      return 'unknown';
  }
}

/**
 * Pairs opening and closing deals into closed positions.
 *
 * Preserves the working integration's history fixes: ledger entries are
 * excluded, deals are paired by position id, and a closing deal missing its
 * symbol inherits it from the opening deal instead of rendering "Unknown".
 */
/** MT5 DEAL_ENTRY values. */
const DEAL_ENTRY_IN = 0;
const DEAL_ENTRY_INOUT = 2;

/**
 * An entry deal and the part of it not yet charged to a closed row.
 *
 * A position costs commission twice — once entering, once leaving — and MT5
 * puts each charge on its own deal. Reading only the closing deal understated
 * every trade by its entry commission, which on an ECN account is most of the
 * cost. So the entry's charges are carried here and spent as volume closes.
 */
interface OpenLeg {
  deal: Deal;
  /** Entry volume not yet matched by an exit. */
  remainingVolume: DecimalString;
  /** Entry-side charges not yet attributed to a closed row. */
  remainingCommission: DecimalString;
  remainingSwap: DecimalString;
}

function openLegOf(deal: Deal): OpenLeg {
  return {
    deal,
    remainingVolume: deal.volume ?? ZERO,
    remainingCommission: deal.commission ?? ZERO,
    remainingSwap: deal.swap ?? ZERO,
  };
}

interface EntryCharges {
  commission: DecimalString;
  swap: DecimalString;
}

const NO_CHARGES: EntryCharges = { commission: ZERO, swap: ZERO };

/**
 * The share of the entry's charges that belongs to one exit, by closed volume.
 *
 * A partial close must not be billed the whole entry commission — the entry
 * deal stays registered so later exits can pair with it, so charging it in
 * full would bill it again on every subsequent close. The last exit takes
 * whatever is left rather than a computed share, which keeps the parts summing
 * exactly to the whole with no rounding drift.
 */
function chargeEntry(leg: OpenLeg, closedVolume: DecimalString): EntryCharges {
  const share =
    cmp(leg.remainingVolume, ZERO) > 0 && cmp(closedVolume, leg.remainingVolume) < 0
      ? div(closedVolume, leg.remainingVolume)
      : null;

  if (share === null) {
    // Final (or only, or unmeasurable) exit: take everything still owed.
    const charged = { commission: leg.remainingCommission, swap: leg.remainingSwap };
    leg.remainingCommission = ZERO;
    leg.remainingSwap = ZERO;
    leg.remainingVolume = ZERO;
    return charged;
  }

  const charged = {
    commission: mul(leg.remainingCommission, share),
    swap: mul(leg.remainingSwap, share),
  };
  leg.remainingCommission = sub(leg.remainingCommission, charged.commission);
  leg.remainingSwap = sub(leg.remainingSwap, charged.swap);
  leg.remainingVolume = sub(leg.remainingVolume, closedVolume);
  return charged;
}

/**
 * Adds an entry-side charge to the closing deal's own.
 *
 * Null survives only when there was nothing on either side: a row that reports
 * no commission must mean "none was charged", not "we looked at one deal".
 */
function sumCharges(closing: DecimalString | null, entry: DecimalString): DecimalString | null {
  if (closing === null && isZero(entry)) return null;
  return add(closing ?? ZERO, entry);
}

export function pairDealsIntoClosedPositions(deals: readonly Deal[]): ClosedPosition[] {
  // Chronological order is load-bearing: an exit pairs with the entry that
  // was CURRENT when it happened. A reversal (DEAL_ENTRY_INOUT) both closes
  // the old leg and opens the next one under the same position id, so a
  // by-id map built in one pass would pair the first leg's exit with the
  // second leg's entry.
  const trades = deals
    .filter((deal) => deal.kind === 'trade' && deal.positionId !== null)
    .sort((a, b) => (a.time ?? 0) - (b.time ?? 0));

  const currentEntry = new Map<string, OpenLeg>();
  const closed: ClosedPosition[] = [];

  for (const deal of trades) {
    const positionId = deal.positionId!;

    if (deal.entry === DEAL_ENTRY_IN) {
      // Plain opening leg. NOT deleted on a later OUT: a partial close pairs
      // every subsequent exit with this same entry.
      currentEntry.set(positionId, openLegOf(deal));
      continue;
    }

    // Everything else — OUT (1), INOUT (2, reversal), OUT_BY (3, close-by) —
    // closes volume and produces a row. An entry may legitimately be absent:
    // the position opened before the fetched window.
    const leg = currentEntry.get(positionId);
    const opening = leg?.deal;
    const symbol = deal.symbol ?? opening?.symbol;
    if (symbol) {
      const closedVolume = deal.volume ?? opening?.volume ?? ZERO;
      const entryCharges = leg ? chargeEntry(leg, closedVolume) : NO_CHARGES;

      closed.push({
        id: positionId,
        symbol,
        displaySymbol: deal.displaySymbol ?? opening?.displaySymbol ?? symbol,
        // The closing deal's side is the opposite of the position's direction.
        side: opening?.side ?? (deal.side === 'buy' ? 'sell' : 'buy'),
        volume: closedVolume,
        openPrice: opening?.price ?? null,
        closePrice: deal.price,
        openTime: opening?.time ?? null,
        closeTime: deal.time,
        profit: deal.profit,
        // Both legs, not just the closing one: see OpenLeg.
        swap: sumCharges(deal.swap, entryCharges.swap),
        commission: sumCharges(deal.commission, entryCharges.commission),
        ...(opening === undefined ? { openedBeforeRange: true } : {}),
      });
    }

    // A reversal is ALSO the entry of the leg that follows it.
    if (deal.entry === DEAL_ENTRY_INOUT) currentEntry.set(positionId, openLegOf(deal));
  }

  return closed.sort((a, b) => (b.closeTime ?? 0) - (a.closeTime ?? 0));
}

/** Ledger entries (deposits, credits, commissions) for the transactions tab. */
export function ledgerEntries(deals: readonly Deal[]): Deal[] {
  return deals.filter((d) => d.kind !== 'trade').sort((a, b) => (b.time ?? 0) - (a.time ?? 0));
}

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * MT5 encodes "no stop-loss / no take-profit" as 0.0. Preserving that as the
 * string "0" would render a protective level that does not exist.
 */
function nullIfZero(value: string | null | undefined): DecimalString | null {
  const parsed = toDecimalString(value);
  if (parsed === null) return null;
  return Number(parsed) === 0 ? null : parsed;
}

function nullIfZeroString(value: DecimalString | null): DecimalString | null {
  if (value === null) return null;
  return Number(value) === 0 ? null : value;
}

export { nullIfZero };

/** Formats a lot volume to the conventional two decimals for display. */
export function formatLots(value: DecimalString): string {
  return decimalStringOf(value);
}
