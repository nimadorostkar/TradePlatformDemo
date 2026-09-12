import { useMemo, type ReactNode } from 'react';
import { createServices, ServicesContext } from '@/app/providers/services';

/** Builds the service container once and provides it to the tree. */
export function ServicesProvider({ children }: { children: ReactNode }) {
  const services = useMemo(() => createServices(), []);
  return <ServicesContext.Provider value={services}>{children}</ServicesContext.Provider>;
}
