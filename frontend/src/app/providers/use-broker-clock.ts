import { useQuery } from '@tanstack/react-query';
import { useServices } from './services';

/**
 * The broker server's offset from UTC, for rendering broker-stamped times.
 *
 * Shared by every grid that shows a time the trading server produced, so the
 * whole interface agrees on one clock (see broker-time.ts). It is a property
 * of the trading server rather than of the session, so it is cached for the
 * session's life and never refetched on window focus; a gateway too old to
 * report one yields null, which the formatters render as plain UTC.
 */
export function useBrokerOffsetSeconds(): number | null {
  const services = useServices();

  const query = useQuery({
    queryKey: ['broker-clock'],
    staleTime: 60 * 60_000,
    gcTime: 60 * 60_000,
    refetchOnWindowFocus: false,
    retry: 1,
    queryFn: async ({ signal }) => {
      const clock = await services.market.brokerClock(signal);
      return clock.brokerOffsetSeconds;
    },
  });

  return query.data ?? null;
}
