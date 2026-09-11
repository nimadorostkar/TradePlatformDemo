import { add, ZERO, type DecimalString } from '@/domain/common/decimal';
import type { ClosedPosition } from '@/domain/common/models';

/**
 * What a closed trade actually did to the balance.
 *
 * Gross profit alone is not the trader's result and never reconciles against
 * the account: MT5 moves the balance by profit + swap + commission, and both
 * charges are negative. The History headline used to sum gross profit while
 * the columns beside it showed the charges separately, so the two disagreed by
 * every fee on the account — the aggregate is the number a client checks
 * against their statement, so it is the one that has to be net.
 *
 * `commission` and `swap` on a ClosedPosition already cover both deals of the
 * position (see the pairing in to-domain.ts); this only adds them up.
 */
export function netResultOf(row: ClosedPosition): DecimalString {
  return add(add(row.profit ?? ZERO, row.swap ?? ZERO), row.commission ?? ZERO);
}

export interface HistoryTotals {
  /** Net of swap and commission — what the balance actually did. */
  net: DecimalString;
  /** Gross trading result, kept so the two can be shown apart. */
  gross: DecimalString;
  /** Swap + commission across the period, as a negative charge. */
  charges: DecimalString;
  wins: number;
  losses: number;
  /** Null rather than 0% when there are no closed trades to rate. */
  winRate: number | null;
}

/**
 * Period summary for the History tab.
 *
 * Win/loss is classified on the NET result too: a trade that made 0.03 gross
 * and paid 0.08 in commission lost money, and calling it a win while the row
 * beside it shows a loss is the same inconsistency in a different place.
 */
export function historyTotals(rows: readonly ClosedPosition[]): HistoryTotals {
  let net = ZERO;
  let gross = ZERO;
  let charges = ZERO;
  let wins = 0;

  for (const row of rows) {
    const rowNet = netResultOf(row);
    net = add(net, rowNet);
    gross = add(gross, row.profit ?? ZERO);
    charges = add(charges, add(row.swap ?? ZERO, row.commission ?? ZERO));
    if (Number(rowNet) > 0) wins++;
  }

  return {
    net,
    gross,
    charges,
    wins,
    losses: rows.length - wins,
    winRate: rows.length > 0 ? (wins / rows.length) * 100 : null,
  };
}
