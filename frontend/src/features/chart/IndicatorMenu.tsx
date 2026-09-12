import { useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/components/ui/cn';
import { INDICATORS, INDICATOR_COLORS, INDICATOR_SPECS, type IndicatorId } from './chart-settings';

/**
 * The chart's indicator picker: one button that says how many are on, and a
 * checklist grouped into overlays (drawn on the price) and panes (drawn
 * under it). Same closing rules as the tables' column menu — click outside
 * or Escape — so the two menus behave alike.
 */
export function IndicatorMenu({
  active,
  onToggle,
  onClear,
}: {
  active: readonly IndicatorId[];
  onToggle: (id: IndicatorId) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

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

  const groups = [
    {
      title: 'Overlays',
      ids: INDICATORS.filter((id) => INDICATOR_SPECS[id].placement === 'overlay'),
    },
    { title: 'Panes', ids: INDICATORS.filter((id) => INDICATOR_SPECS[id].placement === 'pane') },
  ];

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Indicators, ${active.length} on`}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          'flex items-center gap-1 rounded px-1.5 py-0.5 text-2xs font-medium transition-colors',
          active.length > 0
            ? 'bg-[var(--surface-raised)] text-[var(--text-primary)]'
            : 'text-[var(--text-muted)] hover:bg-[var(--surface-raised)] hover:text-[var(--text-primary)]',
        )}
      >
        {/* The swatches of what is on, so the header still shows it at a glance. */}
        {active.length > 0 && (
          <span aria-hidden className="flex items-center gap-0.5">
            {active.map((id) => (
              <span
                key={id}
                className="inline-block h-0.5 w-2 rounded"
                style={{ backgroundColor: INDICATOR_COLORS[id] }}
              />
            ))}
          </span>
        )}
        Indicators{active.length > 0 ? ` (${active.length})` : ''}
        <ChevronDown className="h-3 w-3" aria-hidden />
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Indicators"
          className="absolute right-0 top-6 z-50 w-48 rounded border border-[var(--border-strong)] bg-[var(--surface-overlay)] p-1 shadow-[var(--shadow-panel)]"
        >
          {groups.map((group, index) => (
            <div key={group.title}>
              {index > 0 && <div className="my-1 border-t border-[var(--border-default)]" />}
              <div className="px-2 pb-0.5 pt-1 text-2xs uppercase tracking-wide text-[var(--text-muted)]">
                {group.title}
              </div>
              {group.ids.map((id) => {
                const checked = active.includes(id);
                return (
                  <label
                    key={id}
                    className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-2xs text-[var(--text-primary)] hover:bg-[var(--surface-raised)]"
                  >
                    <input type="checkbox" checked={checked} onChange={() => onToggle(id)} />
                    <span
                      aria-hidden
                      className="inline-block h-0.5 w-3 rounded"
                      style={{ backgroundColor: INDICATOR_COLORS[id], opacity: checked ? 1 : 0.5 }}
                    />
                    {INDICATOR_SPECS[id].label}
                  </label>
                );
              })}
            </div>
          ))}

          <div className="my-1 border-t border-[var(--border-default)]" />
          <button
            type="button"
            role="menuitem"
            disabled={active.length === 0}
            onClick={() => {
              onClear();
              setOpen(false);
            }}
            className="block w-full rounded px-2 py-1 text-left text-2xs text-[var(--text-secondary)] hover:bg-[var(--surface-raised)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            Clear all indicators
          </button>
        </div>
      )}
    </div>
  );
}
