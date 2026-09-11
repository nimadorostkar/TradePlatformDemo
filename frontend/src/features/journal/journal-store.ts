import { create } from 'zustand';
import { z } from 'zod';

/**
 * Trading journal.
 *
 * Persisted locally for speed AND mirrored to the server inside the workspace
 * bundle (MED-07): clearing the browser or moving to another machine no longer
 * loses a trader's notes. The local copy remains authoritative for reads; the
 * bundle merge below reconciles by entry id with the newer `updatedAt`
 * winning, so two devices editing different notes both keep their work.
 *
 * Entries are stored and rendered as PLAIN TEXT. Nothing here is ever passed to
 * `dangerouslySetInnerHTML`, so a note cannot inject markup into the terminal.
 */

export const journalEntrySchema = z.object({
  id: z.string().min(1),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  /** Display symbol, or null for a general note. */
  symbol: z.string().max(40).nullable(),
  /** Free text, length-capped so one entry cannot exhaust the storage quota. */
  body: z.string().max(4000),
  mood: z.enum(['neutral', 'good', 'bad']).default('neutral'),
  tags: z.array(z.string().min(1).max(24)).max(8).default([]),
});

export type JournalEntry = z.infer<typeof journalEntrySchema>;

const journalDocumentSchema = z.object({
  version: z.literal(1),
  entries: z.array(journalEntrySchema).max(2000),
});

const STORAGE_KEY = 'tradeplatform.journal.v1';

function load(storage: Storage | null): JournalEntry[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = journalDocumentSchema.safeParse(JSON.parse(raw));
    // A corrupt journal must not stop the terminal from opening; the entries
    // are lost, but nothing else is.
    return parsed.success ? parsed.data.entries : [];
  } catch {
    return [];
  }
}

function persist(storage: Storage | null, entries: JournalEntry[]): void {
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, entries }));
  } catch {
    // Quota exhausted or storage blocked. Notes are a convenience; losing a
    // write must not interrupt trading.
  }
}

interface JournalState {
  entries: JournalEntry[];
  hydrated: boolean;
  hydrate: (storage?: Storage) => void;
  add: (entry: Pick<JournalEntry, 'symbol' | 'body' | 'mood' | 'tags'>) => void;
  update: (id: string, patch: Partial<Pick<JournalEntry, 'body' | 'mood' | 'tags'>>) => void;
  remove: (id: string) => void;
}

let storageRef: Storage | null = typeof localStorage === 'undefined' ? null : localStorage;

export function __setJournalStorageForTests(storage: Storage | null): void {
  storageRef = storage;
}

// ── server-sync bridge (MED-07) ─────────────────────────────────────────────
// The synced workspace store calls readJournalEntries when it builds a bundle
// and mergeRemoteJournal when one arrives; every local mutation pokes
// journalSyncHook so a note schedules a push exactly like a layout change.

let journalSyncHook: (() => void) | null = null;

export function setJournalSyncHook(hook: (() => void) | null): void {
  journalSyncHook = hook;
}

export function readJournalEntries(): JournalEntry[] {
  return useJournal.getState().hydrated ? useJournal.getState().entries : load(storageRef);
}

/**
 * Merges the server's copy into this browser. Per-entry, id-keyed, newer
 * `updatedAt` wins — a blunt replace would let a stale device erase notes
 * written elsewhere. Unknown/invalid entries are dropped, never fatal.
 */
export function mergeRemoteJournal(remote: unknown[]): void {
  const incoming = remote
    .map((candidate) => journalEntrySchema.safeParse(candidate))
    .filter((r): r is { success: true; data: JournalEntry } => r.success)
    .map((r) => r.data);
  if (incoming.length === 0) return;

  const byId = new Map<string, JournalEntry>();
  for (const entry of readJournalEntries()) byId.set(entry.id, entry);
  for (const entry of incoming) {
    const existing = byId.get(entry.id);
    if (!existing || entry.updatedAt > existing.updatedAt) byId.set(entry.id, entry);
  }
  const entries = [...byId.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 2000);
  persist(storageRef, entries);
  if (useJournal.getState().hydrated) useJournal.setState({ entries });
}

export const useJournal = create<JournalState>()((set, get) => ({
  entries: [],
  hydrated: false,

  hydrate: (storage) => {
    if (storage) storageRef = storage;
    set({ entries: load(storageRef), hydrated: true });
  },

  add: (entry) => {
    const now = Date.now();
    const next: JournalEntry = {
      ...entry,
      body: entry.body.slice(0, 4000),
      id: `j${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      createdAt: now,
      updatedAt: now,
    };
    const entries = [next, ...get().entries].slice(0, 2000);
    persist(storageRef, entries);
    set({ entries });
    journalSyncHook?.();
  },

  update: (id, patch) => {
    const entries = get().entries.map((entry) =>
      entry.id === id
        ? {
            ...entry,
            ...patch,
            body: (patch.body ?? entry.body).slice(0, 4000),
            updatedAt: Date.now(),
          }
        : entry,
    );
    persist(storageRef, entries);
    set({ entries });
    journalSyncHook?.();
  },

  remove: (id) => {
    const entries = get().entries.filter((entry) => entry.id !== id);
    persist(storageRef, entries);
    set({ entries });
    journalSyncHook?.();
  },
}));
