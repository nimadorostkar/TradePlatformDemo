import {
  createDefaultWorkspace,
  WORKSPACE_SCHEMA_VERSION,
  workspaceSchema,
  type Workspace,
} from './schema';
import { migrateWorkspace } from './migrations';

/**
 * Workspace persistence.
 *
 * Deliberately behind an interface. This is the localStorage implementation;
 * `SyncedWorkspaceStore` decorates it to mirror layouts to the gateway when the
 * deployment reports it stores them.
 *
 * The load path is defensive by design. A saved layout is user data that has
 * been through older app versions, browser sync, and manual edits. If it does
 * not validate, we discard it and start from the default — a terminal that will
 * not open is a far worse failure than a lost layout.
 */

export interface WorkspaceStore {
  list(): Promise<WorkspaceSummary[]>;
  load(id: string): Promise<WorkspaceLoadResult>;
  save(workspace: Workspace): Promise<void>;
  remove(id: string): Promise<void>;
  getActiveId(): Promise<string | null>;
  setActiveId(id: string): Promise<void>;
  /**
   * Refreshes from a remote copy, resolving true when local state changed.
   * Absent on stores with nowhere to sync to.
   */
  pull?(signal?: AbortSignal): Promise<boolean>;
  /** Writes any deferred remote push immediately. */
  flush?(): Promise<void>;
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  updatedAt: number;
}

export interface WorkspaceLoadResult {
  workspace: Workspace;
  /** True when the stored document was unusable and the default was used. */
  recovered: boolean;
  /** Human-readable reason, surfaced in System Messages. */
  reason?: string;
}

/** Outcome of reading a stored value: absent, readable, or corrupt. */
type ReadResult<T> =
  { status: 'absent' } | { status: 'ok'; value: T } | { status: 'unreadable'; reason: string };

const KEY_PREFIX = 'tradeplatform.workspace.v3.';
const INDEX_KEY = 'tradeplatform.workspace.index';
const ACTIVE_KEY = 'tradeplatform.workspace.active';

export class LocalWorkspaceStore implements WorkspaceStore {
  private readonly storage: Storage | null;

  constructor(storage?: Storage) {
    this.storage = storage ?? (typeof localStorage === 'undefined' ? null : localStorage);
  }

  async list(): Promise<WorkspaceSummary[]> {
    const stored = this.readJson<WorkspaceSummary[]>(INDEX_KEY);
    const index = stored.status === 'ok' ? stored.value : null;
    if (!Array.isArray(index)) return [];
    return index.filter(
      (entry): entry is WorkspaceSummary =>
        typeof entry?.id === 'string' && typeof entry?.name === 'string',
    );
  }

  async load(id: string): Promise<WorkspaceLoadResult> {
    const stored = this.readJson<unknown>(KEY_PREFIX + id);

    // "Nothing saved" and "saved but unreadable" are different outcomes. Only
    // the second is a recovery the user needs to be told about; treating them
    // alike would silently discard a layout with no explanation.
    if (stored.status === 'absent') {
      return { workspace: createDefaultWorkspace({ id }), recovered: false };
    }

    if (stored.status === 'unreadable') {
      return {
        workspace: createDefaultWorkspace({ id }),
        recovered: true,
        reason: `saved layout "${id}" could not be read (${stored.reason})`,
      };
    }

    const raw = stored.value;

    // Migrate first, then validate: an old document is expected, not corrupt.
    const migrated = migrateWorkspace(raw);
    if (migrated === null) {
      return {
        workspace: createDefaultWorkspace({ id }),
        recovered: true,
        reason: `saved layout "${id}" could not be migrated from its stored version`,
      };
    }

    const parsed = workspaceSchema.safeParse(migrated);
    if (!parsed.success) {
      return {
        workspace: createDefaultWorkspace({ id }),
        recovered: true,
        reason: `saved layout "${id}" was invalid: ${parsed.error.issues
          .slice(0, 3)
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; ')}`,
      };
    }

    return { workspace: parsed.data, recovered: false };
  }

  async save(workspace: Workspace): Promise<void> {
    if (!this.storage) return;
    const document: Workspace = {
      ...workspace,
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      updatedAt: Date.now(),
    };
    try {
      this.storage.setItem(KEY_PREFIX + document.id, JSON.stringify(document));
      const index = await this.list();
      const next = index.filter((entry) => entry.id !== document.id);
      next.push({ id: document.id, name: document.name, updatedAt: document.updatedAt });
      this.storage.setItem(INDEX_KEY, JSON.stringify(next));
    } catch {
      // Quota exceeded or storage blocked. Layout persistence is a convenience;
      // losing it must not interrupt trading.
    }
  }

  async remove(id: string): Promise<void> {
    if (!this.storage) return;
    try {
      this.storage.removeItem(KEY_PREFIX + id);
      const index = (await this.list()).filter((entry) => entry.id !== id);
      this.storage.setItem(INDEX_KEY, JSON.stringify(index));
    } catch {
      /* see save() */
    }
  }

  async getActiveId(): Promise<string | null> {
    try {
      return this.storage?.getItem(ACTIVE_KEY) ?? null;
    } catch {
      return null;
    }
  }

  async setActiveId(id: string): Promise<void> {
    try {
      this.storage?.setItem(ACTIVE_KEY, id);
    } catch {
      /* see save() */
    }
  }

  private readJson<T>(key: string): ReadResult<T> {
    if (!this.storage) return { status: 'absent' };
    try {
      const raw = this.storage.getItem(key);
      if (raw === null) return { status: 'absent' };
      return { status: 'ok', value: JSON.parse(raw) as T };
    } catch (error) {
      return {
        status: 'unreadable',
        reason: error instanceof Error ? error.message : 'storage unavailable',
      };
    }
  }
}
