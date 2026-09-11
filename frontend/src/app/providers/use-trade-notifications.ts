import { useEffect, useRef } from 'react';
import { useTradingStore } from '@/stores/trading-store';
import { useToasts } from '@/stores/toast-store';
import { useSystemMessages } from '@/stores/system-messages-store';
import { useSessionStore } from '@/stores/session-store';
import { reportCloseSettlement } from '@/features/positions/close-settlement';
import { useServices } from './services';
import type { Position } from '@/domain/common/models';

/**
 * Turns authoritative position changes into visible notifications.
 *
 * Driven off the normalised store rather than the mutation response, so a
 * position opened from the chart, from the ticket, or on another device all
 * notify identically — and nothing is announced until the server's own
 * snapshot confirms it.
 */
export function useTradeNotifications(): void {
  const services = useServices();
  const pushToast = useToasts((s) => s.push);
  const pushMessage = useSystemMessages((s) => s.push);

  // Seeded on the first snapshot so the initial load does not announce every
  // already-open position as if it had just filled.
  const seeded = useRef(false);
  const previous = useRef<ReadonlyMap<string, Position>>(new Map());

  useEffect(() => {
    const unsubscribe = useTradingStore.subscribe((state) => {
      const current = state.positionsById;
      if (current === previous.current) return;

      if (!seeded.current) {
        // Wait for the first authoritative snapshot to land before treating
        // anything as "new".
        if (!state.initialLoadPending) {
          seeded.current = true;
          previous.current = current;
        }
        return;
      }

      const before = previous.current;
      previous.current = current;

      for (const [id, position] of current) {
        if (before.has(id)) continue;
        const text = `${position.side === 'buy' ? 'Buy' : 'Sell'} ${position.volume} ${position.displaySymbol} at ${position.openPrice}`;
        pushToast({ tone: 'success', title: 'Position opened', body: text });
        pushMessage({
          level: 'success',
          scope: 'position',
          text: `Position ${id} opened — ${text}`,
          code: 'position.opened',
          requestId: null,
        });
      }

      for (const [id, position] of before) {
        if (current.has(id)) continue;

        // Deliberately no number yet. The last streamed floating P/L is not
        // the result: it predates the fill price and knows nothing of
        // commission or swap, which is how a close that settled at +0.13 was
        // announced as +0.14. The realised figure replaces this line below,
        // as soon as MT5 has written the closing deal.
        const what = `${position.displaySymbol} ${position.volume} lots`;
        const toastId = pushToast({
          tone: 'success',
          title: 'Position closed',
          body: `${what} · settling…`,
        });
        pushMessage({
          level: 'info',
          scope: 'position',
          text: `Position ${id} closed — ${what}`,
          code: 'position.closed',
          requestId: null,
        });

        // Runs for EVERY close — the ticket, the chart, a bulk action, or a
        // stop-loss firing while nobody was looking.
        const login = useSessionStore.getState().activeLogin;
        if (login) {
          void reportCloseSettlement({
            features: services.features,
            login,
            positionId: id,
            currency: useTradingStore.getState().account?.currency ?? null,
            push: pushMessage,
            onSettled: (settlement) => {
              const net = settlement.net;
              useToasts.getState().update(toastId, {
                tone: net < 0 ? 'warning' : 'success',
                body: `${what} · ${net >= 0 ? '+' : ''}${net.toFixed(2)}`,
                // Restart the clock: the number the trader was waiting for
                // must not arrive on a toast that is already fading.
                durationMs: 6_000,
              });
            },
          });
        }
      }
    });

    return unsubscribe;
  }, [pushToast, pushMessage, services]);
}
