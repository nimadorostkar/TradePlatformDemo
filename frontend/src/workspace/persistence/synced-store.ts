import { z } from 'zod';
import { WORKSPACE_SCHEMA_VERSION, workspaceSchema, type Workspace } from './schema';
import { migrateWorkspace } from './migrations';
import type { WorkspaceLoadResult, WorkspaceStore, WorkspaceSummary } from './storage';

/**
 * Workspace persistence mirrored to the gateway.
 *
 * Decorates a local store rather than replacing it. Every read is served from
 * local storage so the terminal opens at local-storage speed and keeps working
 * with no network; the server copy is what makes a layout follow the trader to
 * another browser or machine.
 *
 * Two rules make this safe:
 *
 *   1. NOTHING IS PUSHED UNTIL A PULL HAS SUCCEEDED. A browser that has never
 *      seen the account starts on the default layout. If it pushed that before
 *      learning what the server held, it would destroy the real layout — the
 *      user opens the terminal somewhere new and their workspace is gone. A
 *      failed or not-yet-attempted pull therefore suppresses every push.
 *
 *   2. Conflicts resolve last-writer-wins on `updatedAt`. Two tabs editing one
 *      layout is a genuine race, but the loser is a panel arrangement, not an
 *      order — merging carries more risk of an incoherent layout than the
 *      occasional lost resize does.
 */

export interface RemoteWorkspaceGateway {
  getWorkspace(login: string, signal?: AbortSignal): Promise<unknown | null>;
  saveWorkspace(login: string, document: unknown, signal?: AbortSignal): Promise<void>;
}

/** The bundle stored server-side: every layout plus which one is active. */
const remoteBundleSchema = z.object({
  bundleVersion: z.literal(1),
  updatedAt: z.number(),
  activeId: z.string().nullable(),
  // Validated per entry below, not here — one bad layout must not discard the
  // rest of the bundle.
  workspaces: z.array(z.unknown()),
  // Trading-journal entries ride in the same bundle (MED-07): the gateway's
  // workspace document is deliberately opaque, so no new endpoint is needed
  // for notes to follow the account. Optional — bundles from older builds
  // simply have none. Validated per entry by the journal store's own merge.
  journal: z.array(z.unknown()).optional(),
});

type RemoteBundle = z.infer<typeof remoteBundleSchema>;

export interface SyncedWorkspaceStoreOptions {
  local: WorkspaceStore;
  remote: RemoteWorkspaceGateway;
  /** Null when no account is active; sync is then inert. */
  getLogin: () => string | null;
  /** True only when the gateway reports it stores workspaces. */
  isEnabled: () => boolean;
  /** Surfaces sync problems without interrupting trading. */
  onError?: (error: unknown) => void;
  pushDebounceMs?: number;
  /** Journal bridge (MED-07): entries to include in each pushed bundle. */
  readJournal?: () => unknown[];
  /** Journal bridge (MED-07): merges a pulled bundle's entries locally. */
  applyJournal?: (entries: unknown[]) => void;
}

const DEFAULT_PUSH_DEBOUNCE_MS = 2_000;

export class SyncedWorkspaceStore implements WorkspaceStore {
  private readonly options: Required<Omit<SyncedWorkspaceStoreOptions, 'onError'>> & {
    onError: (error: unknown) => void;
  };

  /** The login whose bundle was last pulled successfully. Gates every push. */
  private pulledFor: string | null = null;
  private pushTimer: ReturnType<typeof setTimeout> | null = null;
  private pushInFlight: Promise<void> | null = null;
  /**
   * Content signature of the last bundle actually sent, per login.
   *
   * Debouncing alone only coalesces a BURST. It does nothing about the steady
   * trickle of saves that carry no new information — a panel switch that
   * restores a layout to what it already was, a resize that lands back on the
   * same size, a re-pull that schedules a push of what the server just sent us.
   * Each of those still became a database write on the gateway.
   */
  private lastPushedSignature: string | null = null;

  constructor(options: SyncedWorkspaceStoreOptions) {
    this.options = {
      pushDebounceMs: DEFAULT_PUSH_DEBOUNCE_MS,
      onError: () => {},
      readJournal: () => [],
      applyJournal: () => {},
      ...options,
    };
  }

  // ── Reads: local only ──────────────────────────────────────────────────────

  list(): Promise<WorkspaceSummary[]> {
    return this.options.local.list();
  }

  load(id: string): Promise<WorkspaceLoadResult> {
    return this.options.local.load(id);
  }

  getActiveId(): Promise<string | null> {
    return this.options.local.getActiveId();
  }

  /**
   * Schedules a push for a change OUTSIDE the workspace documents — today,
   * a journal edit (MED-07). Same debounce, same pull-before-push gate.
   */
  notifyExternalChange(): void {
    this.schedulePush();
  }

  // ── Writes: local first, then mirrored ─────────────────────────────────────

  async save(workspace: Workspace): Promise<void> {
    await this.options.local.save(workspace);
    this.schedulePush();
  }

  async remove(id: string): Promise<void> {
    await this.options.local.remove(id);
    this.schedulePush();
  }

  async setActiveId(id: string): Promise<void> {
    await this.options.local.setActiveId(id);
    this.schedulePush();
  }

