import { Suspense, lazy, useEffect, useState, type ReactNode } from 'react';
import {
  ArrowLeftRight,
  ArrowDownToLine,
  ArrowUpFromLine,
  BarChart3,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleUser,
  Clock,
  ExternalLink,
  History,
  LayoutGrid,
  LogOut,
  Menu,
  Moon,
  Receipt,
  Settings,
  ShieldCheck,
  Sun,
  Wallet,
  X,
} from 'lucide-react';
import { cn } from '@/components/ui/cn';
import { BrandLogo } from '@/components/ui/BrandLogo';
import { LoadingState } from '@/components/ui/primitives';
import { useBrand } from '@/app/providers/brand-provider';
import { useServices } from '@/app/providers/services';
import { useSessionStore } from '@/stores/session-store';
import { useWorkspace } from '@/workspace/layout/workspace-store';
import {
  ROUTES,
  navigate,
  resolveRoute,
  terminalUrl,
  useLinkClick,
  usePathname,
  type Route,
} from './router';
import { formatMoney, totalBalance, useAccounts, useMe, useVerification } from './hooks';

/**
 * The client area: everything a trader manages outside the terminal —
 * accounts, deposits and withdrawals, transfers, history, verification and
 * profile. One shell (top bar, sidebar, verification banner) around a page
 * chosen by the path under /pa. Same session and services as the terminal;
 * the terminal itself is one click away and opens on the account chosen.
 */

const AccountsPage = lazy(() => import('./pages/AccountsPage'));
const PerformancePage = lazy(() => import('./pages/PerformancePage'));
const OrderHistoryPage = lazy(() => import('./pages/OrderHistoryPage'));
const DepositPage = lazy(() => import('./pages/DepositPage'));
const WithdrawalPage = lazy(() => import('./pages/WithdrawalPage'));
const TransferPage = lazy(() => import('./pages/TransferPage'));
const TransactionsPage = lazy(() => import('./pages/TransactionsPage'));
const VerificationPage = lazy(() => import('./pages/VerificationPage'));
const SettingsPage = lazy(() => import('./pages/SettingsPage'));

const PAGES: Record<Route, () => ReactNode> = {
  [ROUTES.accounts]: () => <AccountsPage />,
  [ROUTES.performance]: () => <PerformancePage />,
  [ROUTES.orders]: () => <OrderHistoryPage />,
  [ROUTES.deposit]: () => <DepositPage />,
  [ROUTES.withdrawal]: () => <WithdrawalPage />,
  [ROUTES.transfer]: () => <TransferPage />,
  [ROUTES.transactions]: () => <TransactionsPage />,
  [ROUTES.verification]: () => <VerificationPage />,
  [ROUTES.settings]: () => <SettingsPage />,
};

const NAV: {
  title: string;
  icon: typeof Wallet;
  items: { label: string; to: Route | 'terminal'; icon: typeof Wallet; badge?: string }[];
}[] = [
  {
    title: 'Trading',
    icon: BarChart3,
    items: [
      { label: 'Accounts', to: ROUTES.accounts, icon: LayoutGrid },
      { label: 'Performance', to: ROUTES.performance, icon: BarChart3 },
      { label: 'History of orders', to: ROUTES.orders, icon: History },
      { label: 'Trading terminal', to: 'terminal', icon: ExternalLink },
    ],
  },
  {
    title: 'Payments & wallet',
    icon: Wallet,
    items: [
      { label: 'Deposit', to: ROUTES.deposit, icon: ArrowDownToLine },
      { label: 'Withdrawal', to: ROUTES.withdrawal, icon: ArrowUpFromLine },
      { label: 'Transfer', to: ROUTES.transfer, icon: ArrowLeftRight, badge: 'New' },
      { label: 'Transaction history', to: ROUTES.transactions, icon: Receipt },
    ],
  },
  {
    title: 'Profile',
    icon: CircleUser,
    items: [
      { label: 'Verification', to: ROUTES.verification, icon: ShieldCheck },
      { label: 'Settings', to: ROUTES.settings, icon: Settings },
    ],
  },
];

