import { forwardRef, type FormEvent, type ReactNode, type SelectHTMLAttributes } from 'react';
import { AlertCircle, CheckCircle2 } from 'lucide-react';
import { cn } from '@/components/ui/cn';
import type { ClientAccount } from '../api';
import { accountLabel } from './format';

/** Page-level building blocks shared by the client-area pages. */

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 max-w-2xl text-sm text-text-secondary">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Card({
  children,
  className,
  as: Tag = 'section',
  onSubmit,
}: {
  children: ReactNode;
  className?: string;
  as?: 'section' | 'div' | 'article' | 'form';
  /** For `as="form"`: the submit handler (it is what keeps the page from reloading). */
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const classes = cn(
    'rounded-lg border border-[var(--border-default)] bg-[var(--background-secondary)]',
    className,
  );
  if (Tag === 'form') {
    return (
      <form onSubmit={onSubmit} className={classes}>
        {children}
      </form>
    );
  }
  return (
    <Tag
      className={cn(
        'rounded-lg border border-[var(--border-default)] bg-[var(--background-secondary)]',
        className,
      )}
    >
      {children}
    </Tag>
  );
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return <h2 className="mb-3 text-lg font-semibold">{children}</h2>;
}

export function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: 'positive' | 'negative' | 'muted';
}) {
  return (
    <div>
      <div className="text-xs text-text-secondary">{label}</div>
      <div
        className={cn(
          'mt-0.5 text-2xl font-semibold tabular-nums',
          tone === 'positive' && 'text-[var(--positive)]',
          tone === 'negative' && 'text-[var(--negative)]',
          tone === 'muted' && 'text-text-muted',
        )}
      >
        {value}
      </div>
      {hint && <div className="mt-0.5 text-xs text-text-muted">{hint}</div>}
    </div>
  );
}

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, children, ...props }, ref) => (
    <select
      ref={ref}
      className={cn(
        'h-9 w-full rounded border border-[var(--border-default)] bg-[var(--background-tertiary)] px-2 text-sm text-text-primary',
        'focus-visible:border-[var(--focus-ring)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--focus-ring)] disabled:opacity-50',
        className,
      )}
      {...props}
    >
      {children}
    </select>
  ),
);
Select.displayName = 'Select';

export function AccountSelect({
  id,
  accounts,
  value,
  onChange,
  exclude,
  emptyLabel = 'No accounts',
}: {
  id: string;
  accounts: readonly ClientAccount[];
  value: string;
  onChange: (login: string) => void;
  exclude?: string;
  emptyLabel?: string;
}) {
  const options = accounts.filter((a) => a.login !== exclude);
  return (
    <Select id={id} value={value} onChange={(event) => onChange(event.target.value)}>
      {options.length === 0 && <option value="">{emptyLabel}</option>}
      {options.map((a) => (
        <option key={a.login} value={a.login}>
          {accountLabel(a)}
          {a.kind === 'demo' ? ' (demo)' : ''}
        </option>
      ))}
    </Select>
  );
}

export function KindBadge({ kind }: { kind: 'real' | 'demo' }) {
  return (
    <span
      className={cn(
        'rounded px-1.5 py-0.5 text-2xs font-semibold uppercase tracking-wide',
        kind === 'demo'
          ? 'bg-[rgba(var(--info-rgb),0.15)] text-[var(--info)]'
          : 'bg-[rgba(var(--positive-rgb),0.15)] text-[var(--positive)]',
      )}
    >
      {kind}
    </span>
  );
}

export function Chip({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        'rounded bg-[var(--surface-raised)] px-2 py-0.5 text-xs font-medium text-text-secondary',
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Notice({
  tone,
  children,
  className,
}: {
  tone: 'error' | 'success' | 'info';
  children: ReactNode;
  className?: string;
}) {
  const Icon = tone === 'success' ? CheckCircle2 : AlertCircle;
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={cn(
        'flex items-start gap-2 rounded border px-3 py-2 text-sm',
        tone === 'error' &&
          'border-[rgba(var(--negative-rgb),0.4)] bg-[var(--negative-wash)] text-[var(--negative)]',
        tone === 'success' &&
          'border-[rgba(var(--positive-rgb),0.4)] bg-[var(--positive-wash)] text-[var(--positive)]',
        tone === 'info' &&
          'border-[rgba(var(--info-rgb),0.4)] bg-[rgba(var(--info-rgb),0.08)] text-text-primary',
        className,
      )}
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <div className="flex-1">{children}</div>
    </div>
  );
}

/** Definition-list row used inside cards: label left, value right, dotted leader. */
export function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline gap-2 text-sm">
      <span className="text-text-secondary">{label}</span>
      <span className="flex-1 border-b border-dotted border-[var(--border-default)]" aria-hidden />
      <span className="font-medium tabular-nums">{value}</span>
    </div>
  );
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
}: {
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: string }[];
  label: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="inline-flex rounded border border-[var(--border-default)] p-0.5"
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
          className={cn(
            'rounded px-3 py-1.5 text-sm transition-colors',
            option.value === value
              ? 'bg-[var(--surface-raised)] font-medium text-text-primary'
              : 'text-text-secondary hover:text-text-primary',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
