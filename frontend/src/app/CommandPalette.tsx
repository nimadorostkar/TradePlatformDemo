import { useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/components/ui/cn';
import { widgetRegistry } from '@/workspace/widgets/registry';
import { useWorkspace } from '@/workspace/layout/workspace-store';
import type { RegionId } from '@/workspace/registry/types';

/**
 * Command palette.
 *
 * This is what makes the workspace fully keyboard-operable: moving a widget
 * between docks, toggling a region, switching chart layout, and jumping to a
 * symbol are all reachable without a pointer, which drag-and-drop alone cannot
 * provide.
 */

interface Command {
  id: string;
  label: string;
  group: string;
  run: () => void;
  keywords?: string;
}

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const workspace = useWorkspace((s) => s.workspace);
  const activateWidget = useWorkspace((s) => s.activateWidget);
  const addWidget = useWorkspace((s) => s.addWidget);
  const moveWidget = useWorkspace((s) => s.moveWidget);
  const toggleRegion = useWorkspace((s) => s.toggleRegionCollapsed);
  const setChartLayout = useWorkspace((s) => s.setChartLayout);
  const setActiveSymbol = useWorkspace((s) => s.setActiveSymbol);
  const setTheme = useWorkspace((s) => s.setTheme);
  const setDensity = useWorkspace((s) => s.setDensity);
  const resetToDefault = useWorkspace((s) => s.resetToDefault);
  const saveAs = useWorkspace((s) => s.saveAs);

  const commands = useMemo<Command[]>(() => {
    const list: Command[] = [];

    // Open / focus a panel.
    for (const widget of widgetRegistry.values()) {
      list.push({
        id: `open-${widget.id}`,
        label: `Open ${widget.title}`,
        group: 'Panels',
        keywords: widget.description,
        run: () => {
          addWidget(widget.id, widget.defaultRegion);
          activateWidget(widget.id);
        },
      });

      // Move a panel between docks — the keyboard equivalent of dragging.
      for (const region of widget.allowedRegions) {
        if (region === 'center-overlay') continue;
        list.push({
          id: `move-${widget.id}-${region}`,
          label: `Move ${widget.title} to ${regionLabel(region)}`,
          group: 'Layout',
          run: () => moveWidget(widget.id, { region }),
        });
      }
    }

    for (const region of ['left', 'right', 'bottom'] as const) {
      list.push({
        id: `toggle-${region}`,
        label: `${workspace.regions[region].collapsed ? 'Expand' : 'Collapse'} ${regionLabel(region)}`,
        group: 'Layout',
        run: () => toggleRegion(region),
      });
    }

    for (const layout of ['single', 'two-vertical', 'two-horizontal', 'three', 'four'] as const) {
      list.push({
        id: `chart-${layout}`,
        label: `Chart layout: ${chartLayoutLabel(layout)}`,
        group: 'Charts',
        run: () => setChartLayout(layout),
      });
    }

    for (const watchlist of workspace.watchlists) {
      for (const symbol of watchlist.symbols) {
        list.push({
          id: `symbol-${symbol}`,
          label: symbol,
          group: 'Symbols',
          run: () => setActiveSymbol(symbol),
        });
      }
    }

    list.push(
      {
        id: 'theme-dark',
        label: 'Theme: dark',
        group: 'Appearance',
        run: () => setTheme('dark'),
      },
      {
        id: 'theme-light',
        label: 'Theme: light',
        group: 'Appearance',
        run: () => setTheme('light'),
      },
      {
        id: 'theme-system',
        label: 'Theme: match system',
        group: 'Appearance',
        run: () => setTheme('system'),
      },
      {
        id: 'density-compact',
        label: 'Density: compact',
        group: 'Appearance',
        run: () => setDensity('compact'),
      },
      {
        id: 'density-normal',
        label: 'Density: normal',
        group: 'Appearance',
        run: () => setDensity('normal'),
      },
      {
        id: 'density-relaxed',
        label: 'Density: relaxed',
        group: 'Appearance',
        run: () => setDensity('relaxed'),
      },
      {
        id: 'layout-save',
        label: 'Save current layout as…',
        group: 'Layout',
        run: () => {
          const name = window.prompt('Layout name');
          if (name) void saveAs(name);
        },
      },
      {
        id: 'layout-reset',
        label: 'Reset layout to default',
        group: 'Layout',
        run: resetToDefault,
      },
    );

    return list;
  }, [
    workspace,
    addWidget,
    activateWidget,
    moveWidget,
    toggleRegion,
    setChartLayout,
    setActiveSymbol,
    setTheme,
    setDensity,
    saveAs,
    resetToDefault,
  ]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle === '') return commands.slice(0, 40);
    return commands
      .filter(
        (command) =>
          command.label.toLowerCase().includes(needle) ||
          command.group.toLowerCase().includes(needle) ||
          command.keywords?.toLowerCase().includes(needle),
      )
      .slice(0, 40);
  }, [commands, query]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setSelectedIndex(0);
      inputRef.current?.focus();
    }
  }, [open]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  // Keep the highlighted row scrolled into view for keyboard navigation.
  useEffect(() => {
    listRef.current?.children[selectedIndex]?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  if (!open) return null;

  const run = (command: Command | undefined) => {
    if (!command) return;
    command.run();
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-24"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onClick={(event) => event.stopPropagation()}
        className="w-full max-w-lg overflow-hidden rounded-lg border border-[var(--border-strong)] bg-[var(--surface-overlay)] shadow-[var(--shadow-panel)]"
      >
        <input
          ref={inputRef}
          role="combobox"
          aria-expanded="true"
          aria-controls="command-list"
          aria-activedescendant={filtered[selectedIndex]?.id}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') onClose();
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setSelectedIndex((index) => Math.min(index + 1, filtered.length - 1));
            }
            if (event.key === 'ArrowUp') {
              event.preventDefault();
              setSelectedIndex((index) => Math.max(index - 1, 0));
            }
            if (event.key === 'Enter') {
              event.preventDefault();
              run(filtered[selectedIndex]);
            }
          }}
          placeholder="Search panels, layouts, symbols…"
          className="w-full border-b border-[var(--border-default)] bg-transparent px-3 py-2.5 text-sm text-text-primary outline-none placeholder:text-text-muted"
        />

        <ul
          id="command-list"
          ref={listRef}
          role="listbox"
          className="max-h-80 overflow-y-auto py-1"
        >
          {filtered.length === 0 ? (
            <li className="px-3 py-2 text-xs text-text-muted">No matching commands</li>
          ) : (
            filtered.map((command, index) => (
              <li
                key={command.id}
                id={command.id}
                role="option"
                aria-selected={index === selectedIndex}
                onMouseEnter={() => setSelectedIndex(index)}
                onClick={() => run(command)}
                className={cn(
                  'flex cursor-pointer items-center justify-between gap-3 px-3 py-1.5 text-xs',
                  index === selectedIndex && 'bg-[var(--surface-raised)]',
                )}
              >
                <span className="truncate text-text-primary">{command.label}</span>
                <span className="shrink-0 text-2xs text-text-muted">{command.group}</span>
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}

function regionLabel(region: RegionId): string {
  switch (region) {
    case 'left':
      return 'left panel';
    case 'right':
      return 'right panel';
    case 'bottom':
      return 'bottom panel';
    default:
      return 'overlay';
  }
}

function chartLayoutLabel(layout: string): string {
  switch (layout) {
    case 'single':
      return 'single chart';
    case 'two-vertical':
      return 'two charts, side by side';
    case 'two-horizontal':
      return 'two charts, stacked';
    case 'three':
      return 'three charts';
    case 'four':
      return 'four charts';
    default:
      return layout;
  }
}
