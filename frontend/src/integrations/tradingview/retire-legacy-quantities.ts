/**
 * Removes the charting library's own default order quantity from its store.
 *
 * The library persists a per-symbol quantity under `tradingview.trading.<broker>`
 * and seeds a symbol it has never seen with **1** — one LOT on a field whose
 * step is 0.01, which is how a one-click chart order went in a hundred times
 * the intended size. `qty.default` fixes symbols it has not stored yet; it does
 * not rewrite one already saved, and every profile from before that fix still
 * carries the 1.
 *
 * An earlier attempt corrected those symbols through the library's own
 * `setQty` while a chart was running. It could not win: the library restores
 * its persisted value as it finishes setting a symbol up, and that restore
 * lands after ours — the write read back as applied, was recorded as done, and
 * was then quietly reverted.
 *
 * So the stale entries are DELETED instead, before any widget exists to
 * restore them. Deleting rather than rewriting also means no value is invented
 * here: the library re-seeds each symbol from the `qty.default` its adapter
 * supplies, which is the instrument's real minimum.
 *
 * Only entries that are still exactly the library's own 1 are touched — a
 * quantity the trader chose is left alone — and the pass runs once per browser.
 */

const STAMP = 'opotrade.tv-qty-default.v2';
const LIBRARY_DEFAULT_QTY = 1;
const TRADING_KEY = /^tradingview\.trading\./;

export function retireLegacyChartQuantities(): void {
  let storage: Storage;
  try {
    if (localStorage.getItem(STAMP) !== null) return;
    storage = localStorage;
  } catch {
    return; // storage blocked; nothing to migrate against
  }

  try {
    for (const key of Object.keys(storage)) {
      if (!TRADING_KEY.test(key)) continue;

      const raw = storage.getItem(key);
      if (!raw) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        continue; // not every key under this prefix holds JSON
      }

      const quantities = (parsed as { qty?: unknown } | null)?.qty;
      if (typeof quantities !== 'object' || quantities === null) continue;

      let changed = false;
      for (const [symbol, value] of Object.entries(quantities as Record<string, unknown>)) {
        if (value === LIBRARY_DEFAULT_QTY) {
          delete (quantities as Record<string, unknown>)[symbol];
          changed = true;
        }
      }
      if (changed) storage.setItem(key, JSON.stringify(parsed));
    }
    storage.setItem(STAMP, '1');
  } catch {
    // A failure leaves the stamp unwritten, so the next boot tries again.
  }
}
