/**
 * Ticket / order / position identifiers.
 *
 * MT5 tickets are 64-bit. `Number` loses precision above 2^53, so every
 * identifier stays a STRING end to end — including as an object key. Nominal
 * types stop one kind of id being passed where another is expected.
 */

export type AccountLogin = string & { readonly __brand: 'AccountLogin' };
export type OrderId = string & { readonly __brand: 'OrderId' };
export type PositionId = string & { readonly __brand: 'PositionId' };
export type DealId = string & { readonly __brand: 'DealId' };

/** Normalises an id from an untrusted gateway payload, or null if unusable. */
export function toIdString(value: unknown): string | null {
  if (typeof value === 'string') {
    const t = value.trim();
    return t === '' ? null : t;
  }
  if (typeof value === 'number') {
    // A number that already lost precision cannot be trusted as a ticket.
    if (!Number.isSafeInteger(value)) return null;
    return String(value);
  }
  if (typeof value === 'bigint') return value.toString();
  return null;
}

export const asAccountLogin = (v: string): AccountLogin => v as AccountLogin;
export const asOrderId = (v: string): OrderId => v as OrderId;
export const asPositionId = (v: string): PositionId => v as PositionId;
export const asDealId = (v: string): DealId => v as DealId;

/** Correlation id attached to every gateway request for traceability. */
export function newRequestId(): string {
  const c = globalThis.crypto;
  if (c && 'randomUUID' in c) return c.randomUUID();
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
