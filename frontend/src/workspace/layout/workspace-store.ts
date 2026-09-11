import { create } from 'zustand';
import type { RegionId } from '../registry/types';
import {
  createDefaultWorkspace,
  newGroupId,
  type ChartLayout,
  type Watchlist,
  type Workspace,
} from '../persistence/schema';
import {
  LocalWorkspaceStore,
  type WorkspaceStore,
  type WorkspaceSummary,
} from '../persistence/storage';

/**
 * Workspace state and every layout mutation.
 *
 * This store holds UI-only state. It never contains positions, orders, quotes,
 * or account values — mixing them would re-render the whole shell on a tick and
 * would leak one account's view into another's saved layout.
 *
 * Saves are debounced: dragging a splitter fires continuously and each write
 * would otherwise hit localStorage synchronously on the main thread.
 */

const SAVE_DEBOUNCE_MS = 600;
const MAX_CHART_PANES: Record<ChartLayout, number> = {
  single: 1,
  'two-vertical': 2,
  'two-horizontal': 2,
  three: 3,
  four: 4,
};

interface WorkspaceState {
  workspace: Workspace;
  savedLayouts: WorkspaceSummary[];
  /** Set when a stored layout failed to load and the default was substituted. */
  recoveryNotice: string | null;
  hydrated: boolean;
  /** URL-borne symbol that must survive the next server resync (HGH-03). */
  urlSymbolIntent: string | null;
  /** URL-borne bottom-dock tab (widget id) with the same survival contract. */
  urlTabIntent: string | null;

  // lifecycle
  hydrate: () => Promise<void>;
  resync: () => Promise<void>;
  loadLayout: (id: string) => Promise<void>;
  saveAs: (name: string) => Promise<void>;
  renameActive: (name: string) => Promise<void>;
  duplicateActive: (name: string) => Promise<void>;
  deleteLayout: (id: string) => Promise<void>;
  resetToDefault: () => void;
  clearRecoveryNotice: () => void;

  // regions
  setRegionSize: (region: RegionId, size: number) => void;
  toggleRegionCollapsed: (region: RegionId) => void;
  setRegionCollapsed: (region: RegionId, collapsed: boolean) => void;
  setGroupSize: (region: RegionId, groupId: string, size: number) => void;

  // widgets
  addWidget: (widgetId: string, region: RegionId) => void;
  removeWidget: (widgetId: string) => void;
  activateWidget: (widgetId: string) => void;
  moveWidget: (
    widgetId: string,
    target: { region: RegionId; groupId?: string; index?: number },
  ) => void;
  reorderGroup: (region: RegionId, fromIndex: number, toIndex: number) => void;

  // chart + symbol
  setActiveSymbol: (symbol: string) => void;
  /**
   * Adopts a symbol named in a shared URL (HGH-03). Unlike setActiveSymbol it
   * survives the server workspace resync: the link's intent must beat the
   * layout's remembered symbol, or a pasted /?symbol=EURUSD link silently
   * snaps back to whatever the workspace last saved. Cleared by the first
   * ordinary symbol selection.
   */
  adoptUrlSymbol: (symbol: string) => void;
  /**
   * Adopts a bottom-dock tab named in a shared URL. Same contract as
   * adoptUrlSymbol: without it the sign-in resync restores the layout's
   * remembered active widget a moment after the link's tab was applied, and
   * /?tab=positions silently lands on whatever the workspace last saved.
   * Cleared by the first ordinary tab selection.
   */
  adoptUrlTab: (widgetId: string) => void;
  setActiveInterval: (interval: string) => void;
  setChartLayout: (layout: ChartLayout) => void;
  setPaneSymbol: (paneId: string, symbol: string) => void;
  setPaneChartState: (paneId: string, state: unknown) => void;

  // tables
  toggleTableColumn: (tableId: string, columnId: string) => void;
  resetTableColumns: (tableId: string) => void;

  // preferences
  setTheme: (theme: Workspace['theme']) => void;
  setDensity: (density: Workspace['density']) => void;
  setOneClickTrading: (enabled: boolean) => void;
  setConfirmTrades: (enabled: boolean) => void;

