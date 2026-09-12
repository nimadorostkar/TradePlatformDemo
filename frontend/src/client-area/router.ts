import { useCallback, useEffect, useState, type MouseEvent } from 'react';
import { PA_PREFIX, clientAreaBase, terminalHref } from '@/app/surfaces';

/**
 * The client area's routing: real paths driven by the History API. Small
 * on purpose — a handful of pages, no nested layouts, no data loaders — so
 * a dependency-sized router would be mostly unused weight. The terminal
 * keeps its own convention (state in the query string at /).
 *
 * Routes sit under /pa when the client area shares a host with the
 * terminal and at the root on its own subdomain (see app/surfaces.ts), so
 * they are read through getters rather than baked in at import.
 */

export const PA_ROOT = PA_PREFIX;

const PATHS = {
  accounts: '/trading/accounts',
  performance: '/trading/performance',
  orders: '/trading/history',
  deposit: '/payments/deposit',
  withdrawal: '/payments/withdrawal',
  transfer: '/payments/transfer',
  transactions: '/payments/history',
  verification: '/verification',
  settings: '/settings',
} as const;

export type RouteName = keyof typeof PATHS;
export type Route = string;

/** Absolute paths of every page on the current host. */
export const ROUTES: Readonly<Record<RouteName, Route>> = Object.defineProperties(
  {} as Record<RouteName, Route>,
  Object.fromEntries(
    (Object.keys(PATHS) as RouteName[]).map((name) => [
      name,
      { get: () => clientAreaBase() + PATHS[name], enumerable: true },
    ]),
  ),
);

const NAVIGATE_EVENT = 'pa:navigate';

export function isClientAreaPath(pathname: string): boolean {
  return pathname === PA_ROOT || pathname.startsWith(`${PA_ROOT}/`);
}

/** Normalises the address to a known route; unknown ones land on Accounts. */
export function resolveRoute(pathname: string): Route {
  const trimmed = pathname.replace(/\/+$/, '') || '/';
  for (const name of Object.keys(PATHS) as RouteName[]) {
    if (trimmed === ROUTES[name]) return ROUTES[name];
  }
  return ROUTES.accounts;
}

export function navigate(to: string, options: { replace?: boolean; search?: string } = {}): void {
  const url = to + (options.search ?? '');
  if (options.replace) window.history.replaceState(window.history.state, '', url);
  else window.history.pushState(null, '', url);
  window.dispatchEvent(new Event(NAVIGATE_EVENT));
}

/** The current pathname, re-rendering on navigation and Back/Forward. */
export function usePathname(): string {
  const [pathname, setPathname] = useState(() => window.location.pathname);
  useEffect(() => {
    const update = () => setPathname(window.location.pathname);
    window.addEventListener('popstate', update);
    window.addEventListener(NAVIGATE_EVENT, update);
    return () => {
      window.removeEventListener('popstate', update);
      window.removeEventListener(NAVIGATE_EVENT, update);
    };
  }, []);
  return pathname;
}

export function useSearchParam(name: string): string | null {
  const pathname = usePathname();
  void pathname;
  return new URLSearchParams(window.location.search).get(name);
}

/** Click handler for in-app links: same-tab, unmodified clicks route; the rest behave like anchors. */
export function useLinkClick(to: string) {
  return useCallback(
    (event: MouseEvent<HTMLAnchorElement>) => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      navigate(to);
    },
    [to],
  );
}

/** The terminal, opened on a given account (its account list honours ?account=). */
export function terminalUrl(login?: string | null): string {
  return terminalHref(login);
}