  /**
   * Pulls the server bundle into local storage.
   *
   * Returns true when local storage changed, so the caller knows to re-read.
   * Never throws: a terminal that will not open because a layout could not be
   * fetched is a worse outcome than a stale layout.
   */
  async pull(signal?: AbortSignal): Promise<boolean> {
    const login = this.options.getLogin();
    if (!login || !this.options.isEnabled()) return false;

    let raw: unknown;
    try {
      raw = await this.options.remote.getWorkspace(login, signal);
    } catch (error) {
      this.options.onError(error);
      return false;
    }

    // A successful fetch that found nothing still counts as knowing the server
    // state — this account simply has no saved bundle yet, so pushing the local
    // one is correct rather than destructive.
    if (raw === null || raw === undefined) {
      this.pulledFor = login;
      this.schedulePush();
      return false;
    }

    const parsed = remoteBundleSchema.safeParse(raw);
    if (!parsed.success) {
      // Unreadable is NOT the same as absent: something is stored and we cannot
      // interpret it, so overwriting it would destroy data we never understood.
      this.options.onError(
        new Error('The stored workspace could not be read, so it was left untouched.'),
      );
      return false;
    }

    const bundle = parsed.data;
    // Journal before the freshness gate: that gate compares LAYOUT stamps,
    // and notes must not be hostage to whether any layout was newer — the
    // id-keyed merge is order-safe on its own.
    if (bundle.journal) {
      try {
        this.options.applyJournal(bundle.journal);
      } catch {
        // A malformed journal must not block layout restoration.
      }
    }
    if (!(await this.remoteIsNewer(bundle))) {
      this.pulledFor = login;
      this.schedulePush();
      return false;
    }

    const applied = await this.applyBundle(bundle);
    this.pulledFor = login;
    return applied;
  }

  /** Drops sync state so a new account cannot push under the previous one. */
  reset(): void {
    this.pulledFor = null;
    // The signature describes the PREVIOUS account's bundle. Carrying it over
    // could make the next account's first push look like a no-op and be
    // skipped, leaving the server holding someone else's layout.
    this.lastPushedSignature = null;
    if (this.pushTimer !== null) {
      clearTimeout(this.pushTimer);
      this.pushTimer = null;
    }
  }

  /** Writes any debounced push immediately, for tab close. */
  async flush(): Promise<void> {
    if (this.pushTimer !== null) {
      clearTimeout(this.pushTimer);
      this.pushTimer = null;
    }
    await this.push();
    await this.pushInFlight;
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private async remoteIsNewer(bundle: RemoteBundle): Promise<boolean> {
    const local = await this.options.local.list();
    // No local layouts at all means nothing to lose by taking the server's.
    if (local.length === 0) return true;
    const newestLocal = Math.max(...local.map((entry) => entry.updatedAt || 0));
    return bundle.updatedAt > newestLocal;
  }

  private async applyBundle(bundle: RemoteBundle): Promise<boolean> {
    let wrote = false;
    for (const candidate of bundle.workspaces) {
      // Remote documents get the same migrate-then-validate treatment as local
      // ones. They came from an older app version just as easily.
      const migrated = migrateWorkspace(candidate);
      if (migrated === null) continue;
      const parsed = workspaceSchema.safeParse(migrated);
      if (!parsed.success) continue;
      await this.options.local.save(parsed.data);
      wrote = true;
    }
    if (wrote && bundle.activeId) {
      await this.options.local.setActiveId(bundle.activeId);
    }
    return wrote;
  }

  private schedulePush(): void {
    if (this.pulledFor === null) return;
    if (this.pushTimer !== null) clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null;
      void this.push();
    }, this.options.pushDebounceMs);
  }

  private async push(): Promise<void> {
    const login = this.options.getLogin();
    // The login must still match the one we pulled for. An account switch
    // between the edit and the debounced push would otherwise file one
    // account's layouts under another's.
    if (!login || login !== this.pulledFor || !this.options.isEnabled()) return;
    if (this.pushInFlight) return;

    this.pushInFlight = (async () => {
      try {
        const summaries = await this.options.local.list();
        const workspaces: Workspace[] = [];
        for (const summary of summaries) {
          const result = await this.options.local.load(summary.id);
          // A recovered result is the DEFAULT layout standing in for one that
          // could not be read. Uploading it would replace a good server copy
          // with a blank one.
          if (result.recovered) continue;
          workspaces.push(result.workspace);
        }
        if (workspaces.length === 0) return;

        const activeId = await this.options.local.getActiveId();
        const journal = this.options.readJournal?.() ?? [];
        const signature = bundleSignature(activeId, workspaces, journal);
        // Nothing the server does not already have. Skipping here is what turns
        // "a write per interaction" into "a write per actual change".
        if (signature === this.lastPushedSignature) return;

        const bundle: RemoteBundle = {
          bundleVersion: 1,
          updatedAt: Date.now(),
          activeId,
          workspaces,
          ...(journal.length > 0 ? { journal } : {}),
        };
        await this.options.remote.saveWorkspace(login, bundle);
        // Only after the write is acknowledged. Recording it earlier would let
        // a failed push suppress the retry that should replace it.
        this.lastPushedSignature = signature;
      } catch (error) {
        this.options.onError(error);
      } finally {
        this.pushInFlight = null;
      }
    })();

    await this.pushInFlight;
  }
}

/**
 * A stable content fingerprint for a bundle.
 *
 * `updatedAt` is excluded at both levels: the local store restamps every
 * workspace on save and the bundle takes `Date.now()`, so including either
 * would make every bundle unique and defeat the comparison entirely. Key order
 * is normalised because JSON.stringify preserves insertion order, and a
 * workspace rebuilt by a different code path can carry the same data with its
 * keys in a different sequence.
 */
function bundleSignature(
  activeId: string | null,
  workspaces: readonly Workspace[],
  journal: readonly unknown[] = [],
): string {
  const normalised = workspaces
    .map(({ updatedAt: _updatedAt, ...rest }) => stableStringify(rest))
    .sort();
  return JSON.stringify({ activeId, workspaces: normalised, journal: stableStringify(journal) });
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(',')}}`;
}

export { WORKSPACE_SCHEMA_VERSION };
