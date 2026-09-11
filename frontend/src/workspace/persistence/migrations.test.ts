import { describe, expect, it } from 'vitest';
import { LocalWorkspaceStore } from './storage';
import { migrateWorkspace } from './migrations';
import { createDefaultWorkspace, WORKSPACE_SCHEMA_VERSION, workspaceSchema } from './schema';

describe('migrateWorkspace', () => {
  it('upgrades a v1 document all the way to the current version', () => {
    const v1 = {
      schemaVersion: 1,
      id: 'default',
      name: 'Default',
      updatedAt: 1,
      activeSymbol: 'EURUSD',
      activeInterval: '5',
      theme: 'dark',
      density: 'normal',
      watchlists: [{ id: 'w', name: 'W', symbols: ['EURUSD'] }],
      activeWatchlistId: 'w',
      regions: {
        left: { widgetIds: ['watchlist', 'favorites'], collapsed: false, size: 20 },
        right: { widgetIds: ['order-ticket'], collapsed: false, size: 20 },
        bottom: { widgetIds: ['positions'], collapsed: false, size: 25 },
        'center-overlay': { widgetIds: [], collapsed: true, size: 20 },
      },
    };

    const migrated = migrateWorkspace(v1);
    expect(migrated).not.toBeNull();
    expect(migrated?.schemaVersion).toBe(WORKSPACE_SCHEMA_VERSION);

    // Each v1 widget becomes its own tab group, preserving the arrangement.
    const regions = migrated?.regions as Record<string, { groups: unknown[] }>;
    expect(regions.left?.groups).toHaveLength(2);
    expect(regions.right?.groups).toHaveLength(1);

    // v2 introduced the multi-chart pane model.
    expect(migrated?.chartLayout).toBe('single');
    expect(migrated?.chartPanes).toHaveLength(1);

    // v3 introduced per-table column preferences.
    expect(migrated?.tables).toEqual({});
  });

  it('upgrades a v2 document to v3 without disturbing its layout', () => {
    const v2 = {
      ...createDefaultWorkspace(),
      schemaVersion: 2,
      tables: undefined,
    } as unknown as Record<string, unknown>;

    const migrated = migrateWorkspace(v2);
    expect(migrated?.schemaVersion).toBe(WORKSPACE_SCHEMA_VERSION);
    expect(migrated?.tables).toEqual({});
    expect(workspaceSchema.safeParse(migrated).success).toBe(true);
  });

  it('rejects a document from a newer schema version', () => {
    // Downgrading the app must not corrupt a layout it cannot understand.
    expect(migrateWorkspace({ schemaVersion: 999, id: 'x' })).toBeNull();
  });

  it('rejects non-objects', () => {
    expect(migrateWorkspace(null)).toBeNull();
    expect(migrateWorkspace('layout')).toBeNull();
    expect(migrateWorkspace([1, 2])).toBeNull();
  });

  it('passes a current-version document through', () => {
    const current = createDefaultWorkspace();
    const migrated = migrateWorkspace(current as unknown as Record<string, unknown>);
    expect(workspaceSchema.safeParse(migrated).success).toBe(true);
  });
});

describe('LocalWorkspaceStore recovery', () => {
  function storageWith(entries: Record<string, string>): Storage {
    const map = new Map(Object.entries(entries));
    return {
      get length() {
        return map.size;
      },
      clear: () => map.clear(),
      getItem: (key: string) => map.get(key) ?? null,
      key: (index: number) => [...map.keys()][index] ?? null,
      removeItem: (key: string) => void map.delete(key),
      setItem: (key: string, value: string) => void map.set(key, value),
    };
  }

  it('recovers to the default layout when the stored document is corrupt', async () => {
    // A malformed saved layout must never prevent the terminal from starting.
    const store = new LocalWorkspaceStore(
      storageWith({ 'tradeplatform.workspace.v3.default': '{ this is not json' }),
    );
    const result = await store.load('default');

    expect(result.recovered).toBe(true);
    expect(result.workspace.id).toBe('default');
    expect(workspaceSchema.safeParse(result.workspace).success).toBe(true);
  });

  it('recovers when the document is valid JSON but fails validation', async () => {
    const store = new LocalWorkspaceStore(
      storageWith({
        'tradeplatform.workspace.v3.default': JSON.stringify({
          schemaVersion: WORKSPACE_SCHEMA_VERSION,
          id: 'default',
          // `name`, `regions`, `watchlists` and more are missing.
        }),
      }),
    );
    const result = await store.load('default');

    expect(result.recovered).toBe(true);
    expect(result.reason).toMatch(/invalid/i);
    expect(workspaceSchema.safeParse(result.workspace).success).toBe(true);
  });

  it('returns the default without flagging recovery when nothing is stored', async () => {
    const store = new LocalWorkspaceStore(storageWith({}));
    const result = await store.load('default');
    expect(result.recovered).toBe(false);
  });

  it('survives a storage that throws on every access', async () => {
    const hostile: Storage = {
      length: 0,
      clear: () => {
        throw new Error('blocked');
      },
      getItem: () => {
        throw new Error('blocked');
      },
      key: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };

    const store = new LocalWorkspaceStore(hostile);
    await expect(store.load('default')).resolves.toBeDefined();
    await expect(store.save(createDefaultWorkspace())).resolves.toBeUndefined();
  });
});
