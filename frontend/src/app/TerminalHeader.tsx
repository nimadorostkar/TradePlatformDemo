import { useMemo, useState } from 'react';
import {
  ChevronDown,
  Command,
  LayoutGrid,
  LogOut,
  Maximize2,
  Moon,
  Sun,
  Wifi,
  WifiOff,
  CircleUser,
} from 'lucide-react';
import { cn } from '@/components/ui/cn';
import { BrandLogo } from '@/components/ui/BrandLogo';
import { Badge, Button, Money, Unavailable } from '@/components/ui/primitives';
import { useBrand } from '@/app/providers/brand-provider';
import { CreateAccountButton } from '@/features/auth/CreateAccountButton';
import { reportError, useServices } from '@/app/providers/services';
import { switchTradingAccount } from '@/app/account-switch';
import type { ConnectionState } from '@/integrations/gateway/websocket/subscription-pool';
import { useCapabilities } from '@/stores/capabilities-store';
import { useSessionStore } from '@/stores/session-store';
import { overallConnection, selectAccount, useTradingStore } from '@/stores/trading-store';
import { useSystemMessages } from '@/stores/system-messages-store';
import { useWorkspace } from '@/workspace/layout/workspace-store';
import { PanelsMenu } from '@/app/PanelsMenu';
import { AccountPicker } from '@/app/AccountPicker';
import { useAccountGroup } from '@/app/providers/use-account-group';
import {
  FUNDS_DESCRIPTION,
  FUNDS_LABEL,
  FUNDS_TONE,
  hasBadge,
  type AccountFunds,
} from '@/domain/account/account-environment';
import { useStaleBuildCheck } from '@/app/providers/useStaleBuildCheck';

/**
 * The terminal header.
 *
 * The connection badge is the single most important honest signal in the app:
 * it reports the WORST state across the account, position, and order streams,
 * so a partially-degraded session can never look fully healthy.
 */

const CONNECTION_LABEL: Record<ConnectionState, string> = {
  idle: 'Idle',
  connecting: 'Connecting',
  connected: 'Connected',
  reconnecting: 'Reconnecting',
  stale: 'Data stale',
  disconnected: 'Disconnected',
  'auth-expired': 'Session expired',
  failed: 'Connection failed',
};

const CONNECTION_TONE: Record<
  ConnectionState,
  'positive' | 'warning' | 'negative' | 'info' | 'neutral'
> = {
  idle: 'neutral',
  connecting: 'info',
  connected: 'positive',
  reconnecting: 'warning',
  stale: 'warning',
  disconnected: 'negative',
  'auth-expired': 'negative',
  failed: 'negative',
};

