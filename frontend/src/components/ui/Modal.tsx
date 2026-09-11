import { useEffect, useRef, type ReactNode } from 'react';
import { cn } from './cn';

/**
 * Focus-trapping modal.
 *
 * Extracted because every trading dialog needs the same behaviour and getting
 * it wrong on one of them is a real accessibility failure: Escape closes,
 * focus is trapped, focus is restored on close, and initial focus lands on the
 * SAFE control rather than the destructive one.
 */
export function Modal({
  title,
  titleId,
  children,
  onClose,
  className,
  initialFocusRef,
}: {
  title: string;
  titleId: string;
  children: ReactNode;
  onClose: () => void;
  className?: string;
  initialFocusRef?: React.RefObject<HTMLElement | null>;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    previouslyFocused.current = document.activeElement as HTMLElement | null;

    // Prefer the caller's choice; otherwise the first focusable, which is by
    // convention the cancelling control.
    const target =
      initialFocusRef?.current ??
      dialogRef.current?.querySelector<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
    target?.focus();

    return () => previouslyFocused.current?.focus();
  }, [initialFocusRef]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;

      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable || focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
        className={cn(
          'w-full max-w-xs rounded-lg border border-[var(--border-strong)] bg-[var(--surface-overlay)] p-4 shadow-[var(--shadow-panel)]',
          className,
        )}
      >
        <h2 id={titleId} className="text-sm font-semibold">
          {title}
        </h2>
        {children}
      </div>
    </div>
  );
}

/** Label/value row used inside confirmation dialogs. */
export function ModalRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <dt className="text-text-muted">{label}</dt>
      <dd className="text-text-primary">{children}</dd>
    </div>
  );
}