export function ClientAreaApp() {
  const pathname = usePathname();
  const route = resolveRoute(pathname);
  const theme = useWorkspace((s) => s.workspace.theme);
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem('pa.sidebar') === 'collapsed';
    } catch {
      return false;
    }
  });
  const [drawerOpen, setDrawerOpen] = useState(false);

  // The same theme rule as the terminal, so the two halves never disagree.
  useEffect(() => {
    const resolved =
      theme === 'system'
        ? typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches
          ? 'light'
          : 'dark'
        : theme;
    document.documentElement.dataset.theme = resolved;
  }, [theme]);

  // /pa itself is not a page; land on Accounts without leaving a dead entry
  // in the history.
  useEffect(() => {
    if (pathname.replace(/\/+$/, '') !== route) navigate(route, { replace: true });
  }, [pathname, route]);

  useEffect(() => {
    setDrawerOpen(false);
  }, [route]);

  const toggleCollapsed = () => {
    setCollapsed((value) => {
      try {
        localStorage.setItem('pa.sidebar', value ? 'expanded' : 'collapsed');
      } catch {
        /* per-browser convenience only */
      }
      return !value;
    });
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--background-primary)] text-text-primary">
      <TopBar onMenu={() => setDrawerOpen(true)} />
      <div className="flex min-h-0 flex-1">
        <Sidebar
          route={route}
          collapsed={collapsed}
          onToggleCollapsed={toggleCollapsed}
          className="hidden lg:flex"
        />
        {drawerOpen && (
          <div className="fixed inset-0 z-40 lg:hidden">
            <button
              type="button"
              aria-label="Close menu"
              onClick={() => setDrawerOpen(false)}
              className="absolute inset-0 bg-black/40"
            />
            <Sidebar
              route={route}
              collapsed={false}
              onToggleCollapsed={() => setDrawerOpen(false)}
              className="relative z-10 flex h-full w-72 shadow-[var(--shadow-panel)]"
              closeIcon
            />
          </div>
        )}
        <main className="min-w-0 flex-1 overflow-y-auto">
          <VerificationBanner />
          <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 lg:px-10 lg:py-8">
            <Suspense fallback={<LoadingState label="Loading…" />}>{PAGES[route]()}</Suspense>
          </div>
        </main>
      </div>
    </div>
  );
}

