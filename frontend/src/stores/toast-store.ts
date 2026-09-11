import { create } from 'zustand';

/**
 * Transient notifications.
 *
 * Separate from System Messages, which is a durable diagnostics log. A fill is
 * something a trader needs to notice *now*; the log is where they go to check
 * afterwards. Every toast is also written to the log, so nothing is lost when
 * one is missed or dismissed.
 */

export type ToastTone = 'success' | 'error' | 'warning' | 'info';

export interface Toast {
  id: string;
  tone: ToastTone;
  title: string;
  body?: string;
  /** Milliseconds before auto-dismiss; errors stay until dismissed. */
  durationMs: number;
}

const MAX_VISIBLE = 4;
const DEFAULT_DURATION_MS = 6_000;

interface ToastState {
  toasts: Toast[];
  push: (toast: Omit<Toast, 'id' | 'durationMs'> & { durationMs?: number }) => string;
  /**
   * Amends a toast that is still on screen.
   *
   * For the case where the honest answer arrives a moment after the event:
   * a close is announced immediately, and the realised settlement — which
   * only exists once MT5 has written the closing deal — corrects the same
   * toast in place rather than stacking a second one beside it. A toast the
   * user already dismissed stays dismissed.
   */
  update: (id: string, patch: Partial<Omit<Toast, 'id'>>) => void;
  dismiss: (id: string) => void;
  clear: () => void;
}

export const useToasts = create<ToastState>()((set) => ({
  toasts: [],

  push: (toast) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    set((state) => ({
      toasts: [
        ...state.toasts,
        {
          ...toast,
          id,
          // An error stays put: it usually needs a decision, and a trader who
          // looked away should not lose a rejection notice.
          durationMs: toast.durationMs ?? (toast.tone === 'error' ? 0 : DEFAULT_DURATION_MS),
        },
      ].slice(-MAX_VISIBLE),
    }));
    return id;
  },

  update: (id, patch) =>
    set((state) => ({
      toasts: state.toasts.map((toast) => (toast.id === id ? { ...toast, ...patch } : toast)),
    })),

  dismiss: (id) => set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),
  clear: () => set({ toasts: [] }),
}));
