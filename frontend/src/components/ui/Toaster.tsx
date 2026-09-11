import { useEffect } from 'react';
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { cn } from './cn';
import { useToasts, type Toast, type ToastTone } from '@/stores/toast-store';

/**
 * Transient notification stack.
 *
 * Rendered in a polite live region so a fill is announced once, without the
 * running commentary that announcing every price tick would produce.
 */

const TONE_ICON: Record<ToastTone, typeof Info> = {
  success: CheckCircle2,
  error: XCircle,
  warning: AlertTriangle,
  info: Info,
};

const TONE_CLASS: Record<ToastTone, string> = {
  success: 'border-[var(--positive)] text-[var(--positive)]',
  error: 'border-[var(--negative)] text-[var(--negative)]',
  warning: 'border-[var(--warning)] text-[var(--warning)]',
  info: 'border-[var(--info)] text-[var(--info)]',
};

export function Toaster() {
  const toasts = useToasts((s) => s.toasts);

  return (
    <div
      aria-live="polite"
      aria-relevant="additions"
      className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-72 flex-col gap-2"
    >
      {toasts.map((toast) => (
        <ToastCard key={toast.id} toast={toast} />
      ))}
    </div>
  );
}

function ToastCard({ toast }: { toast: Toast }) {
  const dismiss = useToasts((s) => s.dismiss);
  const Icon = TONE_ICON[toast.tone];

  useEffect(() => {
    if (toast.durationMs <= 0) return;
    const timer = setTimeout(() => dismiss(toast.id), toast.durationMs);
    return () => clearTimeout(timer);
  }, [toast.id, toast.durationMs, dismiss]);

  return (
    <div
      role={toast.tone === 'error' ? 'alert' : 'status'}
      className={cn(
        'pointer-events-auto flex items-start gap-2 rounded border-l-2 bg-[var(--surface-overlay)] p-2.5 shadow-[var(--shadow-panel)]',
        TONE_CLASS[toast.tone],
      )}
    >
      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-2xs font-medium text-text-primary">{toast.title}</p>
        {toast.body ? <p className="mt-0.5 text-2xs text-text-secondary">{toast.body}</p> : null}
      </div>
      <button
        aria-label="Dismiss notification"
        onClick={() => dismiss(toast.id)}
        className="shrink-0 rounded p-0.5 text-text-muted hover:bg-[var(--surface-raised)] hover:text-text-primary"
      >
        <X className="h-2.5 w-2.5" aria-hidden />
      </button>
    </div>
  );
}
