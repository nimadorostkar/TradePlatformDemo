import { cn } from '@/components/ui/cn';
import { Input } from '@/components/ui/primitives';
import type { BracketUnit } from '@/domain/orders/risk';

/**
 * A stop-loss / take-profit field that accepts the value in the unit the trader
 * thinks in — an absolute price, a pip distance, a percentage, or a cash risk.
 *
 * The resolved price is always shown underneath, because the unit is a
 * convenience and the price is what actually reaches the trading server.
 */

const UNITS: readonly { value: BracketUnit; label: string; title: string }[] = [
  // "price", not "·00": the default unit was the only one whose label meant
  // nothing without hovering the title attribute (MED-04).
  { value: 'price', label: 'price', title: 'Absolute price' },
  { value: 'pips', label: 'pip', title: 'Distance in pips' },
  { value: 'percent', label: '%', title: 'Percent of the entry price' },
  { value: 'money', label: '$', title: 'Cash amount at risk' },
];

export interface BracketInputProps {
  id: string;
  label: string;
  value: string;
  unit: BracketUnit;
  onValueChange: (value: string) => void;
  onUnitChange: (unit: BracketUnit) => void;
  /** Price this resolves to, once converted. */
  resolvedPrice: string | null;
  digits: number;
  /** Why the value could not be converted, when it could not. */
  unavailable?: string | null;
  error?: string | null;
  disabled?: boolean;
}

export function BracketInput({
  id,
  label,
  value,
  unit,
  onValueChange,
  onUnitChange,
  resolvedPrice,
  digits,
  unavailable,
  error,
  disabled,
}: BracketInputProps) {
  const describedBy = error || unavailable ? `${id}-message` : `${id}-resolved`;

  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-2xs font-medium text-text-secondary">
        {label}
      </label>

      {/* The input gets a row to ITSELF, and the unit chips sit beneath it.
          `flex-1` alone is `1 1 0%`, so the fixed-width chips took the row and
          the price input collapsed to 17px — the value was submitted correctly
          but was invisible while being typed. A minimum width only moved that
          threshold: in a narrow dock, in two columns, a five-digit FX price
          still ran out of room, and a field that holds a value while looking
          empty is how a rejected stop came to have a new number typed onto the
          end of the old one (2026-08-20 retest, BUG-E). Whatever the dock's
          width, what the field holds is now what the trader sees. */}
      <div className="flex flex-wrap items-center gap-1">
        <Input
          id={id}
          inputMode="decimal"
          value={value}
          disabled={disabled}
          aria-describedby={describedBy}
          aria-invalid={error ? true : undefined}
          onChange={(event) => onValueChange(event.target.value)}
          // A bracket is replaced far more often than it is edited a digit at
          // a time, and a field the trader wants rid of must have one obvious
          // way out: clicking into it selects what is there, so the next
          // keystroke overwrites rather than appends.
          onFocus={(event) => event.currentTarget.select()}
          placeholder="—"
          className="basis-full"
        />
        <div
          role="group"
          aria-label={`${label} unit`}
          className="flex shrink-0 overflow-hidden rounded border border-[var(--border-default)]"
        >
          {UNITS.map((option) => (
            <button
              key={option.value}
              type="button"
              title={option.title}
              aria-pressed={unit === option.value}
              disabled={disabled}
              onClick={() => onUnitChange(option.value)}
              className={cn(
                // MED-03: every chip is a real 24px target; the segmented
                // control grows from 16px to 24px tall as a consequence.
                'min-h-6 min-w-6 px-1.5 text-2xs transition-colors disabled:opacity-40',
                unit === option.value
                  ? 'bg-[var(--brand-primary)] text-[var(--brand-primary-contrast)]'
                  : 'text-text-muted hover:text-text-primary',
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {error || unavailable ? (
        <p
          id={`${id}-message`}
          role={error ? 'alert' : undefined}
          className={cn('text-2xs', error ? 'text-[var(--negative)]' : 'text-text-muted')}
        >
          {error ?? unavailable}
        </p>
      ) : (
        <p id={`${id}-resolved`} className="text-2xs text-text-muted">
          {/* The price is what the server receives, so it is always visible —
              even when the trader typed pips. */}
          {resolvedPrice !== null && unit !== 'price'
            ? `→ ${Number(resolvedPrice).toFixed(digits)}`
            : ' '}
        </p>
      )}
    </div>
  );
}
