import { create } from 'zustand';
import type { DecimalString } from '@/domain/common/decimal';

/**
 * The confirmation a resize has to pass before anything is cancelled.
 *
 * Resizing a pending order is not a modify: the order leaves the book and
 * comes back with a NEW ticket. A trader who asked to change a number has not
 * asked for that, and would otherwise find out afterwards — from an id that no
 * longer matches the one in their notes.
 *
 * It lives in a store because the request arrives from the charting library's
 * own dialog, which calls straight into the broker adapter — a plain class with
 * nowhere to render. The adapter raises a request and awaits the promise; the
 * dialog mounted at the app root settles it.
 */

export interface ResizeRequest {
  orderId: string;
  displaySymbol: string;
  from: DecimalString;
  to: DecimalString;
  /** Settled by the dialog. True to go ahead, false to leave the order alone. */
  decide: (confirmed: boolean) => void;
}

interface ResizeConfirmState {
  pending: ResizeRequest | null;
  /**
   * Asks the trader, resolving to their answer.
   *
   * A second request while one is open is refused rather than queued: two
   * dialogs about two different orders, settled in an order nobody controls,
   * is how the wrong order gets cancelled.
   */
  ask: (request: Omit<ResizeRequest, 'decide'>) => Promise<boolean>;
  /** Settles the open request. */
  answer: (confirmed: boolean) => void;
}

export const useResizeConfirm = create<ResizeConfirmState>()((set, get) => ({
  pending: null,

  ask: (request) => {
    if (get().pending) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      set({
        pending: {
          ...request,
          decide: (confirmed) => {
            set({ pending: null });
            resolve(confirmed);
          },
        },
      });
    });
  },

  answer: (confirmed) => get().pending?.decide(confirmed),
}));
