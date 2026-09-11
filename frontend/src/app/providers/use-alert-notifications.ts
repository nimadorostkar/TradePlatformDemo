import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useServices } from './services';
import { useCapabilities } from '@/stores/capabilities-store';
import { useSessionStore } from '@/stores/session-store';
import { useSystemMessages } from '@/stores/system-messages-store';
import { useToasts } from '@/stores/toast-store';
import { formatBrokerTime } from '@/domain/common/broker-time';
import { useBrokerOffsetSeconds } from './use-broker-clock';

/**
 * Tells the trader when a price alert actually fires.
 *
 * Until now it did not. A fired alert appeared in the Alerts panel — warning
 * badge, firing time, crossing price — and nowhere else: no toast, no sound,
 * nothing in the log. A trader who was not looking at that one panel was never
 * told, which for a feature whose entire purpose is to notify is the whole
 * feature missing. Found while writing the test that proved the panel renders
 * a fired alert correctly (2026-08-26).
 *
 * The alert itself has always lived on the trading server, which is why the
 * panel can honestly say alerts "keep working after you close this tab". This
 * only carries the news to the surface a trader is actually watching.
 *
 * It shares the Alerts panel's query key, so an open panel costs nothing extra
 * and a closed one keeps the same 15s cadence the panel would have used.
 */
export function useAlertNotifications(): void {
  const services = useServices();
  const login = useSessionStore((s) => s.activeLogin);
  const suffixPolicy = useSessionStore((s) => s.suffixPolicy);
  const alertsAvailable = useCapabilities((s) => s.capabilities.alerts.enabled);
  const pushToast = useToasts((s) => s.push);
  const pushMessage = useSystemMessages((s) => s.push);
  const brokerOffsetSeconds = useBrokerOffsetSeconds();

  const query = useQuery({
    queryKey: ['alerts', login, suffixPolicy.suffix],
    enabled: login !== null && alertsAvailable,
    refetchInterval: 15_000,
    queryFn: ({ signal }) => services.features.listAlerts(login!, suffixPolicy, signal),
  });

  /**
   * Alerts already seen in the `triggered` state.
   *
   * Seeded from the FIRST answer rather than starting empty, so alerts that
   * fired while the trader was away do not all announce themselves at once on
   * the next page load — they are history by then, and the panel shows them.
   * Only a transition observed live is news.
   */
  const announced = useRef<Set<string> | null>(null);
  const forLogin = useRef<string | null>(null);

  useEffect(() => {
    // A different account's alerts are a different set entirely.
    if (forLogin.current !== login) {
      forLogin.current = login;
      announced.current = null;
    }

    const alerts = query.data;
    if (!alerts) return;

    if (announced.current === null) {
      announced.current = new Set(alerts.filter((a) => a.status === 'triggered').map((a) => a.id));
      return;
    }

    for (const alert of alerts) {
      if (alert.status !== 'triggered' || announced.current.has(alert.id)) continue;
      announced.current.add(alert.id);

      const level = `${alert.condition === 'above' ? '≥' : '≤'} ${alert.price}`;
      const at = alert.triggeredPrice !== null ? ` at ${alert.triggeredPrice}` : '';
      const body = `${alert.displaySymbol} ${level}${at}`;

      pushToast({
        tone: 'warning',
        title: 'Price alert triggered',
        body,
        // Longer than the default: an alert the trader asked for is worth more
        // than six seconds of their attention, and it cannot be re-fired.
        durationMs: 15_000,
      });
      pushMessage({
        level: 'warning',
        scope: 'alert',
        text: `Alert ${alert.id} triggered — ${body}${
          alert.triggeredAt !== null
            ? ` (${formatBrokerTime(alert.triggeredAt, brokerOffsetSeconds)})`
            : ''
        }`,
        code: 'alert.triggered',
        requestId: null,
      });
    }
  }, [query.data, login, pushToast, pushMessage, brokerOffsetSeconds]);
}
