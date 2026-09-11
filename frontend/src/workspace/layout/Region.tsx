import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp } from 'lucide-react';
import { cn } from '@/components/ui/cn';
import { useSystemMessages } from '@/stores/system-messages-store';
import { useCapabilities } from '@/stores/capabilities-store';
import { capabilityState } from '@/integrations/gateway/api/capabilities';
import type { RegionId, WidgetRegistry } from '../registry/types';
import type { RegionState } from '../persistence/schema';
import { useWorkspace } from './workspace-store';
import { WidgetGroupHost } from './WidgetHost';
import {
  groupMinSizePercent,
  groupMinimumPx,
  regionContentPx,
  regionMinimumPx,
  regionOverflows,
} from './region-minimums';

/**
 * A dock region: a stack of resizable widget groups, collapsible to a rail.
 *
 * Drop targets accept a widget dragged from any region, which is how
 * cross-region moves work. The same move is available from the command palette
 * so the docks are fully operable without a pointer.
 */

export interface RegionProps {
  regionId: RegionId;
  state: RegionState;
  registry: WidgetRegistry;
  /** Which axis the groups stack along. */
  direction: 'vertical' | 'horizontal';
  className?: string;
}

export function Region({ regionId, state, registry, direction, className }: RegionProps) {
  const activateWidget = useWorkspace((s) => s.activateWidget);
  const removeWidget = useWorkspace((s) => s.removeWidget);
  const moveWidget = useWorkspace((s) => s.moveWidget);
  const setGroupSize = useWorkspace((s) => s.setGroupSize);
  const pushError = useSystemMessages((s) => s.push);
  const capabilities = useCapabilities((s) => s.capabilities);
  const capabilitiesLoaded = useCapabilities((s) => s.loaded);

  /**
   * Whether a saved widget can still be shown.
   *
   * A layout persists widget ids, so a panel saved before its feature went away
   * keeps its slot and renders its own error text — a Risk Calculator occupying
   * the right rail to say it cannot calculate anything. The Panels menu already
   * refuses to ADD one; this applies the same rule to what was already there.
   *
   * Filtered at render rather than evicted on hydrate, deliberately: eviction
   * rewrites the user's saved layout, so the panel would not come back if the
   * gateway started serving the feature again. Nothing is dropped until the
   * capability answer has ARRIVED, so a slow /api/Capabilities cannot make
   * panels flicker away and return.
   */
  const isAvailable = useCallback(
    (widgetId: string) => {
      const definition = registry.get(widgetId);
      if (!definition) return false;
      if (!definition.requiredCapability || !capabilitiesLoaded) return true;
      return capabilityState(capabilities, definition.requiredCapability).enabled;
    },
    [registry, capabilities, capabilitiesLoaded],
  );

  const [dropTarget, setDropTarget] = useState<string | null>(null);

  // The region's size along the axis its groups divide. Measured rather than
  // assumed: widget minimums are declared in px and this library's floors are
  // percentages, so the conversion needs a real number to divide by.
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerPx, setContainerPx] = useState(0);

  useEffect(() => {
    const node = containerRef.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const box = entry.contentRect;
      setContainerPx(direction === 'vertical' ? box.height : box.width);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [direction]);

  const requiredPx = useMemo(
    () => regionMinimumPx(state, registry, isAvailable),
    [state, registry, isAvailable],
  );
  const overflows = regionOverflows(requiredPx, containerPx);
  const contentPx = regionContentPx(requiredPx, containerPx);

  const handleWidgetError = useCallback(
    (widgetId: string, error: Error) => {
      pushError({
        level: 'error',
        scope: 'widget',
        text: `Widget "${widgetId}" crashed: ${error.message}`,
        code: 'widget.crash',
        requestId: null,
      });
    },
    [pushError],
  );

  const onDropIntoGroup = useCallback(
    (event: React.DragEvent, groupId: string) => {
      event.preventDefault();
      setDropTarget(null);
      const widgetId = event.dataTransfer.getData('application/x-widget-id');
      if (!widgetId) return;

      const definition = registry.get(widgetId);
      // Refuse a drop the widget did not declare support for, rather than
      // rendering an order ticket into a 200px-tall bottom dock.
      if (!definition?.allowedRegions.includes(regionId)) return;

      moveWidget(widgetId, { region: regionId, groupId });
    },
    [moveWidget, regionId, registry],
  );

  const onDropAsNewGroup = useCallback(
    (event: React.DragEvent, index: number) => {
      event.preventDefault();
      setDropTarget(null);
      const widgetId = event.dataTransfer.getData('application/x-widget-id');
      if (!widgetId) return;
      const definition = registry.get(widgetId);
      if (!definition?.allowedRegions.includes(regionId)) return;
      moveWidget(widgetId, { region: regionId, index });
    },
    [moveWidget, regionId, registry],
  );

  if (state.collapsed) {
    return <CollapsedRail regionId={regionId} state={state} registry={registry} />;
  }

  const groups = state.groups.filter((group) => group.widgetIds.some(isAvailable));

  if (groups.length === 0) {
    return (
      <div
        className={cn(
          'flex h-full items-center justify-center border-[var(--border-default)] p-3 text-center text-2xs text-text-muted',
          className,
        )}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => onDropAsNewGroup(e, 0)}
      >
        Drag a panel here
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={cn(
        'h-full w-full',
        // Only scrolls when the declared minimums genuinely do not fit. While
        // they do, this is inert and the layout behaves exactly as before.
        overflows && (direction === 'vertical' ? 'overflow-y-auto' : 'overflow-x-auto'),
        className,
      )}
    >
      <PanelGroup
        direction={direction}
        className="h-full"
        style={
          // Growing the stack past its container is what turns a squeeze into a
          // scroll. Left alone in the common case so nothing shifts.
          overflows
            ? direction === 'vertical'
              ? { height: `${contentPx}px` }
              : { width: `${contentPx}px` }
            : undefined
        }
        autoSaveId={undefined /* sizes live in the workspace document, not here */}
      >
        {groups.map((group, index) => {
          const widgets = group.widgetIds
            .filter(isAvailable)
            .map((id) => registry.get(id))
            .filter((w): w is NonNullable<typeof w> => w !== undefined);
          if (widgets.length === 0) return null;

          return (
            <Fragment key={group.id}>
              {index > 0 && (
                <PanelResizeHandle
                  className={cn(
                    // Keyboard focus lights the whole splitter line brand-colour
                    // (same cue as hover/active) — a 1px line takes no useful
                    // ring, so the fill IS the focus indicator. Keyboard resize
                    // was reachable but gave no visible focus before this.
                    'group relative shrink-0 bg-[var(--border-default)] outline-none transition-colors hover:bg-[var(--brand-primary)] focus-visible:bg-[var(--brand-primary)] data-[resize-handle-active]:bg-[var(--brand-primary)]',
                    direction === 'vertical' ? 'h-px cursor-row-resize' : 'w-px cursor-col-resize',
                  )}
                  aria-label="Resize panel"
                >
                  {/* Widen the pointer target beyond the 1px visual line. */}
                  <span
                    className={cn(
                      'absolute',
                      direction === 'vertical'
                        ? '-top-1 left-0 h-2 w-full'
                        : '-left-1 top-0 h-full w-2',
                    )}
                  />
                </PanelResizeHandle>
              )}
              <Panel
                defaultSize={group.size}
                // Derived from what this group's widgets declared, not a flat 8%.
                // A group holding the order ticket cannot be dragged below the
                // height its volume controls need to render fully.
                minSize={groupMinSizePercent(
                  groupMinimumPx(group.widgetIds, registry, isAvailable),
                  contentPx,
                )}
                onResize={(size) => setGroupSize(regionId, group.id, size)}
                className={cn(
                  'min-h-0',
                  dropTarget === group.id && 'ring-1 ring-inset ring-[var(--brand-primary)]',
                )}
              >
                <div
                  className="h-full"
                  onDragOver={(event) => {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = 'move';
                    setDropTarget(group.id);
                  }}
                  onDragLeave={() => setDropTarget((t) => (t === group.id ? null : t))}
                  onDrop={(event) => onDropIntoGroup(event, group.id)}
                >
                  <WidgetGroupHost
                    groupId={group.id}
                    widgets={widgets}
                    activeWidgetId={group.activeWidgetId}
                    onActivate={activateWidget}
                    onClose={removeWidget}
                    onWidgetError={handleWidgetError}
                  />
                </div>
              </Panel>
            </Fragment>
          );
        })}
      </PanelGroup>
    </div>
  );
}

