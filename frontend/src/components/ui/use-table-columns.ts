import { useMemo } from 'react';
import type { ColumnDefinition } from './ColumnMenu';
import { useWorkspace } from '@/workspace/layout/workspace-store';

/**
 * The visible columns of a data table, from the workspace's saved preferences.
 * See ColumnMenu for why the HIDDEN set is what is stored.
 */
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