  // watchlists
  setActiveWatchlist: (id: string) => void;
  addWatchlist: (name: string) => void;
  removeWatchlist: (id: string) => void;
  addSymbolToWatchlist: (symbol: string, watchlistId?: string) => void;
  removeSymbolFromWatchlist: (symbol: string, watchlistId?: string) => void;
  reorderWatchlistSymbols: (fromIndex: number, toIndex: number, watchlistId?: string) => void;
  toggleFavorite: (symbol: string) => void;
}

let store: WorkspaceStore = new LocalWorkspaceStore();
export function __setWorkspaceStoreForTests(next: WorkspaceStore): void {
  store = next;
}

/**
 * Swaps in the server-mirroring store once an account is known.
 *
 * Layouts persist locally from the first frame, so this only ever upgrades
 * where they are ALSO kept — it never leaves a window with no persistence.
 */
export function installWorkspaceStore(next: WorkspaceStore): void {
  store = next;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let pendingSave: Workspace | null = null;

function scheduleSave(workspace: Workspace): void {
  pendingSave = workspace;
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const document = pendingSave;
    pendingSave = null;
    if (document) void store.save(document);
  }, SAVE_DEBOUNCE_MS);
}

/**
 * Writes any debounced change immediately.
 *
 * Without this, a layout change made in the last ~600 ms before the tab is
 * closed or reloaded is silently lost — the user sees their adjustment revert
 * for no visible reason.
 */
export function flushWorkspaceSave(): void {
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  const document = pendingSave;
  pendingSave = null;
  if (document) void store.save(document);
  // The local write above is synchronous enough to survive teardown; the remote
  // push is best-effort, since a closing tab may not get to finish the request.
  void store.flush?.();
}

if (typeof window !== 'undefined') {
  // `pagehide` fires reliably on reload, navigation, and mobile backgrounding,
  // where `beforeunload` does not.
  window.addEventListener('pagehide', flushWorkspaceSave);
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushWorkspaceSave();
  });
}

/** Applies a change and schedules persistence. */
function update(
  set: (fn: (state: WorkspaceState) => Partial<WorkspaceState>) => void,
  mutate: (workspace: Workspace) => Workspace,
): void {
  set((state) => {
    const next = mutate(state.workspace);
    scheduleSave(next);
    return { workspace: next };
  });
}