/** Collapsed regions become a rail of icons that reopen and focus a widget. */
function CollapsedRail({
  regionId,
  state,
  registry,
}: {
  regionId: RegionId;
  state: RegionState;
  registry: WidgetRegistry;
}) {
  const activateWidget = useWorkspace((s) => s.activateWidget);
  const setRegionCollapsed = useWorkspace((s) => s.setRegionCollapsed);
  const isHorizontalRail = regionId === 'left' || regionId === 'right';

  const widgetIds = state.groups.flatMap((g) => g.widgetIds);

  return (
    <div
      className={cn(
        'flex shrink-0 items-center gap-1 border-[var(--border-default)] bg-[var(--background-tertiary)] p-1',
        isHorizontalRail ? 'h-full w-9 flex-col border-x' : 'h-8 w-full border-y',
      )}
    >
      <button
        aria-label={`Expand ${regionId} panel`}
        onClick={() => setRegionCollapsed(regionId, false)}
        className="rounded p-1 text-text-muted hover:bg-[var(--surface-raised)] hover:text-text-primary"
      >
        {regionId === 'left' ? (
          <ChevronRight className="h-3.5 w-3.5" aria-hidden />
        ) : regionId === 'right' ? (
          <ChevronLeft className="h-3.5 w-3.5" aria-hidden />
        ) : (
          <ChevronUp className="h-3.5 w-3.5" aria-hidden />
        )}
      </button>

      {widgetIds.map((id) => {
        const widget = registry.get(id);
        if (!widget) return null;
        const Icon = widget.icon;
        return (
          <button
            key={id}
            title={widget.title}
            aria-label={`Open ${widget.title}`}
            onClick={() => {
              setRegionCollapsed(regionId, false);
              activateWidget(id);
            }}
            className="rounded p-1 text-text-muted hover:bg-[var(--surface-raised)] hover:text-text-primary"
          >
            <Icon className="h-3.5 w-3.5" aria-hidden />
          </button>
        );
      })}
    </div>
  );
}

/** Collapse/expand control rendered in a region header. */
export function RegionToggle({ regionId }: { regionId: RegionId }) {
  const collapsed = useWorkspace((s) => s.workspace.regions[regionId].collapsed);
  const toggle = useWorkspace((s) => s.toggleRegionCollapsed);

  const Icon =
    regionId === 'bottom'
      ? collapsed
        ? ChevronUp
        : ChevronDown
      : collapsed
        ? ChevronRight
        : ChevronLeft;

  return (
    <button
      aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${regionId} panel`}
      aria-expanded={!collapsed}
      onClick={() => toggle(regionId)}
      className="rounded p-1 text-text-muted hover:bg-[var(--surface-raised)] hover:text-text-primary"
    >
      <Icon className="h-3.5 w-3.5" aria-hidden />
    </button>
  );
}
