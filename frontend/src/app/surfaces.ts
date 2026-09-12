import { env } from '@/app/config/env';

/**
 * The two applications this bundle contains and how an address picks one.
 *
 * The terminal and the client area ("personal area") are one build but two
 * products, and a broker gives each its own subdomain — trade.example.com
 * and my.example.com. The surface a page belongs to therefore depends on
 * the ORIGIN first and the path second:
 *
 *   - on the configured client-area origin every path is the client area,
 *     served from the root (/trading/accounts, not /pa/trading/accounts);
 *   - on the configured terminal origin the terminal lives at / and a /pa
 *     path is sent across to the client-area origin;
 *   - on any other host — a bare IP, a local dev server, a deployment with
 *     no subdomains yet — the terminal is at / and the client area under /pa.
 *
 * `APP_SURFACE` can pin one surface for a host set up to serve only that.
 */

export type Surface = 'terminal' | 'client-area';

export const PA_PREFIX = '/pa';

export interface Placement {
  /** What to render. */
  surface: Surface | 'not-found';
  /** Where the client area's routes start on this host: '' or '/pa'. */
  clientAreaBase: string;
  /** An address to send the browser to instead (a /pa path on the terminal host). */
  redirectTo?: string;
}

function currentOrigin(): string {
  return typeof window === 'undefined' ? '' : window.location.origin;
}

/** Decides what a pathname is on the current origin. */
export function placementFor(pathname: string, here: string = currentOrigin()): Placement {
  const { surface, terminalOrigin, clientAreaOrigin } = env();
  const onClientAreaHost = clientAreaOrigin !== '' && here === clientAreaOrigin;
  const onTerminalHost = terminalOrigin !== '' && here === terminalOrigin;
  const isPa = pathname === PA_PREFIX || pathname.startsWith(`${PA_PREFIX}/`);
  const isRoot = pathname === '/' || pathname === '/index.html';

  if (surface === 'client-area' || onClientAreaHost) {
    return { surface: 'client-area', clientAreaBase: '' };
  }
  if (surface === 'terminal' || onTerminalHost) {
    if (isRoot) return { surface: 'terminal', clientAreaBase: PA_PREFIX };
    if (isPa && clientAreaOrigin !== '' && clientAreaOrigin !== here) {
      return {
        surface: 'not-found',
        clientAreaBase: PA_PREFIX,
        redirectTo: clientAreaOrigin + (pathname.slice(PA_PREFIX.length) || '/'),
      };
    }
    return { surface: 'not-found', clientAreaBase: PA_PREFIX };
  }
  if (isRoot) return { surface: 'terminal', clientAreaBase: PA_PREFIX };
  if (isPa) return { surface: 'client-area', clientAreaBase: PA_PREFIX };
  return { surface: 'not-found', clientAreaBase: PA_PREFIX };
}

/** The client area's route prefix on the current host. */
export function clientAreaBase(here: string = currentOrigin()): string {
  return placementFor('/', here).clientAreaBase === '' ? '' : PA_PREFIX;
}

/**
 * A link into the client area from anywhere: its own origin when it has
 * one, else the /pa prefix on this host.
 */
export function clientAreaHref(path: string, here: string = currentOrigin()): string {
  const { clientAreaOrigin } = env();
  if (clientAreaOrigin !== '' && clientAreaOrigin !== here) return clientAreaOrigin + path;
  return clientAreaBase(here) + path;
}

/**
 * A link into the terminal, on a given account: its own origin when it has
 * one, else the root of this host. The terminal reads ?account= once.
 */
export function terminalHref(login?: string | null, here: string = currentOrigin()): string {
  const { terminalOrigin } = env();
  const base = terminalOrigin !== '' && terminalOrigin !== here ? terminalOrigin : '';
  return `${base}/${login ? `?account=${encodeURIComponent(login)}` : ''}`;
}
