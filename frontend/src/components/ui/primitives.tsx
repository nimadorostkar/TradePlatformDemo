import {
  forwardRef,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { cn } from './cn';

/**
 * Base UI primitives. Compact by default — a trading terminal shows far more
 * per screen than a typical web app, so paddings and heights are deliberately
 * tighter than a general-purpose component library's.
 */

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 rounded font-medium transition-colors disabled:pointer-events-none disabled:opacity-45 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--focus-ring)]',
  {
    variants: {
      variant: {
        primary:
          'bg-[var(--brand-primary)] text-[var(--brand-primary-contrast)] hover:brightness-110',
        secondary:
          'bg-[var(--surface-raised)] text-text-primary hover:bg-[var(--surface-overlay)] border border-[var(--border-default)]',
        ghost: 'text-text-secondary hover:bg-[var(--surface-raised)] hover:text-text-primary',
        buy: 'bg-[var(--positive)] text-white hover:brightness-110',
        sell: 'bg-[var(--negative)] text-white hover:brightness-110',
        danger:
          'border border-[var(--negative)] text-[var(--negative)] hover:bg-[var(--negative)] hover:text-white',
      },
      size: {
        xs: 'h-6 px-2 text-2xs',
        sm: 'h-7 px-2.5 text-xs',
        md: 'h-8 px-3 text-sm',
        lg: 'h-11 px-4 text-base',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'sm' },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, loading, children, disabled, ...props }, ref) => (
    <button
      ref={ref}
      className={cn(buttonVariants({ variant, size }), className)}
      disabled={disabled || loading}
      {...props}
    >
      {loading && <Loader2 className="h-3 w-3 animate-spin" aria-hidden />}
      {children}
    </button>
  ),
);
Button.displayName = 'Button';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        'h-7 w-full rounded border border-[var(--border-default)] bg-[var(--background-tertiary)] px-2 text-xs text-text-primary',
        // The same 2px ring the Button shows: a border-colour change alone is
        // the one focus indicator the report flagged as invisible (MED-12).
        'placeholder:text-text-muted focus-visible:border-[var(--focus-ring)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--focus-ring)]',
        'disabled:opacity-50 tabular',
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = 'Input';

/** A labelled field with inline validation text tied to the input via aria. */
export function Field({
  label,
  htmlFor,
  error,
  hint,
  children,
  className,
}: {
  label: string;
  htmlFor: string;
  error?: string | null;
  hint?: string | null;
  children: ReactNode;
  className?: string;
}) {
  const describedBy = error ? `${htmlFor}-error` : hint ? `${htmlFor}-hint` : undefined;
  return (
    <div className={cn('space-y-1', className)}>
      <label htmlFor={htmlFor} className="block text-2xs font-medium text-text-secondary">
        {label}
      </label>
      {children}
      {error ? (
        <p id={describedBy} role="alert" className="text-2xs text-[var(--negative)]">
          {error}
        </p>
      ) : hint ? (
        <p id={describedBy} className="text-2xs text-text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/** Consistent numeric cell: tabular figures + P/L colour that is never alone. */
export function Money({
  value,
  currency,
  digits = 2,
  colorBySign = false,
  className,
}: {
  value: string | null;
  currency?: string | null;
  digits?: number;
  colorBySign?: boolean;
  className?: string;
}) {
  if (value === null) return <Unavailable className={className} />;

  const numeric = Number(value);
  const sign = numeric > 0 ? 'positive' : numeric < 0 ? 'negative' : 'flat';
  const formatted = new Intl.NumberFormat(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(numeric);

  return (
    <span
      className={cn(
        'tabular',
        colorBySign && sign === 'positive' && 'text-[var(--positive)]',
        colorBySign && sign === 'negative' && 'text-[var(--negative)]',
        className,
      )}
    >
      {/* The explicit sign carries the meaning for anyone who cannot rely on
          colour alone, so P/L never depends on hue. */}
      {colorBySign && numeric > 0 ? '+' : ''}
      {formatted}
      {currency ? <span className="ml-1 text-text-muted">{currency}</span> : null}
    </span>
  );
}

/**
 * The honest empty value. Rendering `0` for a field the gateway never sent
 * would tell a trader their stop-loss is at zero.
 */
export function Unavailable({
  className,
  label = 'Unavailable',
}: {
  className?: string;
  label?: string;
}) {
  return (
    <span className={cn('text-text-muted', className)} title={label}>
      —
    </span>
  );
}

export function Badge({
  children,
  tone = 'neutral',
  className,
}: {
  children: ReactNode;
  tone?: 'neutral' | 'positive' | 'negative' | 'warning' | 'info';
  className?: string;
}) {
  const tones: Record<string, string> = {
    neutral: 'bg-[var(--surface-raised)] text-text-secondary',
    positive: 'bg-positive/15 text-[var(--positive)]',
    negative: 'bg-negative/15 text-[var(--negative)]',
    warning: 'bg-warning/15 text-[var(--warning)]',
    info: 'bg-info/15 text-[var(--info)]',
  };
  return (
    <span
      className={cn(
        'inline-flex items-center rounded px-1.5 py-0.5 text-2xs font-medium',
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function EmptyState({
  title,
  description,
  action,
  icon: Icon,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  icon?: React.ComponentType<{ className?: string }>;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
      {Icon ? <Icon className="h-6 w-6 text-text-muted" /> : null}
      <p className="text-sm text-text-secondary">{title}</p>
      {description ? <p className="max-w-xs text-xs text-text-muted">{description}</p> : null}
      {action}
    </div>
  );
}

export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex h-full items-center justify-center gap-2 p-6 text-text-muted">
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
      <span className="text-xs">{label}</span>
    </div>
  );
}

export function ErrorState({
  title = 'Something went wrong',
  description,
  onRetry,
}: {
  title?: string;
  description?: string;
  onRetry?: () => void;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
      <AlertTriangle className="h-5 w-5 text-[var(--warning)]" aria-hidden />
      <p className="text-sm text-text-primary">{title}</p>
      {description ? <p className="max-w-sm text-xs text-text-muted">{description}</p> : null}
      {onRetry ? (
        <Button size="xs" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}

/**
 * The state shown when a feature has no backend behind it. It says so plainly
 * rather than showing a plausible-looking empty table.
 */
export function CapabilityUnavailable({ feature, reason }: { feature: string; reason: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
      <Badge tone="warning">Unavailable</Badge>
      <p className="text-sm text-text-primary">{feature} is not available</p>
      <p className="max-w-sm text-xs text-text-muted">{reason}</p>
    </div>
  );
}

export function Toolbar({ children, className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'flex h-8 shrink-0 items-center gap-1 border-b border-[var(--border-default)] px-2',
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}
