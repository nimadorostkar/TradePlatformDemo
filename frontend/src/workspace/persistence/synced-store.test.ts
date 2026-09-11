import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultWorkspace, WORKSPACE_SCHEMA_VERSION, type Workspace } from './schema';
import { LocalWorkspaceStore } from './storage';
import { SyncedWorkspaceStore, type RemoteWorkspaceGateway } from './synced-store';

/** An in-memory Storage, so each test starts from a genuinely empty browser. */
function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key) => map.get(key) ?? null,
    key: (index) => [...map.keys()][index] ?? null,
    removeItem: (key) => void map.delete(key),
    setItem: (key, value) => void map.set(key, value),
  } as Storage;
}

function workspace(overrides: Partial<Workspace> = {}): Workspace {
  return { ...createDefaultWorkspace({ id: 'default' }), ...overrides };
}

function bundle(workspaces: Workspace[], updatedAt: number, activeId: string | null = 'default') {
  return { bundleVersion: 1 as const, updatedAt, activeId, workspaces };
}

describe('SyncedWorkspaceStore', () => {
  let local: LocalWorkspaceStore;
  let remote: RemoteWorkspaceGateway & {
    getWorkspace: ReturnType<typeof vi.fn>;
    saveWorkspace: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    local = new LocalWorkspaceStore(memoryStorage());
    remote = {
      getWorkspace: vi.fn().mockResolvedValue(null),
      saveWorkspace: vi.fn().mockResolvedValue(undefined),
    };
  });

  function create(overrides: Partial<Parameters<typeof makeOptions>[0]> = {}) {
    return new SyncedWorkspaceStore(makeOptions(overrides));
  }

  function makeOptions(overrides: {
    login?: string | null;
    enabled?: boolean;
    onError?: (error: unknown) => void;
    readJournal?: () => unknown[];
    applyJournal?: (entries: unknown[]) => void;
  }) {
    return {
      local,
      remote,
      getLogin: () => (overrides.login === undefined ? '5001' : overrides.login),
      isEnabled: () => overrides.enabled ?? true,
      onError: overrides.onError ?? (() => {}),
      pushDebounceMs: 0,
      ...(overrides.readJournal ? { readJournal: overrides.readJournal } : {}),
      ...(overrides.applyJournal ? { applyJournal: overrides.applyJournal } : {}),
    };
  }

  // ── The rule that protects a real layout from a fresh browser ──────────────

  it('does not push before a pull has succeeded', async () => {
    const store = create();
    await store.save(workspace());
    await store.flush();
    expect(remote.saveWorkspace).not.toHaveBeenCalled();
  });

  it('does not push when the pull failed', async () => {
    remote.getWorkspace.mockRejectedValue(new Error('gateway down'));
    const store = create();
    await store.pull();
    await store.save(workspace());
    await store.flush();
    expect(remote.saveWorkspace).not.toHaveBeenCalled();
  });

  it('pushes after a pull that found nothing stored', async () => {
    const store = create();
    await store.pull();
    await store.save(workspace());
    await store.flush();
    expect(remote.saveWorkspace).toHaveBeenCalledWith('5001', expect.anything());
  });

  it('leaves an unreadable stored bundle untouched', async () => {
    remote.getWorkspace.mockResolvedValue({ bundleVersion: 99, nonsense: true });
    const onError = vi.fn();
    const store = create({ onError });

    expect(await store.pull()).toBe(false);
    expect(onError).toHaveBeenCalled();

    await store.save(workspace());
    await store.flush();
    // Overwriting data we could not interpret would destroy it.
    expect(remote.saveWorkspace).not.toHaveBeenCalled();
  });

  it('stops pushing under the previous login after reset', async () => {
    const store = create();
    await store.pull();
    store.reset();
    await store.save(workspace());
    await store.flush();
    expect(remote.saveWorkspace).not.toHaveBeenCalled();
  });

  // ── Pull semantics ─────────────────────────────────────────────────────────

  it('adopts the remote bundle when local has no layouts', async () => {
    const remoteWorkspace = workspace({ id: 'ws-remote', name: 'From server' });
    remote.getWorkspace.mockResolvedValue(bundle([remoteWorkspace], Date.now(), 'ws-remote'));

    const store = create();
    expect(await store.pull()).toBe(true);
    expect(await store.getActiveId()).toBe('ws-remote');
    expect((await store.list()).map((entry) => entry.id)).toContain('ws-remote');
  });

  it('keeps a newer local layout rather than taking a stale remote one', async () => {
    await local.save(workspace({ id: 'default', name: 'Local' }));
    remote.getWorkspace.mockResolvedValue(
      bundle([workspace({ id: 'default', name: 'Stale' })], Date.now() - 60_000),
    );

    const store = create();
    expect(await store.pull()).toBe(false);
    expect((await store.load('default')).workspace.name).toBe('Local');
  });

  it('skips a remote layout that does not validate but keeps the rest', async () => {
    const good = workspace({ id: 'ws-good', name: 'Good' });
    remote.getWorkspace.mockResolvedValue(
      bundle([{ id: 'ws-bad', schemaVersion: WORKSPACE_SCHEMA_VERSION }, good], Date.now()),
    );

    const store = create();
    expect(await store.pull()).toBe(true);
    const ids = (await store.list()).map((entry) => entry.id);
    expect(ids).toContain('ws-good');
    expect(ids).not.toContain('ws-bad');
  });

  it('is inert with no active account', async () => {
    const store = create({ login: null });
    expect(await store.pull()).toBe(false);
    expect(remote.getWorkspace).not.toHaveBeenCalled();
  });

  it('is inert when the gateway does not report workspace storage', async () => {
    const store = create({ enabled: false });
    expect(await store.pull()).toBe(false);
    expect(remote.getWorkspace).not.toHaveBeenCalled();
  });

  // ── Push semantics ─────────────────────────────────────────────────────────

  it('uploads every stored layout with the active id', async () => {
    const store = create();
    await store.pull();
    await store.save(workspace({ id: 'default', name: 'One' }));
    await store.save(workspace({ id: 'ws-2', name: 'Two' }));
    await store.setActiveId('ws-2');
    await store.flush();

    const [, document] = remote.saveWorkspace.mock.calls.at(-1)!;
    expect(document.bundleVersion).toBe(1);
    expect(document.activeId).toBe('ws-2');
    expect(document.workspaces.map((w: Workspace) => w.id).sort()).toEqual(['default', 'ws-2']);
  });

  it('reports a failed push without throwing at the caller', async () => {
    remote.saveWorkspace.mockRejectedValue(new Error('quota'));
    const onError = vi.fn();
    const store = create({ onError });
    await store.pull();
    await store.save(workspace());
    await expect(store.flush()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalled();
  });

  // ── Unchanged layouts must not become database writes ──────────────────────

  // A single document reused across saves. Rebuilding it per save would mint
  // fresh group ids (`newGroupId`), so the layouts would differ for a reason
  // the app never produces — real saves come from mutating store state.
  it('skips the push when the bundle is unchanged from the last one sent', async () => {
    const store = create();
    const layout = workspace({ name: 'One' });
    await store.pull();

    await store.save(layout);
    await store.flush();
    expect(remote.saveWorkspace).toHaveBeenCalledTimes(1);

    // The same layout saved again — a panel switch that restored what was
    // already there. Debouncing cannot catch this; only content can.
    await store.save(layout);
    await store.flush();
    expect(remote.saveWorkspace).toHaveBeenCalledTimes(1);
  });

  it('pushes again as soon as something actually changes', async () => {
    const store = create();
    const layout = workspace({ name: 'One' });
    await store.pull();

    await store.save(layout);
    await store.flush();
    await store.save(layout);
    await store.flush();
    await store.save({ ...layout, name: 'Two' });
    await store.flush();

    expect(remote.saveWorkspace).toHaveBeenCalledTimes(2);
    expect(remote.saveWorkspace.mock.calls.at(-1)![1].workspaces[0].name).toBe('Two');
  });

  it('ignores the updatedAt restamp that every local save applies', async () => {
    const store = create();
    const layout = workspace({ name: 'One' });
    await store.pull();

    await store.save(layout);
    await store.flush();
    // `LocalWorkspaceStore.save` stamps a new `updatedAt` every time. If the
    // signature counted it, nothing would ever dedupe.
    await store.save({ ...layout, updatedAt: layout.updatedAt + 60_000 });
    await store.flush();

    expect(remote.saveWorkspace).toHaveBeenCalledTimes(1);
  });

  it('retries after a failed push rather than treating it as sent', async () => {
    remote.saveWorkspace.mockRejectedValueOnce(new Error('offline'));
    const store = create();
    const layout = workspace({ name: 'One' });
    await store.pull();

    await store.save(layout);
    await store.flush();
    // Same content, but the first attempt never landed — it must go again.
    await store.save(layout);
    await store.flush();

    expect(remote.saveWorkspace).toHaveBeenCalledTimes(2);
  });

  it('does not let one account’s signature suppress the next account’s first push', async () => {
    const store = create();
    const layout = workspace({ name: 'One' });
    await store.pull();
    await store.save(layout);
    await store.flush();
    expect(remote.saveWorkspace).toHaveBeenCalledTimes(1);

    store.reset();
    await store.pull();
    await store.save(layout);
    await store.flush();

    expect(remote.saveWorkspace).toHaveBeenCalledTimes(2);
  });

  // ── Reads never touch the network ──────────────────────────────────────────

  it('serves reads from local storage', async () => {
    await local.save(workspace({ id: 'default', name: 'Local only' }));
    const store = create();
    expect((await store.load('default')).workspace.name).toBe('Local only');
    expect(remote.getWorkspace).not.toHaveBeenCalled();
  });

  describe('journal in the bundle (MED-07)', () => {
    it('pushes journal entries alongside the layouts', async () => {
      const note = {
        id: 'j1',
        createdAt: 1,
        updatedAt: 2,
        symbol: null,
        body: 'note',
        mood: 'neutral',
        tags: [],
      };
      const store = create({ readJournal: () => [note] });
      await store.pull();
      await store.save(workspace());
      await vi.waitFor(() => expect(remote.saveWorkspace).toHaveBeenCalled());
      const sent = remote.saveWorkspace.mock.calls.at(-1)?.[1] as { journal?: unknown[] };
      expect(sent.journal).toEqual([note]);
    });

    it("applies a pulled bundle's journal even when no layout is newer", async () => {
      const note = {
        id: 'j9',
        createdAt: 5,
        updatedAt: 6,
        symbol: null,
        body: 'remote note',
        mood: 'neutral',
        tags: [],
      };
      const applied: unknown[][] = [];
      // Local already has a NEWER workspace than the bundle, so layouts skip.
      await local.save(workspace({ updatedAt: 100 }));
      remote.getWorkspace.mockResolvedValue({
        ...bundle([workspace({ updatedAt: 50 })], 50),
        journal: [note],
      });
      const store = create({ applyJournal: (entries) => applied.push(entries) });
      await store.pull();
      expect(applied).toEqual([[note]]);
    });

    it('a journal-only change still pushes a new bundle', async () => {
      let notes: unknown[] = [];
      const store = create({ readJournal: () => notes });
      await store.pull();
      await store.save(workspace());
      await vi.waitFor(() => expect(remote.saveWorkspace).toHaveBeenCalledTimes(1));
      // Same layouts, new note: the signature must change and push again.
      notes = [
        {
          id: 'j2',
          createdAt: 3,
          updatedAt: 4,
          symbol: null,
          body: 'x',
          mood: 'neutral',
          tags: [],
        },
      ];
      store.notifyExternalChange();
      await vi.waitFor(() => expect(remote.saveWorkspace).toHaveBeenCalledTimes(2));
    });
  });
});
