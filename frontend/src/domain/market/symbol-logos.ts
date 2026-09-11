/**
 * Symbol → logo image URLs, TradingView-style.
 *
 * A six-letter pair whose halves are both known codes gets TWO urls — the
 * library (and our own SymbolLogo component) renders them as partially
 * overlapping circles, base currency on top, exactly like tradingview.com.
 * Indices and energies get ONE url. Anything unrecognised gets none, and the
 * consumer falls back to a text monogram rather than a broken image.
 *
 * Assets are self-hosted under /public/symbol-logos (production CSP is
 * `img-src 'self'`): country flags from HatScripts/circle-flags (MIT),
 * metals/energies/crypto drawn in the same 512×512 circular format.
 */

const BASE = '/symbol-logos';

/** ISO currency (plus metal/crypto) code → icon basename. */
const CODE_ICONS: Readonly<Record<string, string>> = {
  AUD: 'au',
  CAD: 'ca',
  CHF: 'ch',
  CNH: 'cn',
  CNY: 'cn',
  CZK: 'cz',
  EUR: 'eu',
  GBP: 'gb',
  HKD: 'hk',
  HUF: 'hu',
  JPY: 'jp',
  MXN: 'mx',
  NOK: 'no',
  NZD: 'nz',
  PLN: 'pl',
  RUB: 'ru',
  SEK: 'se',
  SGD: 'sg',
  TRY: 'tr',
  USD: 'us',
  ZAR: 'za',
  // Metals trade as XXXUSD pairs; the metal side gets an ingot icon.
  XAU: 'xau',
  XAG: 'xag',
  XPT: 'xpt',
  XPD: 'xpd',
  // Crypto CFDs.
  BTC: 'btc',
  ETH: 'eth',
};

/**
 * Instruments that are not currency pairs: indices carry the flag of their
 * home market (matching how the pair grid reads), energies a product icon.
 * Keyed by unsuffixed display name.
 */
const SINGLE_ICONS: Readonly<Record<string, string>> = {
  // Indices
  ASXAUD: 'au',
  DAXEUR: 'de',
  DJIUSD: 'us',
  ESXEUR: 'eu',
  F40EUR: 'fr',
  FTSGBP: 'gb',
  HSIHKD: 'hk',
  IBXEUR: 'es',
  NDXUSD: 'us',
  NIKJPY: 'jp',
  SPXUSD: 'us',
  DXY: 'us',
  // Energies
  BRNUSD: 'oil',
  WTIUSD: 'oil',
  NGCUSD: 'gas',
};

const url = (icon: string): string => `${BASE}/${icon}.svg`;

/**
 * Logo urls for a symbol, or undefined when it has none.
 *
 * Accepts display names but is lenient about being handed a gateway name:
 * a trailing account-type suffix (`.` `!` `#` — see
 * integrations/gateway/mappers/symbol-suffix.ts) is stripped before matching,
 * so a stray suffixed name degrades to the right logo rather than to none.
 */
export function symbolLogoUrls(symbolName: string): [string] | [string, string] | undefined {
  const name = symbolName
    .trim()
    .toUpperCase()
    .replace(/[.!#]+$/, '');

  const single = SINGLE_ICONS[name];
  if (single !== undefined) return [url(single)];

  if (name.length === 6) {
    const base = CODE_ICONS[name.slice(0, 3)];
    const quote = CODE_ICONS[name.slice(3)];
    if (base !== undefined && quote !== undefined) return [url(base), url(quote)];
  }

  return undefined;
}
