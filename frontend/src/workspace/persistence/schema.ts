import { z } from 'zod';
import type { RegionId } from '../registry/types';

/**
 * Versioned workspace document.
 *
 * Rules that make this safe to persist:
 *   - `schemaVersion` is checked on every load and migrated forward.
 *   - The document is runtime-validated; a malformed one is DISCARDED and the
 *     safe default is used. A corrupt saved layout must never prevent the
 *     terminal from starting.
 *   - It contains NO account-scoped data. Layouts follow the user, not the
 *     account, so switching accounts cannot leak one account's view into
 *     another's.
 */

export const WORKSPACE_SCHEMA_VERSION = 3;

export const regionIdSchema = z.enum(['left', 'right', 'bottom', 'center-overlay']);

/** A tab group holds one or more widgets; only the active one renders. */
export const widgetGroupSchema = z.object({
  id: z.string().min(1),
  widgetIds: z.array(z.string().min(1)).min(1),
  activeWidgetId: z.string().min(1),
  /** Percentage of the region's variable axis. */
  size: z.number().min(0).max(100).default(50),
});

export const regionStateSchema = z.object({
  groups: z.array(widgetGroupSchema).default([]),
  collapsed: z.boolean().default(false),
  /** Percentage of the shell axis this region occupies when expanded. */
  size: z.number().min(4).max(80).default(20),
  pinned: z.boolean().default(true),
});

export const chartLayoutSchema = z.enum([
  'single',
  'two-vertical',
  'two-horizontal',
  'three',
  'four',
]);

export const chartPaneSchema = z.object({
  id: z.string().min(1),
  symbol: z.string().min(1),
  interval: z.string().min(1),
  /** Opaque TradingView chart state, stored verbatim. */
  chartState: z.unknown().optional(),
});

export const watchlistSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(60),
  /** Display symbols (no suffix) — the suffix depends on the active account. */
  symbols: z.array(z.string().min(1)).max(500).default([]),
});

/**
 * Per-table column preferences.
 *
 * Keyed by table id, then column id. Hidden columns are listed explicitly
 * rather than storing the visible set, so a column added in a later release
 * appears by default instead of silently staying hidden for existing users.
 */
export const tablePreferencesSchema = z.object({
  hiddenColumns: z.array(z.string().min(1)).default([]),
  /** Column ids in display order; unknown or new ids fall back to registry order. */
  order: z.array(z.string().min(1)).default([]),
});

export const workspaceSchema = z.object({
  schemaVersion: z.literal(WORKSPACE_SCHEMA_VERSION),
  id: z.string().min(1),
  name: z.string().min(1).max(60),
  updatedAt: z.number().int().nonnegative(),

  theme: z.enum(['dark', 'light', 'system']).default('dark'),
  density: z.enum(['compact', 'normal', 'relaxed']).default('normal'),

  activeSymbol: z.string().min(1).default('XAUUSD'),
  activeInterval: z.string().min(1).default('1'),

  chartLayout: chartLayoutSchema.default('single'),
  chartPanes: z.array(chartPaneSchema).min(1).max(4),

  regions: z.object({
    left: regionStateSchema,
    right: regionStateSchema,
    bottom: regionStateSchema,
    'center-overlay': regionStateSchema,
  }),

  watchlists: z.array(watchlistSchema).min(1),
  activeWatchlistId: z.string().min(1),

  favorites: z.array(z.string().min(1)).max(500).default([]),
  recentSymbols: z.array(z.string().min(1)).max(30).default([]),

  /** Opt-in trading affordances, persisted per workspace. */
  oneClickTrading: z.boolean().default(false),
  confirmTrades: z.boolean().default(true),

  tables: z.record(z.string(), tablePreferencesSchema).default({}),
});

export type Workspace = z.infer<typeof workspaceSchema>;
export type RegionState = z.infer<typeof regionStateSchema>;
export type WidgetGroup = z.infer<typeof widgetGroupSchema>;
export type ChartLayout = z.infer<typeof chartLayoutSchema>;
export type Watchlist = z.infer<typeof watchlistSchema>;
export type TablePreferences = z.infer<typeof tablePreferencesSchema>;

let groupCounter = 0;
export function newGroupId(): string {
  groupCounter += 1;
  return `g${Date.now().toString(36)}${groupCounter}`;
}

function group(widgetIds: string[], size = 50): WidgetGroup {
  const first = widgetIds[0];
  if (!first) throw new Error('A widget group needs at least one widget');
  return { id: newGroupId(), widgetIds, activeWidgetId: first, size };
}

/** The default desktop composition. */
export function createDefaultWorkspace(
  overrides: Partial<Pick<Workspace, 'id' | 'name' | 'activeSymbol'>> = {},
): Workspace {
  const symbol = overrides.activeSymbol ?? 'XAUUSD';
  return {
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    id: overrides.id ?? 'default',
    name: overrides.name ?? 'Default',
    updatedAt: Date.now(),
    theme: 'dark',
    density: 'normal',
    activeSymbol: symbol,
    activeInterval: '1',
    chartLayout: 'single',
    chartPanes: [{ id: 'pane-1', symbol, interval: '1' }],
    regions: {
      left: {
        groups: [group(['watchlist', 'symbol-search'], 60), group(['favorites'], 40)],
        collapsed: false,
        size: 17,
        pinned: true,
      },
      right: {
        groups: [group(['order-ticket'], 62), group(['symbol-details', 'risk-calculator'], 38)],
        collapsed: false,
        size: 20,
        pinned: true,
      },
      bottom: {
        groups: [
          group(
            [
              'positions',
              'pending-orders',
              'order-history',
              'deals',
              'account-summary',
              'system-messages',
            ],
            100,
          ),
        ],
        collapsed: false,
        size: 26,
        pinned: true,
      },
      'center-overlay': { groups: [], collapsed: true, size: 20, pinned: false },
    },
    watchlists: [
      {
        id: 'default',
        name: 'My symbols',
        symbols: ['XAUUSD', 'EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCAD'],
      },
    ],
    activeWatchlistId: 'default',
    favorites: [],
    recentSymbols: [],
    oneClickTrading: false,
    confirmTrades: true,
    tables: {},
  };
}

/** An alternate chart-focused layout, shipped so users have a real choice. */
export function createChartFocusedWorkspace(): Workspace {
  const base = createDefaultWorkspace({ id: 'chart-focus', name: 'Chart focus' });
  return {
    ...base,
    regions: {
      ...base.regions,
      left: { ...base.regions.left, groups: [group(['watchlist'], 100)], size: 13 },
      right: { ...base.regions.right, collapsed: true, size: 18 },
      bottom: {
        ...base.regions.bottom,
        groups: [group(['positions', 'pending-orders'], 100)],
        size: 18,
      },
    },
  };
}

export const REGION_IDS: readonly RegionId[] = ['left', 'right', 'bottom', 'center-overlay'];
