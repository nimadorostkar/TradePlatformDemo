import { Component, Suspense, type ErrorInfo, type ReactNode } from 'react';
import { X, GripVertical } from 'lucide-react';
import { cn } from '@/components/ui/cn';
import { CapabilityUnavailable, ErrorState, LoadingState } from '@/components/ui/primitives';
import { useCapability } from '@/stores/capabilities-store';
import type { WidgetDefinition } from '../registry/types';
import { isStaleChunkError, reloadForStaleChunk } from '@/app/stale-chunk';

/**
 * Renders one widget group: a tab strip plus the active widget's content.
 *
 * Each widget is wrapped in its own error boundary. One widget throwing must
 * not take down the terminal — a crashed positions table while a position is
 * open is exactly when the rest of the UI matters most.
 */

interface WidgetErrorBoundaryState {
  error: Error | null;
}

class WidgetErrorBoundary extends Component<
  { widgetId: string; onError?: (error: Error, info: ErrorInfo) => void; children: ReactNode },
  WidgetErrorBoundaryState
> {
  override state: WidgetErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): WidgetErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // A panel whose lazy chunk 404s has not stopped responding — a deploy
    // replaced the assets under this tab. Because this boundary sits INSIDE
    // the root one, it used to swallow that case and report a working build as
    // a broken panel; observed live, where the orders panel read "This panel
    // stopped responding" purely because the tab predated a deploy.
    if (isStaleChunkError(error) && reloadForStaleChunk()) return;
    this.props.onError?.(error, info);
  }

  private reset = () => this.setState({ error: null });

  override render(): ReactNode {
    if (this.state.error) {
      return (
        <ErrorState
          title={
            isStaleChunkError(this.state.error)
              ? 'This panel needs a reload'
              : 'This panel stopped responding'
          }
          description={this.state.error.message}
          onRetry={this.reset}
        />
      );
    }
    return this.props.children;
  }
}

export interface WidgetGroupHostProps {
  groupId: string;
  widgets: readonly WidgetDefinition[];
  activeWidgetId: string;
  onActivate: (widgetId: string) => void;
  onClose: (widgetId: string) => void;
  onDragStart?: (widgetId: string) => void;
  onWidgetError?: (widgetId: string, error: Error) => void;
  className?: string;
  /** Extra controls rendered at the right of the tab strip. */
  actions?: ReactNode;
}

export function WidgetGroupHost({
  groupId,
  widgets,
  activeWidgetId,
  onActivate,
  onClose,
  onDragStart,
  onWidgetError,
  className,
  actions,
}: WidgetGroupHostProps) {
  const active = widgets.find((w) => w.id === activeWidgetId) ?? widgets[0];
  if (!active) return null;

  const ActiveComponent = active.lazyComponent;

  return (
    <section
      className={cn('flex h-full min-h-0 flex-col bg-[var(--background-secondary)]', className)}
      aria-label={active.title}
    >
      <div
        role="tablist"
        aria-label="Panel tabs"
        className="flex h-7 shrink-0 items-center gap-px overflow-x-auto border-b border-[var(--border-default)] bg-[var(--background-tertiary)]"
      >
        {widgets.map((widget) => {
          const isActive = widget.id === active.id;
          const Icon = widget.icon;
          return (
            <div key={widget.id} className="group relative flex items-center">
              <button
                role="tab"
                id={`tab-${groupId}-${widget.id}`}
                aria-selected={isActive}
                aria-controls={`panel-${groupId}-${widget.id}`}
                tabIndex={isActive ? 0 : -1}
                draggable
                onDragStart={(event) => {
                  event.dataTransfer.setData('application/x-widget-id', widget.id);
                  event.dataTransfer.effectAllowed = 'move';
                  onDragStart?.(widget.id);
                }}
                onKeyDown={(event) => handleTabKeys(event, widgets, widget.id, onActivate)}
                onClick={() => onActivate(widget.id)}
                className={cn(
                  'flex h-7 items-center gap-1.5 whitespace-nowrap px-2.5 text-2xs font-medium transition-colors',
                  isActive
                    ? 'bg-[var(--background-secondary)] text-text-primary'
                    : 'text-text-muted hover:text-text-secondary',
                )}
              >
                <GripVertical
                  className="h-3 w-3 opacity-0 transition-opacity group-hover:opacity-40"
                  aria-hidden
                />
                <Icon className="h-3 w-3" aria-hidden />
                {widget.shortTitle ?? widget.title}
              </button>
              {!widget.systemWidget && widgets.length > 0 ? (
                <button
                  aria-label={`Close ${widget.title}`}
                  onClick={() => onClose(widget.id)}
                  className="hit-target mr-1 justify-center rounded text-text-muted opacity-0 transition-opacity hover:bg-[var(--surface-raised)] hover:text-text-primary focus-visible:opacity-100 group-hover:opacity-100"
                >
                  <X className="h-2.5 w-2.5" aria-hidden />
                </button>
              ) : null}
            </div>
          );
        })}
        <div className="ml-auto flex items-center gap-1 pr-1">{actions}</div>
      </div>

      <div
        role="tabpanel"
        id={`panel-${groupId}-${active.id}`}
        aria-labelledby={`tab-${groupId}-${active.id}`}
        className="min-h-0 flex-1 overflow-hidden"
      >
        <WidgetErrorBoundary
          widgetId={active.id}
          onError={(error) => onWidgetError?.(active.id, error)}
        >
          <Suspense fallback={<LoadingState label={`Loading ${active.title}…`} />}>
            <CapabilityGate widget={active}>
              <ActiveComponent />
            </CapabilityGate>
          </Suspense>
        </WidgetErrorBoundary>
      </div>
    </section>
  );
}

/**
 * Renders a widget only when the GATEWAY says its feature exists.
 *
 * The reason comes from the server, so a deployment without a news provider
 * says exactly that instead of showing an empty panel that looks broken.
 */
function CapabilityGate({ widget, children }: { widget: WidgetDefinition; children: ReactNode }) {
  const { enabled, reason, loaded } = useCapability(widget.requiredCapability);

  if (!widget.requiredCapability || enabled) return <>{children}</>;
  // Before the capability answer arrives, show progress rather than declaring
  // the feature missing.
  if (!loaded) return <LoadingState label="Checking availability…" />;

  return (
    <CapabilityUnavailable
      feature={widget.title}
      reason={reason ?? 'This trading server does not provide the feature.'}
    />
  );
}

/** Arrow-key navigation across the tab strip, per the ARIA tabs pattern. */
function handleTabKeys(
  event: React.KeyboardEvent,
  widgets: readonly WidgetDefinition[],
  currentId: string,
  onActivate: (widgetId: string) => void,
): void {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  event.preventDefault();

  const index = widgets.findIndex((w) => w.id === currentId);
  if (index < 0) return;

  const delta = event.key === 'ArrowRight' ? 1 : -1;
  const next = widgets[(index + delta + widgets.length) % widgets.length];
  if (!next) return;

  onActivate(next.id);
  // Move focus with the selection so keyboard users stay oriented.
  document.getElementById(`tab-${next.id}`)?.focus();
}

export function ChromelessWidgetHost({
  widget,
  onError,
}: {
  widget: WidgetDefinition;
  onError?: (error: Error) => void;
}) {
  const Component_ = widget.lazyComponent;
  return (
    <WidgetErrorBoundary widgetId={widget.id} onError={(error) => onError?.(error)}>
      <Suspense fallback={<LoadingState label={`Loading ${widget.title}…`} />}>
        <Component_ />
      </Suspense>
    </WidgetErrorBoundary>
  );
}
