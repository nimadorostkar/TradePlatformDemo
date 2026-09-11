import type { Deal } from '@/domain/common/models';

/**
 * Volume-weighted average execution price per order, from its trade deals.
 *
 * Weighted because one order can fill in several deals at different prices;
 * quoting the first of them would understate or overstate what the trader
 * actually got. An order with no deals in the window (cancelled, rejected,
 * expired, or filled outside it) is simply absent, and the table falls back to
 * the order's own price rather than inventing one.
 */
export function fillPrices(deals: readonly Deal[]): ReadonlyMap<string, string> {
  const byOrder = new Map<string, { price: string; volume: number }[]>();
  for (const deal of deals) {
    if (deal.kind !== 'trade' || deal.orderId === null || deal.price === null) continue;
    const price = Number(deal.price);
    const volume = Number(deal.volume);
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(volume) || volume <= 0) continue;
    const legs = byOrder.get(deal.orderId) ?? [];
    legs.push({ price: deal.price, volume });
    byOrder.set(deal.orderId, legs);
  }

  const out = new Map<string, string>();
  for (const [orderId, legs] of byOrder) {
    // One deal is the overwhelmingly common case, and its price is passed
    // through verbatim: dividing a single price by its own weight would round-
    // trip through a float and could render 1.16758 as 1.1675800000000001.
    if (legs.length === 1) {
      out.set(orderId, legs[0]!.price);
      continue;
    }
    let value = 0;
    let volume = 0;
    let digits = 0;
    for (const leg of legs) {
      value += Number(leg.price) * leg.volume;
      volume += leg.volume;
      digits = Math.max(digits, (leg.price.split('.')[1] ?? '').length);
    }
    out.set(orderId, (value / volume).toFixed(digits));
  }
  return out;
}
