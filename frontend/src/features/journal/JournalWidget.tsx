import { useEffect, useMemo, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { cn } from '@/components/ui/cn';
import { Badge, Button, EmptyState } from '@/components/ui/primitives';
import { useWorkspace } from '@/workspace/layout/workspace-store';
import { useJournal, type JournalEntry } from './journal-store';
import { useCapabilities } from '@/stores/capabilities-store';

/**
 * Trading journal.
 *
 * Entries are stored in THIS BROWSER only — the gateway has no journal
 * endpoint. The panel says so rather than letting a trader assume their notes
 * are synced or backed up.
 *
 * Everything is rendered as text. No entry is ever interpreted as markup.
 */

const MOODS: readonly { value: JournalEntry['mood']; label: string }[] = [
  { value: 'good', label: 'Went well' },
  { value: 'neutral', label: 'Neutral' },
  { value: 'bad', label: 'Went badly' },
];

export default function JournalWidget() {
  const activeSymbol = useWorkspace((s) => s.workspace.activeSymbol);
  const workspaceSynced = useCapabilities((s) => s.capabilities.workspace.enabled);
  const entries = useJournal((s) => s.entries);
  const hydrated = useJournal((s) => s.hydrated);
  const hydrate = useJournal((s) => s.hydrate);
  const add = useJournal((s) => s.add);
  const remove = useJournal((s) => s.remove);

  const [body, setBody] = useState('');
  const [mood, setMood] = useState<JournalEntry['mood']>('neutral');
  const [attachSymbol, setAttachSymbol] = useState(true);
  const [filterSymbol, setFilterSymbol] = useState(false);

  useEffect(() => {
    if (!hydrated) hydrate();
  }, [hydrated, hydrate]);

  const visible = useMemo(
    () => (filterSymbol ? entries.filter((entry) => entry.symbol === activeSymbol) : entries),
    [entries, filterSymbol, activeSymbol],
  );

  const submit = () => {
    const text = body.trim();
    if (text === '') return;
    add({ symbol: attachSymbol ? activeSymbol : null, body: text, mood, tags: [] });
    setBody('');
    setMood('neutral');
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 space-y-1.5 border-b border-[var(--border-default)] p-2">
        <textarea
          aria-label="Journal entry"
          value={body}
          onChange={(event) => setBody(event.target.value)}
          onKeyDown={(event) => {
            // Enter inserts a newline; the shortcut needs a modifier so a
            // multi-line note is not submitted halfway through.
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              submit();
            }
          }}
          rows={3}
          maxLength={4000}
          placeholder={`What happened on ${activeSymbol}? (⌘/Ctrl + Enter to save)`}
          className="w-full resize-y rounded border border-[var(--border-default)] bg-[var(--background-tertiary)] p-1.5 text-2xs text-text-primary placeholder:text-text-muted focus-visible:border-[var(--focus-ring)] focus-visible:outline-none"
        />

        <div className="flex flex-wrap items-center gap-1.5 text-2xs">
          <div role="group" aria-label="Outcome" className="flex gap-1">
            {MOODS.map((option) => (
              <button
                key={option.value}
                aria-pressed={mood === option.value}
                onClick={() => setMood(option.value)}
                className={cn(
                  // 24px floor: these were 21.1px tall (retest 2026-08-26).
                  'hit-target justify-center rounded border px-1.5 py-0.5',
                  mood === option.value
                    ? 'border-[var(--brand-primary)] bg-brand-primary/12 text-text-primary'
                    : 'border-[var(--border-default)] text-text-muted hover:text-text-secondary',
                )}
              >
                {option.label}
              </button>
            ))}
          </div>

          <label className="hit-target cursor-pointer gap-1 text-text-secondary">
            <input
              type="checkbox"
              checked={attachSymbol}
              onChange={(event) => setAttachSymbol(event.target.checked)}
            />
            Tag {activeSymbol}
          </label>

          <Button
            size="xs"
            variant="primary"
            className="ml-auto"
            disabled={body.trim() === ''}
            onClick={submit}
          >
            Save note
          </Button>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border-default)] px-2 py-1 text-2xs">
        <label className="hit-target cursor-pointer gap-1 text-text-secondary">
          <input
            type="checkbox"
            checked={filterSymbol}
            onChange={(event) => setFilterSymbol(event.target.checked)}
          />
          Only {activeSymbol}
        </label>
        <span className="ml-auto text-text-muted">
          {/* Truthful either way (MED-07): synced when the gateway stores
              workspaces, and loudly browser-only when it does not. */}
          {visible.length} note{visible.length === 1 ? '' : 's'} ·{' '}
          {workspaceSynced ? 'synced to your account' : 'stored in this browser ONLY'}
        </span>
      </div>

      {visible.length === 0 ? (
        <EmptyState
          title="No notes yet"
          // Must agree with the header's sync label directly above it: this
          // exact string once claimed browser-only storage while the header
          // said "synced to your account" (MED-07 retest).
          description={
            workspaceSynced
              ? 'Write a note about a trade — it follows your account to any device.'
              : 'Notes are saved in this browser only — this gateway does not store them.'
          }
        />
      ) : (
        <ul className="widget-scroll min-h-0 flex-1 divide-y divide-[var(--border-default)]">
          {visible.map((entry) => (
            <li key={entry.id} className="group flex gap-2 px-2 py-1.5 text-2xs">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="tabular text-text-muted">
                    {new Date(entry.createdAt).toLocaleString()}
                  </span>
                  {entry.symbol ? <Badge>{entry.symbol}</Badge> : null}
                  {entry.mood !== 'neutral' ? (
                    <Badge tone={entry.mood === 'good' ? 'positive' : 'negative'}>
                      {entry.mood === 'good' ? 'Went well' : 'Went badly'}
                    </Badge>
                  ) : null}
                </div>
                {/* Rendered as text, never as markup. */}
                <p className="mt-0.5 whitespace-pre-wrap break-words text-text-secondary">
                  {entry.body}
                </p>
              </div>
              <button
                aria-label="Delete note"
                onClick={() => remove(entry.id)}
                className="hit-target shrink-0 justify-center rounded text-text-muted opacity-0 hover:text-[var(--negative)] focus-visible:opacity-100 group-hover:opacity-100"
              >
                <Trash2 className="h-2.5 w-2.5" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