export function TerminalHeader({ onOpenCommandPalette }: { onOpenCommandPalette: () => void }) {
  const brand = useBrand();
  const services = useServices();

  const account = useTradingStore(selectAccount);
  const connection = useTradingStore(overallConnection);
  // A tab left open across a deploy keeps running the bundle it loaded. Nothing
  // on screen said so, and a tester on a warm tab reported a shipped feature as
  // missing.
  const staleBuild = useStaleBuildCheck();

  const accounts = useSessionStore((s) => s.accounts);
  const activeLogin = useSessionStore((s) => s.activeLogin);
  const setActiveAccount = useSessionStore((s) => s.setActiveAccount);
  const readOnly = useSessionStore((s) => s.readOnly);

  const theme = useWorkspace((s) => s.workspace.theme);
  const setTheme = useWorkspace((s) => s.setTheme);
  const savedLayouts = useWorkspace((s) => s.savedLayouts);
  const loadLayout = useWorkspace((s) => s.loadLayout);
  const resetToDefault = useWorkspace((s) => s.resetToDefault);
  const saveAs = useWorkspace((s) => s.saveAs);
  const workspaceName = useWorkspace((s) => s.workspace.name);

  const unreadErrors = useSystemMessages((s) => s.unreadErrorCount);
  const [layoutMenuOpen, setLayoutMenuOpen] = useState(false);
  const [panelsMenuOpen, setPanelsMenuOpen] = useState(false);
  const [logoFailed, setLogoFailed] = useState(false);
  // True while an account switch's token renewal is in flight; the selector is
  // disabled so a second switch cannot race the first.
  const [switching, setSwitching] = useState(false);

  const handleAccountChange = (nextLogin: string | null) => {
    if (nextLogin === null) {
      setActiveAccount(null);
      return;
    }
    if (nextLogin === activeLogin || switching) return;
    setSwitching(true);
    // Renew-verify-activate; on failure the switch is cancelled — the select
    // is controlled by activeLogin, so it simply snaps back — and the reason
    // lands in the system messages.
    void switchTradingAccount(services.auth, nextLogin)
      .catch((error: unknown) => reportError('account-switch', error))
      .finally(() => setSwitching(false));
  };

  // Fetched once for the whole header and handed to the badge, which stays a
  const isOffline = typeof navigator !== 'undefined' && !navigator.onLine;
  const effectiveConnection: ConnectionState = isOffline ? 'disconnected' : connection;

  const currency = account?.currency ?? null;

  const accountOptions = useMemo(() => accounts.filter((a) => a.enabled), [accounts]);
  // What the SERVER says the active account is. Never inferred here.
  const activeFunds = accountOptions.find((o) => o.login === activeLogin)?.kind ?? 'unknown';
  // Fetched once for the header; the badge stays presentational.
  const accountGroup = useAccountGroup(account?.login ?? null);

  // Below lg the mobile shell is active: the metrics strip and the
  // desktop-only workspace controls are hidden (the Account tab carries the
  // figures), and whatever still cannot fit scrolls INSIDE the header rather
  // than stretching the document sideways (BLK-02).
  return (
    <header className="flex h-11 shrink-0 items-center gap-3 border-b border-[var(--border-default)] bg-[var(--background-secondary)] px-3 max-lg:gap-2 max-lg:overflow-x-auto max-lg:px-2">
      {staleBuild && (
        <button
          onClick={() => window.location.reload()}
          title="This tab is running an older build. Reload to get the current one."
          className="shrink-0 rounded bg-[var(--warning)] px-1.5 py-0.5 text-2xs font-medium text-black hover:brightness-110"
        >
          Update available — reload
        </button>
      )}
      <div className="flex shrink-0 items-center gap-2">
        {/* The compact wordmark; a broken asset falls back to the text name. */}
        <BrandLogo variant="compact" className="h-5 w-auto" onFail={() => setLogoFailed(true)} />
        {/* The document's h1 (MED-12): heading structure used to start at the
            widgets' h3s, leaving a screen reader with no page-level anchor.
            Visually identical to the span it replaces. */}
        {/* Visually dropped below lg — the ~80px it takes is what pushed the
            LIVE badge and the session controls off a 390px screen — but kept
            as the document h1 for screen readers (MED-12). The wordmark already
            spells the name, so the text only shows when the logo could not. */}
        <h1
          className={cn(
            'text-xs font-semibold tracking-tight max-lg:sr-only',
            !logoFailed && 'sr-only',
          )}
        >
          {brand.platformName}
        </h1>
      </div>

      {/* shrink-0 on BOTH shells. Below lg this group used to carry min-w-0,
          which let flex shrink it under its own content — the badges kept
          their width and painted straight under the session buttons. With the
          natural width kept, a header that is genuinely too narrow scrolls
          (BLK-02) instead of overlapping. */}
      <div className="flex shrink-0 items-center gap-1.5">
        <AccountPicker
          options={accountOptions}
          activeLogin={activeLogin}
          disabled={switching}
          onSelect={handleAccountChange}
        />

        {/* A selector with nothing in it is a dead end; this is the one place a
            trader looks when they expect an account and have none. Suppressed
            while a fast-booted account is active — that trader has one. */}
        {accountOptions.length === 0 && activeLogin === null && (
          <CreateAccountButton variant="primary" size="xs" />
        )}

        {account?.server && (
          <span className="text-2xs text-text-muted max-lg:hidden">{account.server}</span>
        )}

        <Badge tone={CONNECTION_TONE[effectiveConnection]}>
          <span
            className={cn('mr-1 inline-flex', effectiveConnection === 'connected' && 'max-lg:mr-0')}
          >
            {effectiveConnection === 'connected' ? (
              <Wifi className="h-2.5 w-2.5" aria-hidden />
            ) : (
              <WifiOff className="h-2.5 w-2.5" aria-hidden />
            )}
          </span>
          {/* On the phone the healthy state is the green icon alone — the word
              "Connected" adds nothing the colour does not. Every OTHER state
              keeps its words at any width: "Reconnecting" and "Session
              expired" are exactly the labels a trader must be able to read. */}
          <span className={cn(effectiveConnection === 'connected' && 'max-lg:hidden')}>
            {isOffline ? 'Offline' : CONNECTION_LABEL[effectiveConnection]}
          </span>
        </Badge>

        {readOnly && <Badge tone="warning">Read-only</Badge>}

        {/* MED-11: a switch takes seconds (a CRM re-authorization sits in the
            middle) and used to show nothing at all — the trader stared at the
            OLD account's figures wondering whether the click registered. */}
        {switching && <Badge tone="info">Switching…</Badge>}

        <EnvironmentBadge funds={activeFunds} group={accountGroup} />
      </div>

      <div
        className={cn(
          'flex min-w-0 flex-1 items-center gap-4 overflow-x-auto max-lg:hidden',
          // Pulsing figures say "in transit"; frozen ones would say "current".
          // `switching` alone stopped the moment the token renewal resolved,
          // which is long before the new account's snapshot lands — so the
          // pulse ran out while the figures were still dashes. It now lasts
          // until there is something true to show.
          (switching || (activeLogin !== null && account === null)) && 'animate-pulse opacity-50',
        )}
      >
        <Metric label="Balance">
          {account ? <Money value={account.balance} currency={currency} /> : <Unavailable />}
        </Metric>
        <Metric label="Equity">
          {account ? <Money value={account.equity} currency={currency} /> : <Unavailable />}
        </Metric>
        <Metric label="P/L">
          {account ? (
            <Money value={account.profit} currency={currency} colorBySign />
          ) : (
            <Unavailable />
          )}
        </Metric>
        <Metric label="Free margin">
          {account ? <Money value={account.marginFree} currency={currency} /> : <Unavailable />}
        </Metric>
        <Metric label="Margin level">
          {account?.marginLevel ? (
            <span className="tabular">{Number(account.marginLevel).toFixed(1)}%</span>
          ) : (
            <Unavailable label="No margin in use" />
          )}
        </Metric>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        {brand.depositUrl && (
          <Button
            size="xs"
            variant="primary"
            onClick={() => window.open(brand.depositUrl, '_blank', 'noopener,noreferrer')}
          >
            Deposit
          </Button>
        )}

        {/* Command palette, panels and layouts drive the DESKTOP workspace
            shell; the five-tab mobile shell has none of those concepts, and
            fullscreen on a phone is the browser's job. Hiding them is what
            lets the header fit a 390 px viewport (BLK-02). */}
        <Button
          size="xs"
          variant="ghost"
          onClick={onOpenCommandPalette}
          title="Command palette (⌘K)"
          className="max-lg:hidden"
        >
          <Command className="h-3 w-3" aria-hidden />
        </Button>

        <div className="max-lg:hidden">
          <PanelsMenu
            open={panelsMenuOpen}
            onOpenChange={(open) => {
              setPanelsMenuOpen(open);
              // Two dropdowns stacked over the chart is never intended.
              if (open) setLayoutMenuOpen(false);
            }}
          />
        </div>

        <div className="relative max-lg:hidden">
          <Button
            size="xs"
            variant="ghost"
            onClick={() => {
              setLayoutMenuOpen((open) => !open);
              setPanelsMenuOpen(false);
            }}
            aria-expanded={layoutMenuOpen}
            aria-haspopup="menu"
          >
            <LayoutGrid className="h-3 w-3" aria-hidden />
            <span className="max-w-20 truncate">{workspaceName}</span>
            <ChevronDown className="h-2.5 w-2.5" aria-hidden />
          </Button>
          {layoutMenuOpen && (
            <div
              role="menu"
              className="absolute right-0 top-7 z-50 w-48 rounded border border-[var(--border-strong)] bg-[var(--surface-overlay)] p-1 shadow-[var(--shadow-panel)]"
            >
              {savedLayouts.map((layout) => (
                <button
                  key={layout.id}
                  role="menuitem"
                  onClick={() => {
                    void loadLayout(layout.id);
                    setLayoutMenuOpen(false);
                  }}
                  className="block w-full truncate rounded px-2 py-1 text-left text-2xs hover:bg-[var(--surface-raised)]"
                >
                  {layout.name}
                </button>
              ))}
              {savedLayouts.length > 0 && (
                <div className="my-1 border-t border-[var(--border-default)]" />
              )}
              {/* MED-09: the menu implied multiple workspaces existed but
                  offered no way to create one — the save action lived only in
                  the command palette, which a mouse-first trader never opens. */}
              <button
                role="menuitem"
                onClick={() => {
                  const name = window.prompt('Layout name');
                  if (name) void saveAs(name);
                  setLayoutMenuOpen(false);
                }}
                className="block w-full rounded px-2 py-1 text-left text-2xs hover:bg-[var(--surface-raised)]"
              >
                Save layout as…
              </button>
              <button
                role="menuitem"
                onClick={() => {
                  resetToDefault();
                  setLayoutMenuOpen(false);
                }}
                className="block w-full rounded px-2 py-1 text-left text-2xs hover:bg-[var(--surface-raised)]"
              >
                Reset to default layout
              </button>
            </div>
          )}
        </div>

        {/* The two icon buttons that survive into the phone shell get a
            40px hit area there (they measured 28x24 — fine for a pointer,
            small for a thumb next to a sign-out). Icons keep their size. */}
        <Button
          size="xs"
          variant="ghost"
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
          className="max-lg:h-10 max-lg:w-10"
        >
          {theme === 'dark' ? <Sun className="h-3 w-3" /> : <Moon className="h-3 w-3" />}
        </Button>

        <Button
          size="xs"
          variant="ghost"
          onClick={() => void document.documentElement.requestFullscreen?.().catch(() => undefined)}
          aria-label="Enter full screen"
          className="max-lg:hidden"
        >
          <Maximize2 className="h-3 w-3" aria-hidden />
        </Button>

        {unreadErrors > 0 && (
          <Badge tone="negative" className={cn('tabular')}>
            {unreadErrors}
          </Badge>
        )}

        {/* The personal area: accounts, deposits, verification, profile. */}
        <a
          href="/pa/trading/accounts"
          aria-label="Personal area"
          title="Personal area"
          className="inline-flex h-7 items-center justify-center rounded px-2 text-text-secondary hover:bg-[var(--surface-raised)] hover:text-text-primary max-lg:h-10 max-lg:w-10"
        >
          <CircleUser className="h-3.5 w-3.5" aria-hidden />
        </a>

        <Button
          size="xs"
          variant="ghost"
          onClick={() => {
            services.auth.signOut();
            useSessionStore.getState().reset();
          }}
          aria-label="Sign out"
          className="max-lg:h-10 max-lg:w-10"
        >
          <LogOut className="h-3 w-3" aria-hidden />
        </Button>
      </div>
    </header>
  );
}