export const useWorkspace = create<WorkspaceState>()((set, get) => ({
  workspace: createDefaultWorkspace(),
  savedLayouts: [],
  recoveryNotice: null,
  hydrated: false,
  urlSymbolIntent: null,
  urlTabIntent: null,

  hydrate: async () => {
    // A server copy, when one exists, wins before anything is read — otherwise
    // the user would watch their own layout replace itself a moment later.
    await store.pull?.().catch(() => false);
    const activeId = (await store.getActiveId()) ?? 'default';
    const [result, layouts] = await Promise.all([store.load(activeId), store.list()]);
    set({
      workspace: result.workspace,
      savedLayouts: layouts,
      recoveryNotice: result.recovered ? (result.reason ?? 'saved layout was reset') : null,
      hydrated: true,
    });
  },

  /**
   * Re-reads after the account or its capabilities changed.
   *
   * Only reloads the UI when the pull actually brought something down; a no-op
   * pull must not yank the panel the user is mid-drag on.
   */
  resync: async () => {
    const changed = await store.pull?.().catch(() => false);
    if (!changed) return;
    const activeId = (await store.getActiveId()) ?? 'default';
    const [result, layouts] = await Promise.all([store.load(activeId), store.list()]);
    // A symbol the trader arrived with (a shared link) outranks the symbol the
    // saved layout remembers — the link IS the navigation.
    const intent = get().urlSymbolIntent;
    const workspace =
      intent && intent !== result.workspace.activeSymbol
        ? {
            ...result.workspace,
            activeSymbol: intent,
            chartPanes: result.workspace.chartPanes[0]
              ? [
                  { ...result.workspace.chartPanes[0], symbol: intent },
                  ...result.workspace.chartPanes.slice(1),
                ]
              : result.workspace.chartPanes,
          }
        : result.workspace;
    // The link's tab outranks the layout's remembered one for the same
    // reason its symbol does; activateWidgetIn no-ops when the layout does
    // not place that widget, which is the right degradation.
    const tabIntent = get().urlTabIntent;
    set({
      workspace: tabIntent ? activateWidgetIn(workspace, tabIntent) : workspace,
      savedLayouts: layouts,
      recoveryNotice: result.recovered ? (result.reason ?? 'saved layout was reset') : null,
    });
  },

  loadLayout: async (id) => {
    const result = await store.load(id);
    await store.setActiveId(id);
    set({
      workspace: result.workspace,
      recoveryNotice: result.recovered ? (result.reason ?? 'saved layout was reset') : null,
    });
  },

  saveAs: async (name) => {
    const id = `ws-${Date.now().toString(36)}`;
    const next: Workspace = { ...get().workspace, id, name, updatedAt: Date.now() };
    await store.save(next);
    await store.setActiveId(id);
    set({ workspace: next, savedLayouts: await store.list() });
  },

  renameActive: async (name) => {
    const next: Workspace = { ...get().workspace, name };
    await store.save(next);
    set({ workspace: next, savedLayouts: await store.list() });
  },

  duplicateActive: async (name) => {
    const id = `ws-${Date.now().toString(36)}`;
    const next: Workspace = { ...get().workspace, id, name };
    await store.save(next);
    set({ savedLayouts: await store.list() });
  },

  deleteLayout: async (id) => {
    await store.remove(id);
    const layouts = await store.list();
    set({ savedLayouts: layouts });
    // Deleting the layout you are looking at drops you back to the default
    // rather than leaving the app pointing at something that no longer exists.
    if (get().workspace.id === id) {
      const fallback = createDefaultWorkspace();
      await store.setActiveId(fallback.id);
      set({ workspace: fallback });
    }
  },

  resetToDefault: () => {
    const next = createDefaultWorkspace({ id: get().workspace.id, name: get().workspace.name });
    scheduleSave(next);
    set({ workspace: next, recoveryNotice: null });
  },

  clearRecoveryNotice: () => set({ recoveryNotice: null }),

  // ── regions ────────────────────────────────────────────────────────────────

  setRegionSize: (region, size) =>
    update(set, (workspace) => ({
      ...workspace,
      regions: {
        ...workspace.regions,
        [region]: { ...workspace.regions[region], size: clamp(size, 4, 80) },
      },
    })),

  toggleRegionCollapsed: (region) =>
    update(set, (workspace) => ({
      ...workspace,
      regions: {
        ...workspace.regions,
        [region]: {
          ...workspace.regions[region],
          collapsed: !workspace.regions[region].collapsed,
        },
      },
    })),

  setRegionCollapsed: (region, collapsed) =>
    update(set, (workspace) => ({
      ...workspace,
      regions: { ...workspace.regions, [region]: { ...workspace.regions[region], collapsed } },
    })),

  setGroupSize: (region, groupId, size) =>
    update(set, (workspace) => ({
      ...workspace,
      regions: {
        ...workspace.regions,
        [region]: {
          ...workspace.regions[region],
          groups: workspace.regions[region].groups.map((g) =>
            g.id === groupId ? { ...g, size: clamp(size, 0, 100) } : g,
          ),
        },
      },
    })),

  // ── widgets ────────────────────────────────────────────────────────────────

  addWidget: (widgetId, region) =>
    update(set, (workspace) => {
      // Adding a widget that already exists focuses it instead of duplicating.
      const existing = findWidget(workspace, widgetId);
      if (existing) return activateWidgetIn(workspace, widgetId);

      const target = workspace.regions[region];
      const groups = [
        ...target.groups,
        { id: newGroupId(), widgetIds: [widgetId], activeWidgetId: widgetId, size: 40 },
      ];
      return {
        ...workspace,
        regions: {
          ...workspace.regions,
          [region]: { ...target, groups: normaliseSizes(groups), collapsed: false },
        },
      };
    }),

  removeWidget: (widgetId) => update(set, (workspace) => removeWidgetFrom(workspace, widgetId)),

  activateWidget: (widgetId) => {
    // Any ordinary tab selection ends the URL's claim on the dock.
    if (get().urlTabIntent !== null && get().urlTabIntent !== widgetId) {
      set({ urlTabIntent: null });
    }
    update(set, (workspace) => activateWidgetIn(workspace, widgetId));
  },

  moveWidget: (widgetId, target) =>
    update(set, (workspace) => {
      const source = findWidget(workspace, widgetId);
      if (!source) return workspace;

      // Remove first so a same-region move cannot double-count the widget.
      let next = removeWidgetFrom(workspace, widgetId);
      const region = next.regions[target.region];

      if (target.groupId) {
        // Drop INTO an existing tab group.
        const groups = region.groups.map((g) =>
          g.id === target.groupId
            ? {
                ...g,
                widgetIds: insertAt(g.widgetIds, widgetId, target.index),
                activeWidgetId: widgetId,
              }
            : g,
        );
        next = {
          ...next,
          regions: { ...next.regions, [target.region]: { ...region, groups, collapsed: false } },
        };
      } else {
        // Drop as a NEW group at the requested slot.
        const group = {
          id: newGroupId(),
          widgetIds: [widgetId],
          activeWidgetId: widgetId,
          size: 40,
        };
        const groups = insertAt(region.groups, group, target.index);
        next = {
          ...next,
          regions: {
            ...next.regions,
            [target.region]: { ...region, groups: normaliseSizes(groups), collapsed: false },
          },
        };
      }
      return next;
    }),

  reorderGroup: (region, fromIndex, toIndex) =>
    update(set, (workspace) => {
      const target = workspace.regions[region];
      const groups = [...target.groups];
      const [moved] = groups.splice(fromIndex, 1);
      if (!moved) return workspace;
      groups.splice(clamp(toIndex, 0, groups.length), 0, moved);
      return {
        ...workspace,
        regions: { ...workspace.regions, [region]: { ...target, groups } },
      };
    }),

  // ── chart + symbol ─────────────────────────────────────────────────────────

  adoptUrlTab: (widgetId) => {
    set({ urlTabIntent: widgetId });
    get().activateWidget(widgetId);
    // activateWidget clears the intent as an ordinary selection; restore it —
    // adoption must outlive the resync that follows sign-in.
    set({ urlTabIntent: widgetId });
  },

  adoptUrlSymbol: (symbol) => {
    set({ urlSymbolIntent: symbol });
    get().setActiveSymbol(symbol);
    // setActiveSymbol clears the intent as an ordinary selection; restore it —
    // adoption must outlive the resync that follows sign-in.
    set({ urlSymbolIntent: symbol });
  },

  setActiveSymbol: (symbol) => {
    // Any ordinary selection ends the URL's claim on the chart.
    if (get().urlSymbolIntent !== null && get().urlSymbolIntent !== symbol) {
      set({ urlSymbolIntent: null });
    }
    return update(set, (workspace) => {
      const firstPane = workspace.chartPanes[0];
      return {
        ...workspace,
        activeSymbol: symbol,
        // The active symbol always drives the FIRST pane; other panes are
        // independently pinned so a watchlist click cannot disturb them.
        chartPanes: firstPane
          ? [{ ...firstPane, symbol }, ...workspace.chartPanes.slice(1)]
          : workspace.chartPanes,
        recentSymbols: [symbol, ...workspace.recentSymbols.filter((s) => s !== symbol)].slice(
          0,
          20,
        ),
      };
    });
  },

  setActiveInterval: (interval) =>
    update(set, (workspace) => {
      const firstPane = workspace.chartPanes[0];
      return {
        ...workspace,
        activeInterval: interval,
        chartPanes: firstPane
          ? [{ ...firstPane, interval }, ...workspace.chartPanes.slice(1)]
          : workspace.chartPanes,
      };
    }),

  setChartLayout: (layout) =>
    update(set, (workspace) => {
      const wanted = MAX_CHART_PANES[layout];
      const panes = [...workspace.chartPanes];
      // Growing reuses the active symbol; shrinking drops the trailing panes
      // but keeps their state in case the user switches back within a session.
      while (panes.length < wanted) {
        panes.push({
          id: `pane-${panes.length + 1}`,
          symbol: workspace.activeSymbol,
          interval: workspace.activeInterval,
        });
      }
      return { ...workspace, chartLayout: layout, chartPanes: panes.slice(0, wanted) };
    }),

  setPaneSymbol: (paneId, symbol) =>
    update(set, (workspace) => ({
      ...workspace,
      chartPanes: workspace.chartPanes.map((p) => (p.id === paneId ? { ...p, symbol } : p)),
    })),

  setPaneChartState: (paneId, state) =>
    update(set, (workspace) => ({
      ...workspace,
      chartPanes: workspace.chartPanes.map((p) =>
        p.id === paneId ? { ...p, chartState: state } : p,
      ),
    })),

  // ── tables ─────────────────────────────────────────────────────────────────

  toggleTableColumn: (tableId, columnId) =>
    update(set, (workspace) => {
      const current = workspace.tables[tableId] ?? { hiddenColumns: [], order: [] };
      const hiddenColumns = current.hiddenColumns.includes(columnId)
        ? current.hiddenColumns.filter((id) => id !== columnId)
        : [...current.hiddenColumns, columnId];

      return {
        ...workspace,
        tables: { ...workspace.tables, [tableId]: { ...current, hiddenColumns } },
      };
    }),

  resetTableColumns: (tableId) =>
    update(set, (workspace) => {
      const next = { ...workspace.tables };
      delete next[tableId];
      return { ...workspace, tables: next };
    }),

  // ── preferences ────────────────────────────────────────────────────────────

  setTheme: (theme) => update(set, (workspace) => ({ ...workspace, theme })),
  setDensity: (density) => update(set, (workspace) => ({ ...workspace, density })),
  setOneClickTrading: (oneClickTrading) =>
    update(set, (workspace) => ({ ...workspace, oneClickTrading })),
  setConfirmTrades: (confirmTrades) =>
    update(set, (workspace) => ({ ...workspace, confirmTrades })),

  // ── watchlists ─────────────────────────────────────────────────────────────

  setActiveWatchlist: (id) => update(set, (workspace) => ({ ...workspace, activeWatchlistId: id })),

  addWatchlist: (name) =>
    update(set, (workspace) => {
      const watchlist: Watchlist = { id: `wl-${Date.now().toString(36)}`, name, symbols: [] };
      return {
        ...workspace,
        watchlists: [...workspace.watchlists, watchlist],
        activeWatchlistId: watchlist.id,
      };
    }),

  removeWatchlist: (id) =>
    update(set, (workspace) => {
      // Never leave the user with zero watchlists — the widget would have
      // nothing to render and no way to recover from the UI.
      if (workspace.watchlists.length <= 1) return workspace;
      const watchlists = workspace.watchlists.filter((w) => w.id !== id);
      const first = watchlists[0];
      return {
        ...workspace,
        watchlists,
        activeWatchlistId:
          workspace.activeWatchlistId === id && first ? first.id : workspace.activeWatchlistId,
      };
    }),

  addSymbolToWatchlist: (symbol, watchlistId) =>
    update(set, (workspace) =>
      mapWatchlist(workspace, watchlistId, (w) =>
        w.symbols.includes(symbol) ? w : { ...w, symbols: [...w.symbols, symbol] },
      ),
    ),

  removeSymbolFromWatchlist: (symbol, watchlistId) =>
    update(set, (workspace) =>
      mapWatchlist(workspace, watchlistId, (w) => ({
        ...w,
        symbols: w.symbols.filter((s) => s !== symbol),
      })),
    ),

  reorderWatchlistSymbols: (fromIndex, toIndex, watchlistId) =>
    update(set, (workspace) =>
      mapWatchlist(workspace, watchlistId, (w) => {
        const symbols = [...w.symbols];
        const [moved] = symbols.splice(fromIndex, 1);
        if (!moved) return w;
        symbols.splice(clamp(toIndex, 0, symbols.length), 0, moved);
        return { ...w, symbols };
      }),
    ),

  toggleFavorite: (symbol) =>
    update(set, (workspace) => ({
      ...workspace,
      favorites: workspace.favorites.includes(symbol)
        ? workspace.favorites.filter((s) => s !== symbol)
        : [...workspace.favorites, symbol],
    })),
}));

