import { ChevronDown, ChevronUp } from 'lucide-react';
import { cn } from './cn';
import type { SortDirection, SortState } from './table-sort';

/**
 * The trading grids' shared table cells.
 *
 * `Th` and `Td` used to live inside PositionsWidget and be imported from there
 * by the other three grids, which made a shared primitive look like one
 * feature's private detail.
 */

export function Th({
  children,
  align = 'left',
  sortKey,
  sort,
  onSort,
}: {
  children: React.ReactNode;
  align?: 'left' | 'right';
  /** Omit to leave a column unsortable (an actions column, for instance). */
  sortKey?: string;
  sort?: SortState | null;
  onSort?: (key: string) => void;
}) {
  const sortable = sortKey !== undefined && onSort !== undefined;
  const active = sortable && sort?.key === sortKey ? sort.direction : null;

  return (
    <th
      scope="col"
      aria-sort={active === null ? (sortable ? 'none' : undefined) : ariaSortOf(active)}
      className={cn(
        'whitespace-nowrap px-2 py-1 font-medium',
        align === 'right' ? 'text-right' : 'text-left',
      )}
    >
      {sortable ? (
        <button
          type="button"
          onClick={() => onSort(sortKey)}
          // The label states the ACTION, not the state: a screen-reader user
          // needs to know what pressing it will do. aria-sort above already
          // carries the current state.
          aria-label={`Sort by ${typeof children === 'string' ? children : sortKey}`}
          // The button fills the whole cell — the negative margins reclaim the
          // th's `px-2 py-1`, restored as the button's own padding — so the
          // pointer target is the entire header, never the ~16px text line
          // (MED-03: sort controls fell under the 24px minimum-target size).
          // `min-h-6` is the floor that guarantees 24px even in a short row.
          className={cn(
            '-mx-2 -my-1 inline-flex min-h-6 w-full items-center gap-0.5 rounded px-2 py-1 hover:text-text-primary',
            align === 'right' ? 'justify-end' : 'justify-start',
            active !== null && 'text-text-primary',
          )}
        >
          {children}
          {active === 'asc' ? (
            <ChevronUp className="h-2.5 w-2.5 shrink-0" aria-hidden />
          ) : active === 'desc' ? (
            <ChevronDown className="h-2.5 w-2.5 shrink-0" aria-hidden />
          ) : null}
        </button>
      ) : (
        children
      )}
    </th>
  );
}

function ariaSortOf(direction: SortDirection): 'ascending' | 'descending' {
  return direction === 'asc' ? 'ascending' : 'descending';
}

export function Td({
  children,
  align = 'left',
}: {
  children: React.ReactNode;
  align?: 'left' | 'right';
}) {
  return (
    <td
      className={cn('whitespace-nowrap px-2 py-1', align === 'right' ? 'text-right' : 'text-left')}
    >
      {children}
    </td>
  );
}