function Metric({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex shrink-0 items-baseline gap-1.5 whitespace-nowrap">
      <span className="text-2xs text-text-muted">{label}</span>
      <span className="text-xs font-medium">{children}</span>
    </div>
  );
}

/**
 * The environment/live-money badge (ENV-001).
 *
 * Sourced from the GATEWAY's own capability report, not from build-time
 * variables: whatever deployment the app actually reached is the one it warns
 * about. Live money always shows a warning-toned "LIVE" badge; a demo gateway
 * shows a neutral one; a gateway that predates the environment block shows
 * nothing rather than guessing.
 */
/** Exported for tests; the header renders it directly. */
export const EnvironmentBadgeForTest = EnvironmentBadge;

function EnvironmentBadge({ funds, group = null }: { funds: AccountFunds; group?: string | null }) {
  const environment = useCapabilities((s) => s.capabilities.environment);
  const account = useTradingStore(selectAccount);
  if (!environment) return null;

  // NO BADGE when the server has not stated what this account is.
  //
  // The badge used to read LIVE for every account because it came from one
  // deployment-wide variable, and the 2026-08-26 retest was right that the
  // unsafe DEFAULT is the defect rather than the missing field: "LIVE" over a
  // demo account, or the reverse, is a misrepresentation on the screen where
  // money moves, and it is the guess that cannot be walked back. Saying
  // nothing is the only honest thing left when nothing is known.
  if (!hasBadge(funds)) return null;

  const kind = funds as Exclude<AccountFunds, 'unknown'>;

  // The warning NAMES the account it is about.
  //
  // It described only the deployment before, and a deployment is not what a
  // trader risks money on: one gateway serves many accounts. Read against a
  // hostname containing the word "stage", "REAL MONEY" looked like a
  // mislabelling rather than a statement about the account in the ticket — so
  // it was filed as a bug and traded through for a session (2026-08-21). It is
  // much harder to dismiss a warning that names the account you are looking at.
  //
  // The MT5 GROUP is named too, because it is the identifier a trader can
  // quote to their broker to settle what kind of account this is.
  const subject = account
    ? `account ${account.name} (#${account.login})${account.server ? ` on ${account.server}` : ''}`
    : 'this connection';
  const title = [
    `${FUNDS_DESCRIPTION[kind]} — ${subject}`,
    group ? `MT5 group ${group}` : null,
    `${environment.name} gateway`,
    environment.mt5Server,
    environment.buildSha ? `build ${environment.buildSha.slice(0, 9)}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <span title={title} aria-label={title} className="inline-flex">
      <Badge tone={FUNDS_TONE[kind]}>
        {FUNDS_LABEL[kind]}
        {environment.name && environment.name !== 'production' ? ` · ${environment.name}` : ''}
      </Badge>
    </span>
  );
}