// ── helpers ──────────────────────────────────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function insertAt<T>(items: readonly T[], item: T, index: number | undefined): T[] {
  const next = [...items];
  next.splice(index === undefined ? next.length : clamp(index, 0, next.length), 0, item);
  return next;
}

function findWidget(
  workspace: Workspace,
  widgetId: string,
): { region: RegionId; groupId: string } | null {
  for (const [region, state] of Object.entries(workspace.regions) as [
    RegionId,
    Workspace['regions'][RegionId],
  ][]) {
    for (const group of state.groups) {
      if (group.widgetIds.includes(widgetId)) return { region, groupId: group.id };
    }
  }
  return null;
}

function removeWidgetFrom(workspace: Workspace, widgetId: string): Workspace {
  const regions = { ...workspace.regions };

  for (const region of Object.keys(regions) as RegionId[]) {
    const state = regions[region];
    if (!state.groups.some((g) => g.widgetIds.includes(widgetId))) continue;

    const groups = state.groups
      .map((group) => {
        if (!group.widgetIds.includes(widgetId)) return group;
        const widgetIds = group.widgetIds.filter((id) => id !== widgetId);
        if (widgetIds.length === 0) return null; // group becomes empty
        return {
          ...group,
          widgetIds,
          // If the removed widget was active, fall back to the first remaining.
          activeWidgetId:
            group.activeWidgetId === widgetId ? (widgetIds[0] as string) : group.activeWidgetId,
        };
      })
      .filter((g): g is NonNullable<typeof g> => g !== null);

    regions[region] = { ...state, groups: normaliseSizes(groups) };
  }

  return { ...workspace, regions };
}

