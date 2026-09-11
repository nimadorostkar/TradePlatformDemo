import { newRequestId } from './ids';

/**
 * One normalised error model. Every gateway, MT5, transport, and validation
 * failure is converted into a `TradingError` at the integration boundary so no
 * React component ever inspects a raw retcode or an HTTP status.
 */

export type TradingErrorKind =
  | 'network' // request never reached the gateway
  | 'timeout' // no response within the deadline — outcome UNKNOWN for mutations
  | 'canceled' // superseded by a newer request (symbol/account change)
  | 'unauthorized' // 401 — gateway JWT missing/expired
  | 'forbidden' // 403 — login not in the token's accounts claim
  | 'validation' // client-side or gateway rejected the request shape
  | 'contract' // response did not match the verified schema
  | 'rejected' // MT5 refused the trade (retcode)
  | 'unavailable' // gateway/MT5/market data not currently available
  | 'unknown';

export interface TradingErrorInit {
  kind: TradingErrorKind;
  /** Message safe to render to a trader. Never contains tokens or internals. */
  message: string;
  /** Stable code for tests and diagnostics (e.g. `mt5.10019`, `http.403`). */
  code?: string;
  requestId?: string;
  /** Redacted technical detail for the System Messages widget. */
  detail?: string;
  retryable?: boolean;
  cause?: unknown;
  /**
   * The decoded response body, when the gateway sent one alongside a failure.
   *
   * For programmatic inspection only — the trade path reads the gateway's
   * `outcome` field out of it to tell "the submission never left" from "it left
   * and the result is unreadable". It is never rendered.
   */
  payload?: unknown;
}

export class TradingError extends Error {
  readonly kind: TradingErrorKind;
  readonly code: string;
  readonly requestId: string;
  readonly detail: string | undefined;
  readonly retryable: boolean;
  readonly at: number;
  readonly payload: unknown;

  constructor(init: TradingErrorInit) {
    super(init.message);
    this.name = 'TradingError';
    this.kind = init.kind;
    this.code = init.code ?? init.kind;
    this.requestId = init.requestId ?? newRequestId();
    this.detail = init.detail;
    this.payload = init.payload;
    // Only safe reads are ever retried automatically; a trade mutation never is.
    this.retryable = init.retryable ?? (init.kind === 'network' || init.kind === 'unavailable');
    this.at = Date.now();
    if (init.cause !== undefined) this.cause = init.cause;
  }

  static from(error: unknown, fallback: Partial<TradingErrorInit> = {}): TradingError {
    if (error instanceof TradingError) return error;
    if (error instanceof DOMException && error.name === 'AbortError') {
      return new TradingError({
        kind: 'canceled',
        message: 'Request canceled.',
        ...fallback,
        cause: error,
      });
    }
    return new TradingError({
      kind: fallback.kind ?? 'unknown',
      message: fallback.message ?? 'Something went wrong. Please try again.',
      code: fallback.code,
      requestId: fallback.requestId,
      detail: error instanceof Error ? error.message : String(error),
      cause: error,
    });
  }
}

/**
 * MT5 trade retcodes → trader-readable text.
 *
 * Only codes whose meaning is confirmed by the MT5 Manager API are mapped;
 * anything else falls through to a generic message that still carries the code
 * so support can trace it. Inventing friendly text for an unknown rejection
 * would be worse than showing the number.
 */
const MT5_RETCODE_MESSAGES: Record<string, string> = {
  '10004': 'Requote — the price moved. Review the price and try again.',
  '10006': 'The order was rejected.',
  '10007': 'The order was canceled.',
  '10008': 'The order was placed.',
  '10009': 'The request was completed.',
  '10010': 'Only part of the requested volume was filled.',
  '10011': 'The request could not be processed. Please try again.',
  '10013': 'Invalid request.',
  '10014': 'Invalid volume for this symbol.',
  '10015': 'Invalid price.',
  '10016': 'Invalid stop-loss or take-profit level.',
  '10017': 'Trading is disabled for this account.',
  '10018': 'The market is closed for this symbol.',
  '10019': 'Not enough money to complete this request.',
  '10020': 'Prices changed. Please review and resubmit.',
  '10021': 'No quotes available for this symbol.',
  '10024': 'Too many requests. Please slow down.',
  '10025': 'No changes were made to the request.',
  '10026': 'Automated trading is disabled on the server.',
  '10027': 'Automated trading is disabled by the client terminal.',
  '10029': 'The order or position is locked and being processed.',
  '10030': 'Unsupported fill policy for this symbol.',
  '10031': 'No connection to the trade server.',
  '10033': 'The maximum number of pending orders has been reached.',
  '10034': 'The order volume limit for this symbol has been reached.',
  '10036': 'The position has already been closed.',
  '10038': 'The close volume exceeds the position volume.',
  '10039': 'A close order for this position already exists.',
  '10040': 'The maximum number of open positions has been reached.',
};

/** MT5 retcodes 10008/10009/10010 mean the request was accepted, not rejected. */
export const MT5_SUCCESS_RETCODES = new Set(['10008', '10009', '10010']);
/** 10012 (timeout) means MT5 never decided — the order may still be live. */
export const MT5_UNKNOWN_RETCODES = new Set(['10012']);

/**
 * MT5 does not send a bare number: a retcode arrives as `"<code> <text>"` —
 * `"10009 Done"`, `"10019 No money"` — and the gateway forwards it verbatim
 * (`transform.PlaceOrderAnswer.ResultRetcode`). Comparing the raw string against
 * `MT5_SUCCESS_RETCODES` therefore matched NOTHING, so a completed order was
 * classified as an unrecognised rejection. Split the code off before any lookup.
 */
export function parseRetcode(raw: string | null | undefined): { code: string; text: string } {
  if (!raw) return { code: '', text: '' };
  const match = /^\s*(\d+)\s*(.*)$/.exec(raw);
  if (!match) return { code: raw.trim(), text: '' };
  return { code: match[1]!, text: match[2]!.trim() };
}

/** True when MT5's retcode says the request was taken. */
export function isSuccessRetcode(raw: string | null | undefined): boolean {
  return MT5_SUCCESS_RETCODES.has(parseRetcode(raw).code);
}

/** True when MT5's retcode leaves the outcome undecided rather than refused. */
export function isUnknownRetcode(raw: string | null | undefined): boolean {
  return MT5_UNKNOWN_RETCODES.has(parseRetcode(raw).code);
}

export function tradeErrorFromRetcode(
  retcode: string,
  serverComment?: string,
  requestId?: string,
): TradingError {
  const { code, text } = parseRetcode(retcode);
  const known = MT5_RETCODE_MESSAGES[code];
  return new TradingError({
    kind: 'rejected',
    // `code` is the bare number so `mt5.10019` stays a stable, matchable code
    // even though the wire value is "10019 No money".
    code: `mt5.${code || retcode}`,
    message: known ?? `The trade server rejected this request (code ${code || retcode}).`,
    // MT5's own words are kept when the server sent no comment of its own.
    detail: serverComment ?? (text || undefined),
    requestId,
    retryable: false,
  });
}

/** True when a rejection means "not enough margin", which gets its own CTA. */
export function isInsufficientFunds(error: TradingError): boolean {
  return error.code === 'mt5.10019';
}
