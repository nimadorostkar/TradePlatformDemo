import { beforeEach, describe, expect, it } from 'vitest';
import { createDefaultWorkspace, workspaceSchema } from '../persistence/schema';
import type { WorkspaceStore } from '../persistence/storage';
import { __setWorkspaceStoreForTests, useWorkspace } from './workspace-store';

/** In-memory store so the tests never touch localStorage. */
function memoryStore(): WorkspaceStore {
  const documents = new Map<string, ReturnType<typeof createDefaultWorkspace>>();
  let activeId: string | null = null;
  return {
    list: async () =>
      [...documents.values()].map((w) => ({ id: w.id, name: w.name, updatedAt: w.updatedAt })),
    load: async (id) => ({
      workspace: documents.get(id) ?? createDefaultWorkspace({ id }),
      recovered: false,
    }),
    save: async (workspace) => void documents.set(workspace.id, workspace),
    remove: async (id) => void documents.delete(id),
    getActiveId: async () => activeId,
    setActiveId: async (id) => void (activeId = id),
  };
}

beforeEach(() => {
  __setWorkspaceStoreForTests(memoryStore());
  useWorkspace.setState({ workspace: createDefaultWorkspace(), savedLayouts: [], hydrated: true });
});

const ws = () => useWorkspace.getState().workspace;

describe('region operations', () => {
  it('collapses and expands a region', () => {
    expect(ws().regions.left.collapsed).toBe(false);
    useWorkspace.getState().toggleRegionCollapsed('left');
    expect(ws().regions.left.collapsed).toBe(true);
    useWorkspace.getState().toggleRegionCollapsed('left');
    expect(ws().regions.left.collapsed).toBe(false);
  });

  it('clamps a region size into a usable range', () => {
    useWorkspace.getState().setRegionSize('left', 500);
    expect(ws().regions.left.size).toBeLessThanOrEqual(80);
    useWorkspace.getState().setRegionSize('left', -20);
    expect(ws().regions.left.size).toBeGreaterThanOrEqual(4);
  });
});

describe('widget placement', () => {
  it('moves a widget between regions', () => {
    useWorkspace.getState().moveWidget('watchlist', { region: 'right' });

    const left = ws().regions.left.groups.flatMap((g) => g.widgetIds);
    const right = ws().regions.right.groups.flatMap((g) => g.widgetIds);
    expect(left).not.toContain('watchlist');
    expect(right).toContain('watchlist');
  });

  it('moves a widget INTO an existing tab group and activates it', () => {
    const targetGroup = ws().regions.right.groups[0];
    expect(targetGroup).toBeDefined();

    useWorkspace.getState().moveWidget('watchlist', {
      region: 'right',
      groupId: targetGroup!.id,
    });

    const group = ws().regions.right.groups.find((g) => g.id === targetGroup!.id);
    expect(group?.widgetIds).toContain('watchlist');
    expect(group?.activeWidgetId).toBe('watchlist');
  });

  it('never leaves a widget in two places after a move', () => {
    useWorkspace.getState().moveWidget('positions', { region: 'left' });
    const all = Object.values(ws().regions).flatMap((r) => r.groups.flatMap((g) => g.widgetIds));
    expect(all.filter((id) => id === 'positions')).toHaveLength(1);
  });

  it('removes a widget and drops the group when it becomes empty', () => {
    // The default left dock has a `favorites` group with a single widget.
    const before = ws().regions.left.groups.length;
    useWorkspace.getState().removeWidget('favorites');
    expect(ws().regions.left.groups.length).toBe(before - 1);
  });

  it('reassigns the active tab when the active widget is removed', () => {
    const group = ws().regions.left.groups[0];
    expect(group?.widgetIds.length).toBeGreaterThan(1);

    useWorkspace.getState().activateWidget(group!.widgetIds[0]!);
    useWorkspace.getState().removeWidget(group!.widgetIds[0]!);

    const updated = ws().regions.left.groups.find((g) => g.id === group!.id);
    expect(updated?.activeWidgetId).toBe(group!.widgetIds[1]);
  });

  it('focuses rather than duplicates when adding a widget that already exists', () => {
    useWorkspace.getState().addWidget('watchlist', 'right');
    const all = Object.values(ws().regions).flatMap((r) => r.groups.flatMap((g) => g.widgetIds));
    expect(all.filter((id) => id === 'watchlist')).toHaveLength(1);
  });

  it('expands a collapsed region when a widget in it is activated', () => {
    // Otherwise the command palette's "open panel" appears to do nothing.
    useWorkspace.getState().setRegionCollapsed('left', true);
    useWorkspace.getState().activateWidget('watchlist');
    expect(ws().regions.left.collapsed).toBe(false);
  });

  it('reorders groups within a region', () => {
    const [first, second] = ws().regions.left.groups;
    expect(first && second).toBeTruthy();

    useWorkspace.getState().reorderGroup('left', 0, 1);
    expect(ws().regions.left.groups[0]?.id).toBe(second!.id);
    expect(ws().regions.left.groups[1]?.id).toBe(first!.id);
  });
});

