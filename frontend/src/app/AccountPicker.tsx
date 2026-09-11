import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Search } from 'lucide-react';
import { cn } from '@/components/ui/cn';
import { Badge } from '@/components/ui/primitives';
import type { AccountOption } from '@/integrations/gateway/mappers/to-domain';
import { FUNDS_LABEL, FUNDS_TONE, hasBadge } from '@/domain/account/account-environment';

/**
 * Choosing a trading account.
 *
 * This was a bare `<select>`. A test login holds seventeen accounts, rendered
 * as a flat list of "ECN Pro 600140221" rows in whatever order the CRM
 * returned them, with no search and no grouping — a long scroll to reach
 * anything past the first few, and nothing to recognise an account BY except
 * its number.
 *
 * So: type to filter, arrows and Enter to choose, and the list grouped by
 * account type with the read-only ones marked. Modelled on the command
 * palette, which already solves the same problem for panels and layouts.
 */

export function AccountPicker({
  options,
  activeLogin,
  disabled,
  onSelect,
}: {
  options: readonly AccountOption[];
  activeLogin: string | null;
  disabled: boolean;
  onSelect: (login: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const active = options.find((option) => option.login === activeLogin) ?? null;

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle === '') return options;
    return options.filter(
      (option) =>
        option.login.includes(needle) ||
        option.name.toLowerCase().includes(needle) ||
        option.currency?.toLowerCase().includes(needle) ||
        option.server?.toLowerCase().includes(needle),
    );
  }, [options, query]);

  // Grouped for display, but kept as one flat list for the keyboard: arrow
  // keys must walk the rows a trader can see, not the groups around them.
  const groups = useMemo(() => {
    const byType = new Map<string, AccountOption[]>();
    for (const option of filtered) {
      const label = typeLabelOf(option);
      const bucket = byType.get(label);
      if (bucket) bucket.push(option);
      else byType.set(label, [option]);
    }
    return [...byType.entries()];
  }, [filtered]);

  const flat = useMemo(() => groups.flatMap(([, items]) => items), [groups]);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    // Open on the account already in use, so Enter is a no-op rather than a
    // surprise switch.
    const current = flat.findIndex((option) => option.login === activeLogin);
    setSelectedIndex(current >= 0 ? current : 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, open]);

  useEffect(() => {
    const highlighted = listRef.current?.querySelector('[data-active="true"]');
    // Guarded: scrollIntoView is absent in jsdom, and keeping the highlight
    // visible is a convenience, never a requirement for choosing an account.
    highlighted?.scrollIntoView?.({ block: 'nearest' });
  }, [selectedIndex, open]);

  const choose = (option: AccountOption | undefined) => {
    if (!option) return;
    setOpen(false);
    buttonRef.current?.focus();
    if (option.login !== activeLogin) onSelect(option.login);
  };

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
        aria-label="Select trading account"
        aria-haspopup="dialog"
        aria-expanded={open}
        className="flex h-6 max-w-44 items-center gap-1 rounded border border-[var(--border-default)] bg-[var(--background-tertiary)] px-1.5 text-2xs text-text-primary disabled:opacity-60 max-lg:min-w-0 max-lg:max-w-32"
      >
        <span className="truncate">{active?.name ?? activeLogin ?? 'No accounts'}</span>
        <ChevronDown className="h-2.5 w-2.5 shrink-0 text-text-muted" aria-hidden />
      </button>

      {open && (
        <>
          {/* Click-away, behind the panel and in front of everything else. */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} aria-hidden />

          {/* Below lg the header is a horizontal scroll container (BLK-02),
              and overflow-x:auto forces overflow-y:auto with it — an
              absolutely-positioned panel gets CLIPPED to the 44px header strip
              and looks like it opened "under" the chart. position:fixed is not
              clipped by overflow ancestors, so on the phone the panel pins
              just below the header at full width instead. */}
          <div
            role="dialog"
            aria-label="Trading accounts"
            className="absolute left-0 top-7 z-50 w-72 overflow-hidden rounded-lg border border-[var(--border-strong)] bg-[var(--surface-overlay)] shadow-[var(--shadow-panel)] max-lg:fixed max-lg:inset-x-2 max-lg:top-12 max-lg:w-auto"
          >
            {/* Always present, even for a short list: it is what holds the
                keyboard focus and drives arrow-key navigation, so hiding it
                below some threshold would leave the panel with nothing
                focusable in it at all — worse than the select it replaced. */}
            <div className="flex items-center gap-1.5 border-b border-[var(--border-default)] px-2">
              <Search className="h-3 w-3 shrink-0 text-text-muted" aria-hidden />
              <input
                ref={inputRef}
                role="combobox"
                aria-expanded="true"
                aria-controls="account-list"
                aria-activedescendant={flat[selectedIndex]?.login}
                aria-label="Search accounts"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    setOpen(false);
                    buttonRef.current?.focus();
                  }
                  if (event.key === 'ArrowDown') {
                    event.preventDefault();
                    setSelectedIndex((index) => Math.min(index + 1, flat.length - 1));
                  }
                  if (event.key === 'ArrowUp') {
                    event.preventDefault();
                    setSelectedIndex((index) => Math.max(index - 1, 0));
                  }
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    choose(flat[selectedIndex]);
                  }
                }}
                placeholder="Search by number, type or currency…"
                className="h-9 w-full bg-transparent text-2xs text-text-primary outline-none placeholder:text-text-muted"
              />
            </div>

            <ul id="account-list" ref={listRef} role="listbox" className="max-h-80 overflow-y-auto">
              {flat.length === 0 ? (
                <li className="px-2 py-2 text-2xs text-text-muted">No matching accounts</li>
              ) : (
                groups.map(([label, items]) => (
                  <li key={label} role="group" aria-label={label}>
                    <p className="sticky top-0 bg-[var(--background-tertiary)] px-2 py-1 text-2xs font-medium uppercase tracking-wide text-text-muted">
                      {label}
                    </p>
                    <ul>
                      {items.map((option) => {
                        const index = flat.indexOf(option);
                        const isActive = index === selectedIndex;
                        return (
                          <li
                            key={option.login}
                            id={option.login}
                            role="option"
                            aria-selected={option.login === activeLogin}
                            data-active={isActive}
                            onMouseEnter={() => setSelectedIndex(index)}
                            onClick={() => choose(option)}
                            className={cn(
                              'flex cursor-pointer items-center gap-2 px-2 py-1.5 text-2xs',
                              isActive && 'bg-[var(--surface-raised)]',
                              option.login === activeLogin && 'font-medium',
                            )}
                          >
                            <span className="tabular">{option.login}</span>
                            {option.currency && (
                              <span className="text-text-muted">{option.currency}</span>
                            )}
                            {/* Only when the SERVER stated it. An account of
                                unknown kind carries no badge rather than a
                                guess — see account-environment.ts. */}
                            {hasBadge(option.kind) && (
                              <Badge tone={FUNDS_TONE[option.kind as 'live' | 'demo']}>
                                {FUNDS_LABEL[option.kind as 'live' | 'demo']}
                              </Badge>
                            )}
                            {option.readOnly && (
                              <Badge tone="neutral" className="ml-auto">
                                Read-only
                              </Badge>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </li>
                ))
              )}
            </ul>
          </div>
        </>
      )}
    </div>
  );
}

/** The account's type — "ECN Pro 600140221" carries it as everything but the number. */
function typeLabelOf(option: AccountOption): string {
  const withoutLogin = option.name.replace(option.login, '').trim();
  return withoutLogin === '' ? 'Accounts' : withoutLogin;
}
