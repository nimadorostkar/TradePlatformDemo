import { describe, expect, it } from 'vitest';
import { sortRows, type SortState, type SortValue } from './table-sort';

interface Row {
  id: string;
  symbol: string;
  profit: string | null;
  openedAt: number | null;
}

const rows: Row[] = [
  { id: '3', symbol: 'XAUUSD', profit: '9.5', openedAt: 300 },
  { id: '1', symbol: 'EURUSD', profit: '10.0', openedAt: 100 },
  { id: '2', symbol: 'GBPUSD', profit: null, openedAt: null },
  { id: '4', symbol: 'AUDUSD', profit: '-2.25', openedAt: 200 },
];

const valueOf = (row: Row, key: string): SortValue =>
  key === 'symbol' ? row.symbol : key === 'profit' ? row.profit : row.openedAt;

const idOf = (row: Row) => row.id;
const sort = (state: SortState | null) => sortRows(rows, state, valueOf, idOf).map((r) => r.id);

describe('sortRows', () => {
  it('leaves the natural order alone when nothing is sorted', () => {
    expect(sort(null)).toEqual(['3', '1', '2', '4']);
  });

  it('compares money numerically, not lexically', () => {
    // The whole point: "9.5" sorts ABOVE "10.0" as text, which on a P/L
    // column is not a cosmetic difference.
    expect(sort({ key: 'profit', direction: 'desc' })).toEqual(['1', '3', '4', '2']);
    expect(sort({ key: 'profit', direction: 'asc' })).toEqual(['4', '3', '1', '2']);
  });

  it('keeps missing values last whichever way the arrow points', () => {
    // A dash is "not applicable", not "smallest" — it should not win the top
    // of the ascending sort.
    expect(sort({ key: 'profit', direction: 'asc' }).at(-1)).toBe('2');
    expect(sort({ key: 'profit', direction: 'desc' }).at(-1)).toBe('2');
  });

  it('sorts text alphabetically', () => {
    expect(sort({ key: 'symbol', direction: 'asc' })).toEqual(['4', '1', '2', '3']);
  });

  it('sorts times', () => {
    expect(sort({ key: 'openedAt', direction: 'desc' })).toEqual(['3', '4', '1', '2']);
  });

  it('breaks ties by id, so a ticking column cannot reshuffle equal rows', () => {
    // Positions and Orders are replaced wholesale by every WebSocket frame.
    // Without a stable tiebreak, rows with equal P/L would swap places
    // several times a second under the trader's cursor.
    const tied: Row[] = [
      { id: 'c', symbol: 'C', profit: '1.00', openedAt: 1 },
      { id: 'a', symbol: 'A', profit: '1.00', openedAt: 2 },
      { id: 'b', symbol: 'B', profit: '1.00', openedAt: 3 },
    ];
    const state: SortState = { key: 'profit', direction: 'desc' };
    const once = sortRows(tied, state, valueOf, idOf).map((r) => r.id);
    const again = sortRows([...tied].reverse(), state, valueOf, idOf).map((r) => r.id);

    expect(once).toEqual(['a', 'b', 'c']);
    expect(again).toEqual(once);
  });

  it('does not mutate the array it was given', () => {
    const original = [...rows];
    sortRows(rows, { key: 'profit', direction: 'asc' }, valueOf, idOf);
    expect(rows).toEqual(original);
  });
});