function activateWidgetIn(workspace: Workspace, widgetId: string): Workspace {
  const location = findWidget(workspace, widgetId);
  if (!location) return workspace;

  const region = workspace.regions[location.region];
  return {
    ...workspace,
    regions: {
      ...workspace.regions,
      [location.region]: {
        ...region,
        // Activating a widget in a collapsed region must also open the region,
        // otherwise the command appears to do nothing.
        collapsed: false,
        groups: region.groups.map((g) =>
          g.id === location.groupId ? { ...g, activeWidgetId: widgetId } : g,
        ),
      },
    },
  };
}

/** Rebalances group sizes to sum to 100 after an add/remove. */
function normaliseSizes<T extends { size: number }>(groups: T[]): T[] {
  if (groups.length === 0) return groups;
  const total = groups.reduce((sum, g) => sum + g.size, 0);
  if (total <= 0) {
    const even = 100 / groups.length;
    return groups.map((g) => ({ ...g, size: even }));
  }
  return groups.map((g) => ({ ...g, size: (g.size / total) * 100 }));
}

function mapWatchlist(
  workspace: Workspace,
  watchlistId: string | undefined,
  mutate: (watchlist: Watchlist) => Watchlist,
): Workspace {
  const targetId = watchlistId ?? workspace.activeWatchlistId;
  return {
    ...workspace,
    watchlists: workspace.watchlists.map((w) => (w.id === targetId ? mutate(w) : w)),
  };
}

/**
 * Every widget currently placed in the workspace, in any region.
 *
 * "Placed" is not the same as "visible": a widget in a collapsed region or
 * behind another tab is still open, and the Panels picker treats it as such —
 * clicking it reveals it rather than adding a second copy.
 */
export function openWidgetIds(workspace: Workspace): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const region of Object.values(workspace.regions)) {
    for (const group of region.groups) {
      for (const widgetId of group.widgetIds) ids.add(widgetId);
    }
  }
  return ids;
}

// Selectors
export const selectWorkspace = (s: WorkspaceState) => s.workspace;
export const selectActiveSymbol = (s: WorkspaceState) => s.workspace.activeSymbol;
export const selectTheme = (s: WorkspaceState) => s.workspace.theme;
export const selectRegions = (s: WorkspaceState) => s.workspace.regions;
export const selectActiveWatchlist = (s: WorkspaceState) =>
  s.workspace.watchlists.find((w) => w.id === s.workspace.activeWatchlistId) ??
  s.workspace.watchlists[0];
