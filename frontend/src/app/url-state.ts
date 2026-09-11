import { useEffect } from 'react';
import { useWorkspace } from '@/workspace/layout/workspace-store';

/**
 * URL ↔ terminal state synchronisation (HGH-03).
 *
 * The application previously never touched the URL: the Back button ejected
 * the trader to about:blank, no symbol could be shared, and no view could be
 * bookmarked. The active symbol and the active TAB now live in the query
 * string —
 *
 *   /?symbol=XAUUSD&tab=positions
 *
 * — pushed into history on change, so Back walks through the trader's own
 * recent views instead of leaving the product, and a pasted link opens on the
 * view it names.
 *
 * "Tab" means whichever tab model the current shell has: the phone shell's
 * five bottom tabs, or the desktop shell's bottom-dock panel strip (whose tab
 * values are widget ids — positions, order-history, deals, account-summary,
 * system-messages…). The two vocabularies overlap on purpose: a link made on
 * one device should land somewhere sensible on the other.
 *
 * Deliberately the QUERY STRING, not a path: every unknown path is already the
 * SPA fallback on the server, and a path-shaped router is far more surface
 * than two parameters need.
 */

export type MobileTab = 'markets' | 'chart' | 'trade' | 'positions' | 'account';

const MOBILE_TABS: readonly MobileTab[] = ['markets', 'chart', 'trade', 'positions', 'account'];

/** Desktop bottom-dock widgets a link may name. */
const DESKTOP_TABS: readonly string[] = [
  'positions',
  'pending-orders',
  'order-history',
  'deals',
  'account-summary',
  'system-messages',
  'journal',
];

/** Phone-name → desktop widget id, for links that cross shells. */
const MOBILE_TO_WIDGET: Partial<Record<MobileTab, string>> = {
  markets: 'watchlist',
  trade: 'order-ticket',
  positions: 'positions',
  account: 'account-summary',
};

/** Desktop widget id → nearest phone tab, for the reverse crossing. */
const WIDGET_TO_MOBILE: Record<string, MobileTab> = {
  watchlist: 'markets',
  'order-ticket': 'trade',
  positions: 'positions',
  'pending-orders': 'positions',
  'order-history': 'positions',
  deals: 'positions',
  'account-summary': 'account',
  'system-messages': 'account',
  journal: 'account',
};

/** A symbol as MT5 names them; anything else in the parameter is ignored. */
const SYMBOL_SHAPE = /^[A-Za-z0-9._\-#&]{1,32}$/;

export interface UrlState {
  symbol: string | null;
  tab: string | null;
}

export function readUrlState(search: string = window.location.search): UrlState {
  const params = new URLSearchParams(search);
  const rawSymbol = params.get('symbol')?.trim() ?? '';
  const rawTab = params.get('tab')?.trim().toLowerCase() ?? '';
  const validTab =
    (MOBILE_TABS as readonly string[]).includes(rawTab) || DESKTOP_TABS.includes(rawTab);
  return {
    symbol: SYMBOL_SHAPE.test(rawSymbol) ? rawSymbol : null,
    tab: validTab ? rawTab : null,
  };
}

/**
 * Reflects state into the URL. Untouched parameters survive — the auth
 * bootstrap already polices credential-shaped parameters itself.
 */
export function writeUrlState(state: UrlState, mode: 'push' | 'replace'): void {
  const url = new URL(window.location.href);
  if (state.symbol) url.searchParams.set('symbol', state.symbol);
  else url.searchParams.delete('symbol');
  if (state.tab) url.searchParams.set('tab', state.tab);
  else url.searchParams.delete('tab');

  if (url.href === window.location.href) return; // nothing changed: no history spam
  if (mode === 'push') window.history.pushState(null, '', url);
  else window.history.replaceState(null, '', url);
}

/** The tab value the DESKTOP shell would put in the URL right now. */
function selectDesktopTab(state: {
  workspace: { regions: { bottom: { groups: { activeWidgetId: string }[] } } };
}): string | null {
  const active = state.workspace.regions.bottom.groups[0]?.activeWidgetId ?? null;
  return active && DESKTOP_TABS.includes(active) ? active : null;
}

/** Applies a URL tab value to whichever shell is active. */
function applyTab(tab: string, isMobile: boolean, setMobileTab: (tab: MobileTab) => void): void {
  if (isMobile) {
    const mobile = (MOBILE_TABS as readonly string[]).includes(tab)
      ? (tab as MobileTab)
      : WIDGET_TO_MOBILE[tab];
    if (mobile) setMobileTab(mobile);
    return;
  }
  const widgetId = DESKTOP_TABS.includes(tab) ? tab : (MOBILE_TO_WIDGET[tab as MobileTab] ?? null);
  // Adopted, not merely activated: the sign-in resync that follows would
  // otherwise restore the layout's remembered tab over the link's (the same
  // race adoptUrlSymbol already wins for the symbol). Adoption is still a
  // no-op for a widget the layout does not place, which is the right
  // degradation for a link into a panel this user closed.
  if (widgetId) useWorkspace.getState().adoptUrlTab(widgetId);
}

/**
 * Owns the sync while the terminal is mounted.
 *
 * - On mount, a symbol/tab named in the URL is adopted (a shared link).
 * - Symbol/tab changes update the URL; the first write only normalises the
 *   address (replace), every later change pushes a history entry — which is
 *   what makes Back walk the trader's own recent views.
 * - popstate (Back/Forward) re-applies the URL's state to the terminal.
 */
export function useUrlStateSync(
  mobileTab: MobileTab | null,
  setMobileTab: (tab: MobileTab) => void,
): void {
  const isMobile = mobileTab !== null;
  const activeSymbol = useWorkspace((s) => s.workspace.activeSymbol);
  const setActiveSymbol = useWorkspace((s) => s.setActiveSymbol);
  const adoptUrlSymbol = useWorkspace((s) => s.adoptUrlSymbol);
  const desktopTab = useWorkspace((s) => (isMobile ? null : selectDesktopTab(s)));

  const tab = isMobile ? mobileTab : desktopTab;

  // Adopt the URL's state once on mount — the symbol via adoptUrlSymbol,
  // which survives the server workspace resync that follows sign-in. The
  // symbol is validated against nothing on purpose: an unknown one degrades
  // to the chart's own "no data" state, which is honest and recoverable.
  useEffect(() => {
    const initial = readUrlState();
    if (initial.symbol && initial.symbol !== useWorkspace.getState().workspace.activeSymbol) {
      adoptUrlSymbol(initial.symbol);
    }
    if (initial.tab) applyTab(initial.tab, isMobile, setMobileTab);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount only
  }, []);

  // State → URL. The FIRST write only normalises the address (replace); after
  // that every symbol or tab change pushes an entry.
  useEffect(() => {
    const current = readUrlState();
    const initial = current.symbol === null && current.tab === null;
    writeUrlState({ symbol: activeSymbol, tab }, initial ? 'replace' : 'push');
  }, [activeSymbol, tab]);

  // URL → state (Back/Forward).
  useEffect(() => {
    const onPopState = () => {
      const state = readUrlState();
      if (state.symbol && state.symbol !== useWorkspace.getState().workspace.activeSymbol) {
        setActiveSymbol(state.symbol);
      }
      if (state.tab) applyTab(state.tab, isMobile, setMobileTab);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [setActiveSymbol, setMobileTab, isMobile]);
}