function TopBar({ onMenu }: { onMenu: () => void }) {
  const brand = useBrand();
  const services = useServices();
  const theme = useWorkspace((s) => s.workspace.theme);
  const setTheme = useWorkspace((s) => s.setTheme);
  const [logoFailed, setLogoFailed] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const me = useMe();
  const accounts = useAccounts();
  const activeLogin = useSessionStore((s) => s.activeLogin);
  const total = totalBalance(accounts.data, 'real');

  useEffect(() => {
    if (!menuOpen) return;
    const close = () => setMenuOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [menuOpen]);

  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-[var(--border-default)] bg-[var(--background-primary)] px-4 sm:px-6">
      <button
        type="button"
        aria-label="Open menu"
        onClick={onMenu}
        className="rounded p-1.5 text-text-secondary hover:bg-[var(--surface-raised)] lg:hidden"
      >
        <Menu className="h-5 w-5" />
      </button>
      <a
        href={ROUTES.accounts}
        onClick={useLinkClick(ROUTES.accounts)}
        className="flex items-center"
      >
        {!logoFailed ? (
          <BrandLogo variant="compact" className="h-6 w-auto" onFail={() => setLogoFailed(true)} />
        ) : (
          <span className="text-base font-semibold">{brand.platformName}</span>
        )}
      </a>
      <div className="ml-auto flex items-center gap-1 sm:gap-2">
        <a
          href={ROUTES.accounts}
          onClick={useLinkClick(ROUTES.accounts)}
          className="hidden items-center gap-2 rounded px-2 py-1 text-sm hover:bg-[var(--surface-raised)] sm:flex"
          title="Total balance across real accounts"
        >
          <Wallet className="h-4 w-4 text-text-secondary" aria-hidden />
          <span className="font-semibold tabular-nums">{formatMoney(total)}</span>
        </a>
        <button
          type="button"
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
          className="rounded p-2 text-text-secondary hover:bg-[var(--surface-raised)] hover:text-text-primary"
        >
          {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </button>
        <a
          href={terminalUrl(activeLogin)}
          className="hidden items-center gap-1.5 rounded bg-[var(--brand-primary)] px-3 py-1.5 text-sm font-medium text-[var(--brand-primary-contrast)] hover:brightness-110 sm:flex"
        >
          Trade
          <ExternalLink className="h-3.5 w-3.5" aria-hidden />
        </a>
        <div className="relative" onMouseDown={(event) => event.stopPropagation()}>
          <button
            type="button"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label="Account menu"
            onClick={() => setMenuOpen((open) => !open)}
            className="flex items-center gap-1 rounded p-1.5 text-text-secondary hover:bg-[var(--surface-raised)] hover:text-text-primary"
          >
            <CircleUser className="h-5 w-5" />
            <ChevronDown className="h-3 w-3" aria-hidden />
          </button>
          {menuOpen && (
            <div
              role="menu"
              className="absolute right-0 top-10 z-50 w-64 rounded border border-[var(--border-strong)] bg-[var(--surface-overlay)] p-1 shadow-[var(--shadow-panel)]"
            >
              <div className="px-3 py-2">
                <div className="truncate text-sm font-medium">{me.data?.name || 'Trader'}</div>
                <div className="truncate text-2xs text-text-muted">{me.data?.email ?? ''}</div>
              </div>
              <div className="my-1 border-t border-[var(--border-default)]" />
              <MenuLink to={ROUTES.settings} icon={Settings} onPick={() => setMenuOpen(false)}>
                Settings
              </MenuLink>
              <MenuLink
                to={ROUTES.verification}
                icon={ShieldCheck}
                onPick={() => setMenuOpen(false)}
              >
                Verification
              </MenuLink>
              <div className="my-1 border-t border-[var(--border-default)]" />
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  services.auth.signOut();
                  useSessionStore.getState().reset();
                }}
                className="flex w-full items-center gap-2 rounded px-3 py-1.5 text-left text-sm text-text-secondary hover:bg-[var(--surface-raised)] hover:text-text-primary"
              >
                <LogOut className="h-4 w-4" aria-hidden />
                Sign out
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

function MenuLink({
  to,
  icon: Icon,
  onPick,
  children,
}: {
  to: Route;
  icon: typeof Settings;
  onPick: () => void;
  children: ReactNode;
}) {
  const onClick = useLinkClick(to);
  return (
    <a
      href={to}
      role="menuitem"
      onClick={(event) => {
        onClick(event);
        onPick();
      }}
      className="flex items-center gap-2 rounded px-3 py-1.5 text-sm text-text-secondary hover:bg-[var(--surface-raised)] hover:text-text-primary"
    >
      <Icon className="h-4 w-4" aria-hidden />
      {children}
    </a>
  );
}

function Sidebar({
  route,
  collapsed,
  onToggleCollapsed,
  className,
  closeIcon = false,
}: {
  route: Route;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  className?: string;
  closeIcon?: boolean;
}) {
  const activeLogin = useSessionStore((s) => s.activeLogin);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  return (
    <nav
      aria-label="Client area"
      className={cn(
        'shrink-0 flex-col border-r border-[var(--border-default)] bg-[var(--background-primary)] transition-[width]',
        collapsed ? 'w-16' : 'w-64',
        className,
      )}
    >
      <div className="flex-1 overflow-y-auto py-3">
        {NAV.map((group) => {
          const isOpen = open[group.title] ?? true;
          return (
            <div key={group.title} className="mb-2">
              <button
                type="button"
                onClick={() => setOpen((o) => ({ ...o, [group.title]: !isOpen }))}
                aria-expanded={isOpen}
                className={cn(
                  'flex w-full items-center gap-3 px-4 py-2 text-sm font-medium text-text-primary hover:bg-[var(--surface-raised)]',
                  collapsed && 'justify-center px-0',
                )}
                title={group.title}
              >
                <group.icon className="h-4 w-4 shrink-0 text-text-secondary" aria-hidden />
                {!collapsed && <span className="flex-1 text-left">{group.title}</span>}
                {!collapsed && (
                  <ChevronDown
                    className={cn('h-3.5 w-3.5 transition-transform', !isOpen && '-rotate-90')}
                    aria-hidden
                  />
                )}
              </button>
              {isOpen &&
                group.items.map((item) => {
                  const active = item.to === route;
                  const href = item.to === 'terminal' ? terminalUrl(activeLogin) : item.to;
                  return (
                    <SidebarLink
                      key={item.label}
                      href={href}
                      external={item.to === 'terminal'}
                      active={active}
                      collapsed={collapsed}
                      icon={item.icon}
                      badge={item.badge}
                    >
                      {item.label}
                    </SidebarLink>
                  );
                })}
            </div>
          );
        })}
      </div>
      <div className="border-t border-[var(--border-default)] p-2">
        <button
          type="button"
          onClick={onToggleCollapsed}
          aria-label={closeIcon ? 'Close menu' : collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className="flex w-full items-center justify-center rounded p-2 text-text-secondary hover:bg-[var(--surface-raised)]"
        >
          {closeIcon ? (
            <X className="h-4 w-4" />
          ) : collapsed ? (
            <ChevronRight className="h-4 w-4" />
          ) : (
            <ChevronLeft className="h-4 w-4" />
          )}
        </button>
      </div>
    </nav>
  );
}

function SidebarLink({
  href,
  external,
  active,
  collapsed,
  icon: Icon,
  badge,
  children,
}: {
  href: string;
  external: boolean;
  active: boolean;
  collapsed: boolean;
  icon: typeof Wallet;
  badge?: string;
  children: ReactNode;
}) {
  const onClick = useLinkClick(href);
  return (
    <a
      href={href}
      onClick={external ? undefined : onClick}
      aria-current={active ? 'page' : undefined}
      title={collapsed ? String(children) : undefined}
      className={cn(
        'mx-2 my-0.5 flex items-center gap-3 rounded px-3 py-2 text-sm',
        collapsed ? 'justify-center px-0' : 'pl-11',
        active
          ? 'bg-[var(--surface-raised)] font-medium text-text-primary ring-1 ring-[var(--border-strong)]'
          : 'text-text-secondary hover:bg-[var(--surface-raised)] hover:text-text-primary',
      )}
    >
      {collapsed ? (
        <Icon className="h-4 w-4" aria-hidden />
      ) : (
        <>
          <span className="flex-1">{children}</span>
          {badge && (
            <span className="rounded-full bg-[rgba(var(--info-rgb),0.15)] px-2 py-0.5 text-2xs font-medium text-[var(--info)]">
              {badge}
            </span>
          )}
          {external && <ExternalLink className="h-3.5 w-3.5 text-text-muted" aria-hidden />}
        </>
      )}
    </a>
  );
}

/**
 * The onboarding prompt across the top of every page until the trader is
 * verified: what to do next, and a button that goes there.
 */
function VerificationBanner() {
  const verification = useVerification();
  const pathname = usePathname();
  const onVerification = useLinkClick(ROUTES.verification);
  const data = verification.data?.verification;
  if (!data || data.verified || resolveRoute(pathname) === ROUTES.verification) return null;
  const next = data.steps.find((s) => s.status !== 'verified');
  const message =
    data.level === 0
      ? 'Hello. Fill in your account details to make your first deposit'
      : next?.status === 'pending'
        ? 'Your documents are being reviewed — this usually takes under a minute here'
        : `Next step: ${next?.title.toLowerCase() ?? 'verification'} to raise your deposit limit`;
  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-[rgba(var(--warning-rgb),0.35)] bg-[rgba(var(--warning-rgb),0.10)] px-4 py-3 sm:px-6 lg:px-10">
      <span className="flex h-9 w-9 items-center justify-center rounded-full border-2 border-[rgba(var(--warning-rgb),0.6)] text-[var(--warning)]">
        <Clock className="h-4 w-4" aria-hidden />
      </span>
      <p className="flex-1 text-sm">{message}</p>
      <a
        href={ROUTES.verification}
        onClick={onVerification}
        className="rounded bg-[var(--brand-primary)] px-4 py-2 text-sm font-medium text-[var(--brand-primary-contrast)] hover:brightness-110"
      >
        {data.level === 0 ? 'Complete' : 'Continue'}
      </a>
    </div>
  );
}
