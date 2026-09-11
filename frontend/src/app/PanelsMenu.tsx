import { useEffect, useMemo, useRef } from 'react';
import { Check, ChevronDown, PanelsTopLeft } from 'lucide-react';
import { cn } from '@/components/ui/cn';
import { Button } from '@/components/ui/primitives';
import { useCapabilities } from '@/stores/capabilities-store';
import { capabilityState } from '@/integrations/gateway/api/capabilities';
import { openWidgetIds, useWorkspace } from '@/workspace/layout/workspace-store';
import { widgetRegistry } from '@/workspace/widgets/registry';

/**
 * The Panels picker.
 *
 * Several panels — Market Depth, Price Alerts, the Journal — are registered,
 * capability-gated and deployed, but absent from the default layout. Before
 * this menu the ONLY way to reach one was to guess its name in the command
 * palette, which made a shipped feature look missing.
 *
 * Availability policy (launch-readiness MED-12): a panel the gateway has
 * DEFINITIVELY declined to serve is omitted from the menu — advertising a
 * permanently disabled feature reads as a broken product, and this server's
 * answer is not going to change mid-session. While the capability answer is
 * still pending the entry stays listed as "checking…", so a slow gateway
 * cannot make a shipped feature look missing.
 */
export function PanelsMenu({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  const capabilities = useCapabilities((s) => s.capabilities);
  const capabilitiesLoaded = useCapabilities((s) => s.loaded);
  const workspace = useWorkspace((s) => s.workspace);
  const addWidget = useWorkspace((s) => s.addWidget);
  const activateWidget = useWorkspace((s) => s.activateWidget);

  const openIds = useMemo(() => openWidgetIds(workspace), [workspace]);

  const entries = useMemo(
    () =>
      [...widgetRegistry.values()]
        .filter((widget) => !widget.systemWidget)
        .map((widget) => {
          const gate = widget.requiredCapability
            ? capabilityState(capabilities, widget.requiredCapability)
            : { enabled: true, reason: null };
          return { widget, ...gate, isOpen: openIds.has(widget.id) };
        })
        // Drop entries the gateway has definitively declined (MED-12). An
        // entry with the answer still pending is kept and shown as checking.
        .filter(
          ({ widget, enabled }) =>
            enabled || (Boolean(widget.requiredCapability) && !capabilitiesLoaded),
        ),
    [capabilities, capabilitiesLoaded, openIds],
  );

  // Escape and outside clicks close the menu. A long list left hanging over the
  // chart while the user clicks elsewhere is worse than a short one.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onOpenChange(false);
    };
    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) onOpenChange(false);
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [open, onOpenChange]);

  const toggle = (widgetId: string, isOpen: boolean, defaultRegion: string) => {
    if (isOpen) {
      // Already placed: bring it to the front rather than closing it, which is
      // what a picker click means nearly every time. Closing has its own
      // control on the panel itself.
      activateWidget(widgetId);
    } else {
      addWidget(widgetId, defaultRegion as never);
      activateWidget(widgetId);
    }
    onOpenChange(false);
  };

  return (
    <div className="relative" ref={containerRef}>
      <Button
        size="xs"
        variant="ghost"
        onClick={() => onOpenChange(!open)}
        aria-expanded={open}
        aria-haspopup="menu"
        title="Open a panel"
      >
        <PanelsTopLeft className="h-3 w-3" aria-hidden />
        <span>Panels</span>
        <ChevronDown className="h-2.5 w-2.5" aria-hidden />
      </Button>

      {open && (
        <div
          role="menu"
          aria-label="Panels"
          className="absolute right-0 top-7 z-50 max-h-96 w-64 overflow-y-auto rounded border border-[var(--border-strong)] bg-[var(--surface-overlay)] p-1 shadow-[var(--shadow-panel)]"
        >
          {entries.map(({ widget, enabled, reason, isOpen }) => {
            // Before the gateway has answered, a gated panel is neither
            // offered nor denied — saying "unavailable" too early is a lie
            // that outlives the request.
            const pending = Boolean(widget.requiredCapability) && !capabilitiesLoaded;
            const disabled = !enabled && !pending;
            const Icon = widget.icon;

            return (
              <button
                key={widget.id}
                role="menuitemcheckbox"
                aria-checked={isOpen}
                disabled={disabled}
                title={disabled ? (reason ?? undefined) : widget.description}
                onClick={() => toggle(widget.id, isOpen, widget.defaultRegion)}
                className={cn(
                  'flex w-full items-center gap-2 rounded px-2 py-1 text-left text-2xs',
                  disabled
                    ? 'cursor-not-allowed text-text-muted'
                    : 'text-text-primary hover:bg-[var(--surface-raised)]',
                )}
              >
                <Icon className="h-3 w-3 shrink-0" aria-hidden />
                <span className="min-w-0 flex-1 truncate">{widget.title}</span>
                {pending ? (
                  <span className="shrink-0 text-2xs text-text-muted">checking…</span>
                ) : disabled ? (
                  <span className="shrink-0 text-2xs text-text-muted">unavailable</span>
                ) : isOpen ? (
                  <Check className="h-3 w-3 shrink-0 text-[var(--positive)]" aria-hidden />
                ) : null}
              </button>
            );
          })}

          <div className="my-1 border-t border-[var(--border-default)]" />
          <p className="px-2 py-1 text-2xs text-text-muted">
            Close a panel from its own tab. Every panel is also reachable from the command palette
            (⌘K).
          </p>
        </div>
      )}
    </div>
  );
}
