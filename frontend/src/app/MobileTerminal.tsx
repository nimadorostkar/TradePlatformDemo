import { Suspense, lazy, useEffect, useState } from 'react';
import { BarChart3, CandlestickChart, Layers, ListOrdered, Wallet } from 'lucide-react';
import { cn } from '@/components/ui/cn';
import type { MobileTab as Tab } from '@/app/url-state';
import { LoadingState } from '@/components/ui/primitives';
import { ChartWorkspace } from '@/features/chart/ChartWorkspace';

/**
 * Mobile terminal.
 *
 * Deliberately NOT the desktop shell in a narrow viewport. Docking, drag-to-
 * move, and multi-chart do not work on a phone, and pretending they do produces
 * a worse experience than a purpose-built one. This is a five-tab model where
 * each tab is one full-screen view.
 */

const WatchlistWidget = lazy(() => import('@/features/watchlist/WatchlistWidget'));
const OrderTicketWidget = lazy(() => import('@/features/order-ticket/OrderTicketWidget'));
const PositionsWidget = lazy(() => import('@/features/positions/PositionsWidget'));
const AccountSummaryWidget = lazy(() => import('@/features/account-summary/AccountSummaryWidget'));

const TABS: readonly { id: Tab; label: string; icon: typeof BarChart3 }[] = [
  { id: 'markets', label: 'Markets', icon: ListOrdered },
  { id: 'chart', label: 'Chart', icon: BarChart3 },
  { id: 'trade', label: 'Trade', icon: CandlestickChart },
  { id: 'positions', label: 'Positions', icon: Layers },
  { id: 'account', label: 'Account', icon: Wallet },
];

export interface MobileTerminalProps {
  /** Controlled by the page so the active tab can live in the URL (HGH-03). */
  tab: Tab;
  onTabChange: (tab: Tab) => void;
}

export function MobileTerminal({ tab, onTabChange: setTab }: MobileTerminalProps) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1">
        <Suspense fallback={<LoadingState />}>
          {/* The chart stays MOUNTED across tab changes — remounting it would
              refetch the chart's history every time the user checks a price. */}
          <div className={cn('h-full', tab === 'chart' ? 'block' : 'hidden')}>
            <ChartWorkspace />
          </div>
          {tab === 'markets' && <WatchlistWidget />}
          {tab === 'trade' && <OrderTicketWidget />}
          {tab === 'positions' && <PositionsWidget />}
          {tab === 'account' && <AccountSummaryWidget />}
        </Suspense>
      </div>

      {/*
        The home-indicator gap is ADDED to the bar, not taken out of it.

        `h-14` with `padding-bottom: env(safe-area-inset-bottom)` looks right on
        every desktop browser, because there env() is 0. On a home-indicator
        iPhone it is about 34px, and since Tailwind sizes with border-box that
        padding comes OUT of the 56px — leaving 22px of content for an icon and
        a label, and collapsing the 78x55px touch targets the launch-readiness
        report singled out as good. The height is therefore the sum.

        The custom property is what makes this testable: unset in production, so
        env() decides, and a test can supply an inset that no desktop browser
        will ever report (HGH-05).
      */}
      <nav
        aria-label="Main navigation"
        className="flex shrink-0 items-stretch border-t border-[var(--border-default)] bg-[var(--background-secondary)]"
        style={{
          height: 'calc(3.5rem + var(--safe-area-bottom, env(safe-area-inset-bottom)))',
          paddingBottom: 'var(--safe-area-bottom, env(safe-area-inset-bottom))',
        }}
      >
        {TABS.map((item) => {
          const Icon = item.icon;
          const isActive = tab === item.id;
          return (
            <button
              key={item.id}
              aria-current={isActive ? 'page' : undefined}
              onClick={() => setTab(item.id)}
              className={cn(
                'flex flex-1 flex-col items-center justify-center gap-0.5 text-2xs',
                isActive ? 'text-[var(--brand-primary)]' : 'text-text-muted',
              )}
            >
              <Icon className="h-4 w-4" aria-hidden />
              {item.label}
            </button>
          );
        })}
      </nav>
    </div>
  );
}

/**
 * Media-query hook used by the app root to pick a shell.
 *
 * The threshold is 1024 px, NOT a phone width. Between 768 and 1024 px the
 * desktop shell degrades into the worst of both worlds — a watchlist with no
 * symbol names and a right column too narrow for the order ticket (BLK-03) —
 * so that band gets the single-column layout instead. 1023 px aligns exactly
 * with Tailwind's `lg:` breakpoint, which lets the header trim itself for the
 * mobile shell with pure CSS (`max-lg:`) and never disagree with this hook.
 */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(
    () => typeof matchMedia === 'function' && matchMedia('(max-width: 1023px)').matches,
  );

  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const query = matchMedia('(max-width: 1023px)');
    const onChange = (event: MediaQueryListEvent) => setIsMobile(event.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  return isMobile;
}
