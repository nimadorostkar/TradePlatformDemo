import { useQuery } from '@tanstack/react-query';
import { useServices } from './services';

/**
 * The account's MT5 group.
 *
 * This is what actually decides an account's trading conditions, and the only
 * identifier a trader can quote to their broker to establish what KIND of
 * account they are on — which is exactly the question the environment badge
 * cannot answer by itself.
 *
 * Shared between the header badge and the Account panel so the two agree and,
 * more practically, so they cost one request rather than two: every MT5 call
 * on this gateway queues behind a single pooled connection.
 */
export function useAccountGroup(login: string | number | null): string | null {
  const services = useServices();

  const query = useQuery({
    queryKey: ['account-group', login ?? null],
    enabled: login !== null && login !== undefined,
    staleTime: 10 * 60 * 1000,
    retry: false,
    queryFn: ({ signal }) => services.trading.accountGroup(String(login), signal),
  });

  return query.data ?? null;
}
