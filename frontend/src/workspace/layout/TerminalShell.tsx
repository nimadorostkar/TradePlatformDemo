import { useEffect } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { cn } from '@/components/ui/cn';
import { useSystemMessages } from '@/stores/system-messages-store';
import { ChartWorkspace } from '@/integrations/tradingview/TradingChart/ChartWorkspace';
import type { WidgetRegistry } from '../registry/types';
import { Region } from './Region';
import { useWorkspace } from './workspace-store';

/**
 * The desktop terminal shell.
 *
 * Structure:
 *   header (outside this component)
 *   ├── horizontal: left dock | centre | right dock
 *   └── bottom dock
 *
 * The centre column is NEVER re-parented by a layout change. That is what keeps
 * the TradingView iframe alive across resizes, collapses, and widget moves —
 * see docs/adr/0001-layout-engine.md.
 */

export function TerminalShell({ registry }: { registry: WidgetRegistry }) {
  const regions = useWorkspace((s) => s.workspace.regions);
  const density = useWorkspace((s) => s.workspace.density);
  const setRegionSize = useWorkspace((s) => s.setRegionSize);
  const recoveryNotice = useWorkspace((s) => s.recoveryNotice);
  const clearRecoveryNotice = useWorkspace((s) => s.clearRecoveryNotice);
  const pushMessage = useSystemMessages((s) => s.push);

  useEffect(() => {
    document.documentElement.dataset.density = density;
  }, [density]);

  // A discarded layout is not silent: the user is told, in the place they will
  // look for it, why their workspace looks different.
  useEffect(() => {
    if (!recoveryNotice) return;
    pushMessage({
      level: 'warning',
      scope: 'workspace',
      text: `Layout recovered to defaults — ${recoveryNotice}`,
      code: 'workspace.recovered',
      requestId: null,
    });
    clearRecoveryNotice();
  }, [recoveryNotice, pushMessage, clearRecoveryNotice]);

  const leftCollapsed = regions.left.collapsed;
  const rightCollapsed = regions.right.collapsed;
  const bottomCollapsed = regions.bottom.collapsed;

  return (
    <PanelGroup direction="vertical" className="h-full min-h-0">
      <Panel defaultSize={100 - regions.bottom.size} minSize={30} className="min-h-0">
        <div className="flex h-full min-h-0">
          {leftCollapsed ? (
            <Region regionId="left" state={regions.left} registry={registry} direction="vertical" />
          ) : null}

          <PanelGroup direction="horizontal" className="min-h-0 flex-1">
            {!leftCollapsed && (
              <>
                <Panel
                  defaultSize={regions.left.size}
                  minSize={10}
                  maxSize={40}
                  onResize={(size) => setRegionSize('left', size)}
                  // Percentage floors compress at narrow viewports; the pixel
                  // floor keeps the watchlist wide enough to name its symbols
                  // next to two full prices (BLK-01/BLK-03). Below ~1024 px
                  // the mobile shell takes over, so this can never force a
                  // horizontal scroll.
                  className="min-h-0 min-w-[240px]"
                >
                  <Region
                    regionId="left"
                    state={regions.left}
                    registry={registry}
                    direction="vertical"
                    className="border-r border-[var(--border-default)]"
                  />
                </Panel>
                <ResizeHandle direction="horizontal" label="Resize left panel" />
              </>
            )}

            <Panel minSize={25} className="min-h-0">
              <ChartWorkspace />
            </Panel>

            {!rightCollapsed && (
              <>
                <ResizeHandle direction="horizontal" label="Resize right panel" />
                <Panel
                  defaultSize={regions.right.size}
                  minSize={12}
                  maxSize={42}
                  onResize={(size) => setRegionSize('right', size)}
                  // 260 px is the order ticket's own declared minimum: below
                  // it the volume input and Buy/Sell buttons wrap or vanish
                  // (BLK-03). Collapse is the intended escape hatch, not
                  // compression.
                  className="min-h-0 min-w-[260px]"
                >
                  <Region
                    regionId="right"
                    state={regions.right}
                    registry={registry}
                    direction="vertical"
                    className="border-l border-[var(--border-default)]"
                  />
                </Panel>
              </>
            )}
          </PanelGroup>

          {rightCollapsed ? (
            <Region
              regionId="right"
              state={regions.right}
              registry={registry}
              direction="vertical"
            />
          ) : null}
        </div>
      </Panel>

      {bottomCollapsed ? (
        <Region
          regionId="bottom"
          state={regions.bottom}
          registry={registry}
          direction="horizontal"
        />
      ) : (
        <>
          <ResizeHandle direction="vertical" label="Resize bottom panel" />
          <Panel
            defaultSize={regions.bottom.size}
            minSize={10}
            maxSize={70}
            onResize={(size) => setRegionSize('bottom', size)}
            className="min-h-0"
          >
            <Region
              regionId="bottom"
              state={regions.bottom}
              registry={registry}
              direction="horizontal"
              className="border-t border-[var(--border-default)]"
            />
          </Panel>
        </>
      )}
    </PanelGroup>
  );
}

function ResizeHandle({
  direction,
  label,
}: {
  direction: 'horizontal' | 'vertical';
  label: string;
}) {
  return (
    <PanelResizeHandle
      aria-label={label}
      className={cn(
        'group relative shrink-0 bg-[var(--border-default)] transition-colors',
        'hover:bg-[var(--brand-primary)] data-[resize-handle-active]:bg-[var(--brand-primary)]',
        'focus-visible:bg-[var(--focus-ring)] focus-visible:outline-none',
        direction === 'horizontal' ? 'w-px cursor-col-resize' : 'h-px cursor-row-resize',
      )}
    >
      {/* A 1px line is impossible to grab; this widens the hit area without
          changing the visual weight of the divider. */}
      <span
        className={cn(
          'absolute',
          direction === 'horizontal' ? '-left-1.5 top-0 h-full w-3' : '-top-1.5 left-0 h-3 w-full',
        )}
      />
    </PanelResizeHandle>
  );
}
