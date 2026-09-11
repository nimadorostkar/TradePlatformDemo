import { WORKSPACE_SCHEMA_VERSION, newGroupId } from './schema';

/**
 * Forward-only workspace migrations.
 *
 * Each step upgrades one version. A document from an unknown FUTURE version is
 * rejected (returns null) rather than guessed at — the caller then falls back
 * to the default layout, which is the safe outcome when a user has downgraded.
 */

type Migration = (input: Record<string, unknown>) => Record<string, unknown>;

/**
 * v1 → v2: regions held a flat `widgetIds` array; v2 introduces tab GROUPS so
 * several widgets can share one slot. Each old widget becomes its own group,
 * preserving the visible arrangement.
 */
const migrateV1ToV2: Migration = (input) => {
  const regions = (input.regions ?? {}) as Record<string, unknown>;
  const nextRegions: Record<string, unknown> = {};

  for (const [regionId, value] of Object.entries(regions)) {
    const region = (value ?? {}) as Record<string, unknown>;
    const widgetIds = Array.isArray(region.widgetIds)
      ? (region.widgetIds as unknown[]).filter((id): id is string => typeof id === 'string')
      : [];

    const groups = widgetIds.map((widgetId) => ({
      id: newGroupId(),
      widgetIds: [widgetId],
      activeWidgetId: widgetId,
      size: widgetIds.length > 0 ? 100 / widgetIds.length : 100,
    }));

    nextRegions[regionId] = {
      groups,
      collapsed: region.collapsed ?? false,
      size: region.size ?? 20,
      pinned: region.pinned ?? true,
    };
  }

  // v2 added the multi-chart pane model; v1 only ever had one chart.
  const chartPanes = [
    {
      id: 'pane-1',
      symbol: typeof input.activeSymbol === 'string' ? input.activeSymbol : 'XAUUSD',
      interval: typeof input.activeInterval === 'string' ? input.activeInterval : '1',
      chartState: input.chartState,
    },
  ];

  return {
    ...input,
    schemaVersion: 2,
    regions: nextRegions,
    chartLayout: 'single',
    chartPanes,
  };
};

/**
 * v2 → v3: adds per-table column preferences. Nothing to transform — an empty
 * map means "every table uses its default columns", which is the pre-v3
 * behaviour.
 */
const migrateV2ToV3: Migration = (input) => ({
  ...input,
  schemaVersion: 3,
  tables: typeof input.tables === 'object' && input.tables !== null ? input.tables : {},
});

const MIGRATIONS: Readonly<Record<number, Migration>> = {
  1: migrateV1ToV2,
  2: migrateV2ToV3,
};

/**
 * Brings a stored document up to the current schema version.
 * Returns null when the document is not an object, has no usable version, or
 * comes from a newer version than this build understands.
 */
export function migrateWorkspace(input: unknown): Record<string, unknown> | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;

  let document = { ...(input as Record<string, unknown>) };
  let version = typeof document.schemaVersion === 'number' ? document.schemaVersion : 1;

  if (version > WORKSPACE_SCHEMA_VERSION) return null;

  // Bounded loop: a malformed migration that fails to advance the version must
  // not spin forever on application startup.
  let guard = 0;
  while (version < WORKSPACE_SCHEMA_VERSION) {
    if (guard++ > 32) return null;

    const migration = MIGRATIONS[version];
    if (!migration) return null;

    document = migration(document);
    const next = typeof document.schemaVersion === 'number' ? document.schemaVersion : version + 1;
    if (next <= version) return null;
    version = next;
  }

  return document;
}
