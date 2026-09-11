/**
 * Sorting for the trading grids.
 *
 * Positions, Orders, History and Deals were all real tables with real header
 * cells — and not one column could be sorted, so on an account with 78 deals a
 * trader could not order by profit, by date or by symbol. The markup was
 * already right; only the behaviour was missing.
 */

import { useCallback, useMemo, useState } from 'react';

export type SortDirection = 'asc' | 'desc';

export interface SortState {
  key: string;
  direction: SortDirection;
}

/** What a cell sorts by. Null always sorts last, whichever way the arrow points. */
export type SortValue = string | number | null;

/**
 * Compares two cell values.
 *
 * Prices, volumes and money are decimal STRINGS, so they are compared
 * numerically: lexical order puts "9.5" above "10.0", which on a P/L column is
 * not a cosmetic difference. Text falls back to a locale-aware compare.
 */
function compareValues(a: Exclude<SortValue, null>, b: Exclude<SortValue, null>): number {
  if (typeof a === 'number' || typeof b === 'number') {
    return Number(a) - Number(b);
  }

  const numericA = Number(a);
  const numericB = Number(b);
  if (a !== '' && b !== '' && Number.isFinite(numericA) && Number.isFinite(numericB)) {
    return numericA - numericB;
  }
  return String(a).localeCompare(String(b));
}

/**
 * Sorts rows for display.
 *
 * `id` breaks ties, and is load-bearing rather than tidy: Positions and Orders
 * are replaced wholesale by every WebSocket frame, so a sort on a ticking
 * column (P/L, Current) would otherwise reshuffle equal rows several times a
 * second under the trader's cursor.
 */
export function sortRows<T>(
  rows: readonly T[],
  sort: SortState | null,
  valueOf: (row: T, key: string) => SortValue,
  id: (row: T) => string,
): readonly T[] {
  if (sort === null) return rows;
  const factor = sort.direction === 'asc' ? 1 : -1;

  return [...rows].sort((a, b) => {
    const left = valueOf(a, sort.key);
    const right = valueOf(b, sort.key);

    // A missing value is not "small", it is absent: it belongs at the bottom
    // of BOTH directions, so it is settled before the direction is applied —
    // otherwise ascending order opens with a column of dashes.
    if (left === null || right === null) {
      if (left !== right) return left === null ? 1 : -1;
    } else {
      const compared = compareValues(left, right);
      if (compared !== 0) return compared * factor;
    }

    return id(a).localeCompare(id(b));
  });
}

export interface TableSort {
  sort: SortState | null;
  /**
   * Cycles a column: first click sorts descending — the useful end of profit,
   * volume and time — then ascending, then back to the grid's natural order,
   * which for History and Deals is the broker's own newest-first ordering.
   */
  toggle: (key: string) => void;
}

export function useTableSort(initial: SortState | null = null): TableSort {
  const [sort, setSort] = useState<SortState | null>(initial);

  const toggle = useCallback((key: string) => {
    setSort((current) => {
      if (current === null || current.key !== key) return { key, direction: 'desc' };
      if (current.direction === 'desc') return { key, direction: 'asc' };
      return null;
    });
  }, []);

  return useMemo(() => ({ sort, toggle }), [sort, toggle]);
}
