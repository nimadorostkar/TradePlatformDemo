import { useQuery } from '@tanstack/react-query';
import { useServices } from '@/app/providers/services';
import { useSessionStore } from '@/stores/session-store';
import type { UserProfile } from '@/integrations/gateway/auth/crm-session';

/**
 * The signed-in user's CRM profile — the person behind the login. Fetched
 * once per session and kept while the panel is open; a profile changes
 * rarely and never on its own.
 */
export function useProfile() {
  const services = useServices();
  const username = useSessionStore((s) => s.username);
  return useQuery<UserProfile>({
    queryKey: ['crm-profile', username],
    queryFn: ({ signal }) => services.auth.profile(signal),
    staleTime: 5 * 60_000,
    retry: false,
  });
}
