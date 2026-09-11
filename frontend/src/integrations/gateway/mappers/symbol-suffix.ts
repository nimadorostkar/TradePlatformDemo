/**
 * Symbol suffix policy.
 *
 * TradePlatform MT5 groups append an account-type suffix to certain symbols
 * (`EURUSD.` for ECN, `EURUSD!` for Standard, `EURUSD#` for Social, none for
 * ECNPRO). The gateway speaks SUFFIXED names; TradingView and the UI show
 * UNSUFFIXED names.
 *
 * Extracted from broker-sample/src/AccountInitializer.class.ts and
 * shared/utils/SymbolSuffixManager.class.ts in the working integration, with
 * two deliberate changes:
 *   1. It is an instance bound to the active account, not a localStorage
 *      singleton — so an account switch cannot leak the previous suffix.
 *   2. `removeSuffix` strips a KNOWN delimiter only when the remaining stem is
 *      a symbol that actually takes a suffix, instead of splitting on the first
 *      delimiter unconditionally.
 */

/** Verified against shared/utils/constants.ts (SYMBOLS_REQUIRING_SUFFIX). */
export const SYMBOLS_REQUIRING_SUFFIX: ReadonlySet<string> = new Set([
  // Forex
  'EURCZK',
  'EURHUF',
  'EURNOK',
  'EURPLN',
  'EURSEK',
  'EURTRY',
  'SGDJPY',
  'USDCNH',
  'USDCZK',
  'USDHKD',
  'USDHUF',
  'USDMXN',
  'USDNOK',
  'USDPLN',
  'USDRUB',
  'USDSEK',
  'USDSGD',
  'USDTRY',
  'USDZAR',
  'AUDUSD',
  'EURUSD',
  'GBPUSD',
  'NZDUSD',
  'USDCAD',
  'USDCHF',
  'USDJPY',
  'AUDCAD',
  'AUDCHF',
  'AUDJPY',
  'AUDNZD',
  'CADCHF',
  'CADJPY',
  'CHFJPY',
  'EURAUD',
  'EURCAD',
  'EURCHF',
  'EURGBP',
  'EURJPY',
  'EURNZD',
  'GBPAUD',
  'GBPCAD',
  'GBPCHF',
  'GBPJPY',
  'GBPNZD',
  'NZDCAD',
  'NZDCHF',
  'NZDJPY',
  // Indices
  'ASXAUD',
  'DAXEUR',
  'DJIUSD',
  'ESXEUR',
  'F40EUR',
  'FTSGBP',
  'HSIHKD',
  'IBXEUR',
  'NDXUSD',
  'NIKJPY',
  'SPXUSD',
  // Commodities
  'BRNUSD',
  'NGCUSD',
  'WTIUSD',
  'XAGUSD',
  'XAUUSD',
  'XPDUSD',
  'XPTUSD',
  // Other
  'DXY',
]);

export const SUFFIX_DELIMITERS = ['.', '!', '#'] as const;
export type SuffixDelimiter = (typeof SUFFIX_DELIMITERS)[number];

/**
 * CRM account type id → suffix.
 * Verified against DEFAULT_ACCOUNT_TYPE_SUFFIXES in AccountInitializer.class.ts.
 */
export const ACCOUNT_TYPE_SUFFIXES: Readonly<Record<number, string>> = {
  // ECN
  57: '.',
  61: '.',
  65: '.',
  // Standard
  58: '!',
  62: '!',
  66: '!',
  // ECNPRO — no suffix
  59: '',
  63: '',
  67: '',
  // Social
  60: '#',
  64: '#',
};

/**
 * Account type ids this platform will trade.
 *
 * NOTE the deliberate divergence: the gateway's own CRM filter
 * (internal/auth/crm.go#crmAllowedTypeIDs) also admits 11 and 26, but the
 * working TradingView integration's DEFAULT_VALID_ACCOUNT_TYPE_IDS does not,
 * and no suffix is defined for those ids. Trading a type whose suffix policy is
 * unknown would send wrong symbol names, so we keep the narrower set and
 * surface any excluded account as unsupported rather than silently mistrading.
 * See docs/integration/contract-discrepancies.md#D5.
 */
export const SUPPORTED_ACCOUNT_TYPE_IDS: ReadonlySet<number> = new Set([
  57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67,
]);

export function suffixForAccountType(typeId: number | null | undefined): string | null {
  if (typeId === null || typeId === undefined) return null;
  const suffix = ACCOUNT_TYPE_SUFFIXES[typeId];
  return suffix === undefined ? null : suffix;
}

/**
 * Suffix policy for one account. Construct a new one on every account switch;
 * never mutate a shared instance.
 */
export class SymbolSuffixPolicy {
  readonly suffix: string;

  constructor(suffix: string) {
    this.suffix = suffix;
  }

  static forAccountType(typeId: number | null | undefined): SymbolSuffixPolicy {
    return new SymbolSuffixPolicy(suffixForAccountType(typeId) ?? '');
  }

  /** UI/TradingView name → gateway name. */
  toGateway(displaySymbol: string): string {
    const stem = displaySymbol.replace(/^[A-Za-z]+:/, '');
    if (!this.suffix) return stem;
    if (!SYMBOLS_REQUIRING_SUFFIX.has(stem)) return stem;
    if (stem.endsWith(this.suffix)) return stem;
    return stem + this.suffix;
  }

  /** Gateway name → UI/TradingView name. */
  toDisplay(gatewaySymbol: string): string {
    return stripKnownSuffix(gatewaySymbol);
  }
}

/**
 * Removes a trailing suffix delimiter only when what remains is a symbol known
 * to take one. This protects symbols whose real name ends in a delimiter
 * character; the original implementation split unconditionally.
 */
export function stripKnownSuffix(symbol: string): string {
  const name = symbol.replace(/^[A-Za-z]+:/, '');
  for (const delimiter of SUFFIX_DELIMITERS) {
    if (!name.endsWith(delimiter)) continue;
    const stem = name.slice(0, -delimiter.length);
    if (SYMBOLS_REQUIRING_SUFFIX.has(stem)) return stem;
  }
  return name;
}

/** The no-suffix policy, used before an account is selected. */
export const NO_SUFFIX_POLICY = new SymbolSuffixPolicy('');
