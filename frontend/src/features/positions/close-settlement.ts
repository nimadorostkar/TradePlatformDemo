import type { FeaturesApi, ExecutionDto } from '@/integrations/gateway/api/features-api';
import type { SystemMessage } from '@/stores/system-messages-store';

/**
 * Authoritative close settlement (FIN-001).
 *
 * The number a trader is shown at close time must be the CLOSING DEAL's
 * settlement, not the floating P/L of the moment the button was pressed — the
 * production test saw "-0.12" reported while the balance moved by -0.13,
 * because the notification quoted a stale floating value that ignored final
 * execution price and fees.
 *
 * This reporter polls the gateway's per-fill feed briefly after an accepted
 * close, finds the closing deal(s) for the position, and reports the exact
 * breakdown MT5 settled: gross profit, commission, swap, and their net. If the
 * dealer's history hasn't caught up within the polling window, it reports
 * nothing — the Deals table will show the record; inventing a number would
 * recreate the bug this exists to fix.
 */

/** MT5 DEAL_ENTRY codes that close (fully or partially) a position. */
const CLOSING_ENTRIES = new Set([1, 2, 3]); // out, in/out, out-by

const POLL_ATTEMPTS = 4;
const POLL_GAP_MS = 1_500;
/** How far back to look for the closing deal, in seconds. */
const LOOKBACK_SECONDS = 180;

export interface CloseSettlement {
  positionId: string;
  closePrice: string;
  grossProfit: number;
  commission: number;
  swap: number;
  net: number;
  dealIds: string[];
}

/** Sums the closing fills for a position out of an execution page. */
export function settlementFromExecutions(
  fills: readonly ExecutionDto[],
  positionId: string,
  sinceSeconds: number,
): CloseSettlement | null {
  const closing = fills.filter(
    (f) =>
      f.positionId === positionId &&
      f.entry !== null &&
      f.entry !== undefined &&
      CLOSING_ENTRIES.has(f.entry) &&
      (f.timeSeconds ?? Math.floor(f.time / 1000)) >= sinceSeconds,
  );
  if (closing.length === 0) return null;

  const sum = (pick: (f: ExecutionDto) => string | number | null | undefined) =>
    closing.reduce((total, f) => {
      const v = Number(pick(f) ?? 0);
      return Number.isFinite(v) ? total + v : total;
    }, 0);

  const grossProfit = sum((f) => f.profit);
  const commission = sum((f) => f.commission);
  const swap = sum((f) => f.swap);
  const last = closing[closing.length - 1];

  return {
    positionId,
    closePrice: last ? String(last.price) : '',
    grossProfit,
    commission,
    swap,
    net: grossProfit + commission + swap,
    dealIds: closing.map((f) => f.id),
  };
}

/** Formats a settlement into the one-line System message the trader reads. */
export function settlementMessage(s: CloseSettlement, currency: string | null): string {
  const unit = currency ? ` ${currency}` : '';
  const money = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}`;
  const fees =
    s.commission !== 0 || s.swap !== 0
      ? ` (gross ${money(s.grossProfit)}, commission ${money(s.commission)}, swap ${money(s.swap)})`
      : '';
  const at = s.closePrice ? ` at ${s.closePrice}` : '';
  return `Position ${s.positionId} closed${at}: net ${money(s.net)}${unit}${fees}.`;
}

/**
 * Watches the executions feed for the closing deal and reports its settlement.
 * Fire-and-forget; never throws. `signal` is optional so an unmounted dialog
 * does not cancel the report — the message belongs to the account, not the UI.
 */
export async function reportCloseSettlement(deps: {
  features: FeaturesApi;
  login: string;
  positionId: string;
  currency: string | null;
  push: (message: Omit<SystemMessage, 'id' | 'at' | 'appVersion'>) => void;
  /**
   * Called with the settled figures, for a caller that also announced the
   * close somewhere the trader is actually looking — the toast quotes the
   * floating value otherwise, which is the number this module exists to stop
   * anyone believing.
   */
  onSettled?: (settlement: CloseSettlement) => void;
}): Promise<void> {
  const since = Math.floor(Date.now() / 1000) - LOOKBACK_SECONDS;

  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, POLL_GAP_MS));
    try {
      const fills = await deps.features.executionsSince(deps.login, since, 100);
      const settlement = settlementFromExecutions(fills, deps.positionId, since);
      if (settlement) {
        deps.push({
          level: 'success',
          scope: 'position',
          text: settlementMessage(settlement, deps.currency),
          code: 'position.settled',
          requestId: null,
        });
        deps.onSettled?.(settlement);
        return;
      }
    } catch {
      // A failed poll proves nothing; the next attempt (or the Deals table)
      // will carry the record.
    }
  }
}
