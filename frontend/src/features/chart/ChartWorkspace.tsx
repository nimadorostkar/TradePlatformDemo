import type { ReactNode } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { cn } from '@/components/ui/cn';
import { useWorkspace } from '@/workspace/layout/workspace-store';
import { ChartPane } from './ChartPane';

/**
 * The centre region: one to four chart panes in the workspace's saved layout.
 * Each pane is keyed by its id so a layout change re-arranges panes without
 * remounting them (and without refetching their history).
 */
export function ChartWorkspace() {
  const layout = useWorkspace((s) => s.workspace.chartLayout);
  const panes = useWorkspace((s) => s.workspace.chartPanes);

  if (layout === 'single' || panes.length === 1) {
    const pane = panes[0];
    if (!pane) return null;
    return (
      <div className="h-full min-h-0 bg-[var(--background-primary)]">
        <ChartPane paneId={pane.id} symbol={pane.symbol} interval={pane.interval} isPrimary />
      </div>
    );
  }

  const direction = layout === 'two-horizontal' ? 'vertical' : 'horizontal';

  if (layout === 'two-vertical' || layout === 'two-horizontal') {
    return (
      <PanelGroup direction={direction} className="h-full min-h-0">
        {panes.slice(0, 2).map((pane, index) => (
          <PaneSlot key={pane.id} index={index} direction={direction}>
            <ChartPane
              paneId={pane.id}
              symbol={pane.symbol}
              interval={pane.interval}
              isPrimary={index === 0}
            />
          </PaneSlot>
        ))}
      </PanelGroup>
    );
  }

  // Three- and four-chart grids: a vertical group of horizontal rows.
  const rows =
    layout === 'three'
      ? [panes.slice(0, 1), panes.slice(1, 3)]
      : [panes.slice(0, 2), panes.slice(2, 4)];

  return (
    <PanelGroup direction="vertical" className="h-full min-h-0">
      {rows.map((row, rowIndex) => (
        <PaneSlot key={`row-${rowIndex}`} index={rowIndex} direction="vertical">
          <PanelGroup direction="horizontal" className="h-full min-h-0">
            {row.map((pane, index) => (
              <PaneSlot key={pane.id} index={index} direction="horizontal">
                <ChartPane
                  paneId={pane.id}
                  symbol={pane.symbol}
                  interval={pane.interval}
                  isPrimary={rowIndex === 0 && index === 0}
                />
              </PaneSlot>
            ))}
          </PanelGroup>
        </PaneSlot>
      ))}
    </PanelGroup>
  );
}

function PaneSlot({
  index,
  direction,
  children,
}: {
  index: number;
  direction: 'horizontal' | 'vertical';
  children: ReactNode;
}) {
  return (
    <>
      {index > 0 && (
        <PanelResizeHandle
          className={cn(
            'shrink-0 bg-[var(--border-default)] transition-colors hover:bg-[var(--brand-primary)]',
            direction === 'horizontal' ? 'w-px cursor-col-resize' : 'h-px cursor-row-resize',
          )}
          aria-label="Resize chart"
        />
      )}
      <Panel minSize={15} className="min-h-0">
        {children}
      </Panel>
    </>
  );
}