describe('chart layout', () => {
  it('grows the pane list when switching to a multi-chart layout', () => {
    useWorkspace.getState().setChartLayout('four');
    expect(ws().chartPanes).toHaveLength(4);
    expect(ws().chartLayout).toBe('four');
  });

  it('shrinks back to a single pane', () => {
    useWorkspace.getState().setChartLayout('four');
    useWorkspace.getState().setChartLayout('single');
    expect(ws().chartPanes).toHaveLength(1);
  });

  it('drives only the FIRST pane from the active symbol', () => {
    useWorkspace.getState().setChartLayout('two-vertical');
    useWorkspace.getState().setPaneSymbol('pane-2', 'GBPUSD');
    useWorkspace.getState().setActiveSymbol('XAUUSD');

    expect(ws().chartPanes[0]?.symbol).toBe('XAUUSD');
    // A watchlist click must not disturb an independently pinned pane.
    expect(ws().chartPanes[1]?.symbol).toBe('GBPUSD');
  });
});

describe('symbols and watchlists', () => {
  it('records recently viewed symbols without duplicates, newest first', () => {
    const store = useWorkspace.getState();
    store.setActiveSymbol('EURUSD');
    store.setActiveSymbol('GBPUSD');
    store.setActiveSymbol('EURUSD');

    expect(ws().recentSymbols[0]).toBe('EURUSD');
    expect(ws().recentSymbols.filter((s) => s === 'EURUSD')).toHaveLength(1);
  });

  it('adds and removes watchlist symbols idempotently', () => {
    const store = useWorkspace.getState();
    store.addSymbolToWatchlist('USDCHF');
    store.addSymbolToWatchlist('USDCHF');

    const list = ws().watchlists[0];
    expect(list?.symbols.filter((s) => s === 'USDCHF')).toHaveLength(1);

    store.removeSymbolFromWatchlist('USDCHF');
    expect(ws().watchlists[0]?.symbols).not.toContain('USDCHF');
  });

  it('refuses to delete the last watchlist', () => {
    // Zero watchlists would leave the widget with nothing to render and no UI
    // path to recover.
    const only = ws().watchlists[0];
    useWorkspace.getState().removeWatchlist(only!.id);
    expect(ws().watchlists).toHaveLength(1);
  });

  it('toggles favorites', () => {
    useWorkspace.getState().toggleFavorite('XAUUSD');
    expect(ws().favorites).toContain('XAUUSD');
    useWorkspace.getState().toggleFavorite('XAUUSD');
    expect(ws().favorites).not.toContain('XAUUSD');
  });
});

describe('URL tab adoption (deep links)', () => {
  /** A server copy whose remembered bottom tab is 'deals'. */
  function serverStoreRemembering(activeWidgetId: string): WorkspaceStore {
    const remembered = createDefaultWorkspace();
    const bottom = remembered.regions.bottom.groups[0]!;
    remembered.regions.bottom.groups = [{ ...bottom, activeWidgetId }];
    return {
      ...memoryStore(),
      pull: async () => true,
      load: async () => ({ workspace: remembered, recovered: false }),
    };
  }

  it('the link tab survives the sign-in resync that restores the saved layout', async () => {
    __setWorkspaceStoreForTests(serverStoreRemembering('deals'));

    // /?tab=positions applied on mount…
    useWorkspace.getState().adoptUrlTab('positions');
    expect(ws().regions.bottom.groups[0]?.activeWidgetId).toBe('positions');

    // …then the server resync lands with 'deals' remembered. The link wins —
    // this is the punch-list case where ?tab=positions silently showed Deals.
    await useWorkspace.getState().resync();
    expect(ws().regions.bottom.groups[0]?.activeWidgetId).toBe('positions');
  });

  it('an ordinary tab click ends the claim, and the next resync restores the layout', async () => {
    __setWorkspaceStoreForTests(serverStoreRemembering('deals'));

    useWorkspace.getState().adoptUrlTab('positions');
    useWorkspace.getState().activateWidget('order-history');
    expect(useWorkspace.getState().urlTabIntent).toBeNull();

    await useWorkspace.getState().resync();
    expect(ws().regions.bottom.groups[0]?.activeWidgetId).toBe('deals');
  });

  it('adopting a tab the layout does not place is a no-op, not a crash', () => {
    useWorkspace.getState().adoptUrlTab('journal');
    // journal is not in the default bottom dock; the active tab is unchanged.
    expect(ws().regions.bottom.groups[0]?.activeWidgetId).toBe('positions');
  });
});

describe('reset and validity', () => {
  it('restores the default layout', () => {
    useWorkspace.getState().removeWidget('watchlist');
    useWorkspace.getState().setChartLayout('four');
    useWorkspace.getState().resetToDefault();

    const all = Object.values(ws().regions).flatMap((r) => r.groups.flatMap((g) => g.widgetIds));
    expect(all).toContain('watchlist');
    expect(ws().chartPanes).toHaveLength(1);
  });

  it('keeps the workspace schema-valid after every operation', () => {
    const store = useWorkspace.getState();
    store.moveWidget('watchlist', { region: 'bottom' });
    store.removeWidget('favorites');
    store.setChartLayout('three');
    store.toggleRegionCollapsed('right');
    store.addSymbolToWatchlist('NZDUSD');
    store.setDensity('compact');

    expect(workspaceSchema.safeParse(ws()).success).toBe(true);
  });
});
