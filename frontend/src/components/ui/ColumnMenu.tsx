import { useEffect, useMemo, useRef, useState } from 'react';
import { Columns3 } from 'lucide-react';
import { cn } from './cn';
import { useWorkspace } from '@/workspace/layout/workspace-store';

/**
 * Column visibility for a data table.
 *
 * Preferences are stored as the HIDDEN set rather than the visible one, so a
 * column added in a later release shows up by default instead of silently
 * staying hidden for everyone who already has a saved workspace.
 */

export interface ColumnDefinition {
  id: string;
  label: string;
  /** Columns the table is meaningless without, e.g. the symbol. */
  required?: boolean;
}

export function useTableColumns(tableId: string, columns: readonly ColumnDefinition[]) {
  const hidden = useWorkspace((s) => s.workspace.tables[tableId]?.hiddenColumns);

  const hiddenSet = useMemo(() => new Set(hidden ?? []), [hidden]);

  const visible = useMemo(
    () => columns.filter((column) => column.required || !hiddenSet.has(column.id)),
    [columns, hiddenSet],
  );

  const isVisible = useMemo(
    () => (id: string) => visible.some((column) => column.id === id),
    [visible],
  );

  return { visible, hiddenSet, isVisible };
}

export function ColumnMenu({
  tableId,
  columns,
}: {
  tableId: string;
  columns: readonly ColumnDefinition[];
}) {
  const hidden = useWorkspace((s) => s.workspace.tables[tableId]?.hiddenColumns);
  const toggleColumn = useWorkspace((s) => s.toggleTableColumn);
  const resetColumns = useWorkspace((s) => s.resetTableColumns);

  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const hiddenSet = useMemo(() => new Set(hidden ?? []), [hidden]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      <button
        aria-label="Choose columns"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((value) => !value)}
        className="hit-target justify-center rounded p-1 text-text-muted hover:bg-[var(--surface-raised)] hover:text-text-primary"
      >
        <Columns3 className="h-3 w-3" aria-hidden />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-6 z-50 w-44 rounded border border-[var(--border-strong)] bg-[var(--surface-overlay)] p-1 shadow-[var(--shadow-panel)]"
        >
          {columns.map((column) => {
            const checked = column.required || !hiddenSet.has(column.id);
            return (
              <label
                key={column.id}
                className={cn(
                  'flex items-center gap-2 rounded px-2 py-1 text-2xs',
                  column.required
                    ? 'cursor-not-allowed text-text-muted'
                    : 'cursor-pointer text-text-primary hover:bg-[var(--surface-raised)]',
                )}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={column.required}
                  onChange={() => toggleColumn(tableId, column.id)}
                />
                {column.label}
                {column.required ? <span className="ml-auto text-2xs">always</span> : null}
              </label>
            );
          })}

          <div className="my-1 border-t border-[var(--border-default)]" />
          <button
            role="menuitem"
            onClick={() => {
              resetColumns(tableId);
              setOpen(false);
            }}
            className="block w-full rounded px-2 py-1 text-left text-2xs text-text-secondary hover:bg-[var(--surface-raised)]"
          >
            Show all columns
          </button>
        </div>
      )}
    </div>
  );
}
