import { Component, useEffect, useState, type ErrorInfo, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { env } from '@/app/config/env';
import { BrandProvider } from '@/app/providers/BrandProvider';
import { ServicesProvider } from '@/app/providers/ServicesProvider';
import { useServices } from '@/app/providers/services';
import { TradingTerminalPage } from '@/app/TradingTerminalPage';
import { SignInScreen } from '@/features/auth/SignInScreen';
import { Button, ErrorState } from '@/components/ui/primitives';
import { BrandedLoader } from '@/components/ui/BrandedLoader';
import { TradingError } from '@/domain/common/errors';
import {
  assertNoTokenInUrl,
  awaitHostSession,
  sanitizedCredentialUrl,
} from '@/integrations/gateway/auth/host-bootstrap';
import { parseJwtAccounts } from '@/integrations/gateway/auth/auth-session';
import { forgetAccountSnapshot, recallLastAccount, useSessionStore } from '@/stores/session-store';
import { useCapabilities } from '@/stores/capabilities-store';
import { useSystemMessages } from '@/stores/system-messages-store';
import { useTradingStore } from '@/stores/trading-store';
import { quoteStore } from '@/stores/quote-store';
import { useWorkspace } from '@/workspace/layout/workspace-store';
import {
  canRetrySessionRenewal,
  armSessionRenewal,
  validateGatewayToken,
  SESSION_RENEW_RETRY_MS,
  SESSION_VALIDATE_INTERVAL_MS,
} from '@/app/providers/session-renewal';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Trading data comes from the WebSocket, not from polling. Query is used
      // for reference data (symbols, history) where refetch-on-focus is noise.
      refetchOnWindowFocus: false,
      retry: 1,
      staleTime: 30_000,
    },
    mutations: {
      // A trade mutation is NEVER retried automatically.
      retry: false,
    },
  },
});

export function App() {
  // The server answers every path with this application (SPA fallback), so an
  // address that names no real view rendered the full terminal with a 200 —
  // no 404 existed anywhere (HGH-03). App state lives in the QUERY STRING;
  // any other path is by definition not a page.
  if (window.location.pathname !== '/' && window.location.pathname !== '/index.html') {
    return <NotFoundScreen />;
  }
  return (
    <RootErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <ServicesProvider>
          <BrandProvider>
            <AuthenticatedApp />
          </BrandProvider>
        </ServicesProvider>
      </QueryClientProvider>
    </RootErrorBoundary>
  );
}

function NotFoundScreen() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 bg-[var(--background-primary)] p-6 text-center">
      <h1 className="text-lg font-semibold">Page not found</h1>
      <p className="max-w-sm text-xs text-text-muted">
        This address does not exist. The terminal lives at the root of this site.
      </p>
      <Button variant="primary" size="md" onClick={() => window.location.replace('/')}>
        Open the terminal
      </Button>
    </div>
  );
}

/**
 * Exported for testing: it owns the gate between "signed in" and the terminal,
 * which is where a premature empty state is most costly.
 */
export function AuthenticatedApp() {
  const services = useServices();
  const status = useSessionStore((s) => s.status);
  const activeLogin = useSessionStore((s) => s.activeLogin);
  const accountsStatus = useSessionStore((s) => s.accountsStatus);
  const accountsError = useSessionStore((s) => s.accountsError);
  // Bumped by the retry control; the account-loading effect depends on it so a
  // retry actually re-runs the request rather than only resetting the label.
  const [accountsAttempt, setAccountsAttempt] = useState(0);
  const hydrated = useWorkspace((s) => s.hydrated);
  const hydrate = useWorkspace((s) => s.hydrate);
  const workspaceSyncEnabled = useCapabilities((s) => s.capabilities.workspace.enabled);

  // Auth is a hard data boundary. The terminal unmounts while signed out, but
  // its global stores otherwise survive and can flash the previous trader's
  // balances/positions when a new session mounts. Wipe every account-scoped
  // cache whenever authentication is absent or being established.
  useEffect(() => {
    if (status === 'signed-in') return;
    const generation = services.generations.advance();
    useTradingStore.getState().resetForAccountSwitch(generation);
    quoteStore.clear();
    services.symbolCache.clear();
    useCapabilities.getState().reset();
    queryClient.clear();
  }, [status, services]);

  // Restore the saved workspace before the shell renders, so panels do not
  // flash the default layout and then jump.
  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  // Bootstrap: refuse a URL-borne credential, restore the cookie-held session
  // if the gateway has one (AUTH-001 — this is what makes a reload land back
  // in the terminal instead of on the sign-in screen), then fall back to a
  // host session. The sign-in screen renders only after every restoration
  // path has definitively come up empty.
  useEffect(() => {
    const session = useSessionStore.getState();

    try {
      assertNoTokenInUrl(window.location.search);
    } catch (error) {
      // Rejecting the credential is not enough: remove it from the address bar
      // so it cannot remain in browser history, copied URLs, or later requests.
      window.history.replaceState(
        window.history.state,
        '',
        sanitizedCredentialUrl(window.location.href),
      );
      useSystemMessages.getState().pushError('auth', TradingError.from(error));
    }

    const existing = services.tokens.get();
    if (existing) {
      session.setStatus('signed-in');
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const restored = await services.auth.restore();
        if (cancelled) return;
        if (restored) {
          if (restored.username) session.setUsername(restored.username);
          session.setStatus('signed-in');
          return;
        }
      } catch {
        // restore() never throws by contract, but a boot path must not be
        // able to strand the app in `initialising` regardless.
      }

      const message = await awaitHostSession({ allowedOrigins: env().allowedHostOrigins });
      if (cancelled) return;
      if (!message) {
        session.setStatus('signed-out');
        return;
      }
      try {
        await services.auth.signInWithCrmToken(message.crmToken, message.username ?? '');
        if (!cancelled) session.setStatus('signed-in');
      } catch (error) {
        if (cancelled) return;
        useSystemMessages.getState().pushError('auth', TradingError.from(error));
        session.setStatus('signed-out');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [services]);

  // MED-02: an un-remembered session signs itself out after an hour without
  // any input. The last-activity stamp is SHARED across tabs via localStorage,
  // so a background tab cannot sign out a trader who is active in another —
  // and a trader passively watching a chart forfeits only the un-remembered
  // session they explicitly chose not to persist.
  useEffect(() => {
    if (status !== 'signed-in') return;
    if (services.auth.remembered?.() === true) return;

    const KEY = 'tradeplatform.last-activity';
    const IDLE_LIMIT_MS = 60 * 60 * 1000;
    let lastWrite = 0;

    const touch = () => {
      const now = Date.now();
      if (now - lastWrite < 30_000) return; // storage writes throttled
      lastWrite = now;
      try {
        localStorage.setItem(KEY, String(now));
      } catch {
        /* storage blocked: the in-memory fallback below still applies */
      }
    };
    touch();

    const events: (keyof WindowEventMap)[] = ['pointerdown', 'keydown', 'wheel', 'touchstart'];
    for (const name of events) window.addEventListener(name, touch, { passive: true });

    const interval = setInterval(() => {
      let last = lastWrite;
      try {
        const shared = Number(localStorage.getItem(KEY));
        if (Number.isFinite(shared) && shared > last) last = shared;
      } catch {
        /* fall back to this tab's own record */
      }
      if (Date.now() - last > IDLE_LIMIT_MS) {
        services.auth.signOut();
        useSessionStore.getState().reset();
        useSessionStore
          .getState()
          .setStatus('expired', 'You were signed out after an hour of inactivity.');
      }
    }, 60_000);

    return () => {
      clearInterval(interval);
      for (const name of events) window.removeEventListener(name, touch);
    };
  }, [status, services]);

  // Ask the gateway what it can do before any optional feature is offered.
  useEffect(() => {
    if (status !== 'signed-in') return;
    const controller = new AbortController();
    void services.capabilities.fetch(controller.signal).then((capabilities) => {
      if (!controller.signal.aborted) useCapabilities.getState().set(capabilities);
    });
    return () => controller.abort();
  }, [status, services]);

  // The gateway has no refresh-token endpoint, but a still-valid CRM token can
  // mint a new gateway JWT. Renew before expiry and let TokenStore reconnect
  // every WebSocket with the replacement credential. Transient renewal
  // failures retry only while the current JWT remains valid.
  useEffect(() => {
    if (status !== 'signed-in') return;

    const controller = new AbortController();
    let cancelArm: (() => void) | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const expire = () => {
      if (controller.signal.aborted) return;
      useSessionStore
        .getState()
        .setStatus('expired', 'Your session could not be renewed. Please sign in again.');
    };

    const arm = (minDelayMs = 0) => {
      if (controller.signal.aborted) return;
      cancelArm?.();
      cancelArm = armSessionRenewal(services.tokens.get()?.expiresAt ?? null, () => void renew(), {
        minDelayMs,
      });
    };

    const renew = async () => {
      const renewed = await services.auth.renew(controller.signal);
      if (controller.signal.aborted) return;

      if (renewed) {
        // The renewed JWT can add or remove account claims. Re-fetch the CRM
        // list through the new claim filter before allowing the old selector
        // state to continue driving account-scoped requests. (The token-store
        // subscription below re-arms the schedule from the fresh expiry.)
        setAccountsAttempt((attempt) => attempt + 1);
        return;
      }

      const expiresAt = services.tokens.get()?.expiresAt ?? null;
      if (canRetrySessionRenewal(expiresAt)) {
        retryTimer = setTimeout(
          () => void renew(),
          Math.min(SESSION_RENEW_RETRY_MS, Math.max(0, expiresAt! - Date.now())),
        );
      } else {
        expire();
      }
    };

    // Every token replacement — a scheduled renewal, an account switch, a
    // restored session — re-arms from the store's CURRENT expiry. Without
    // this, a switch that renews outside this effect would leave the pending
    // timer holding the PREVIOUS token's schedule. The floor stops a
    // malformed or unexpectedly short replacement from creating a zero-delay
    // request loop.
    const unsubscribe = services.tokens.subscribe(() => arm(SESSION_RENEW_RETRY_MS));
    arm();

    return () => {
      controller.abort();
      cancelArm?.();
      if (retryTimer !== null) clearTimeout(retryTimer);
      unsubscribe();
    };
  }, [status, services]);

  // Actively verify the JWT every 20 minutes. With month-long tokens, expiry
  // is no longer how a session usually dies — a rotated JWT secret or a
  // server-side invalidation would otherwise surface only when the trader
  // next touched an authenticated route. A definitive rejection gets one
  // silent renewal attempt (the CRM token may still be good) before the
  // session is declared expired; network trouble proves nothing about the
  // token and is ignored.
  useEffect(() => {
    if (status !== 'signed-in') return;

    const controller = new AbortController();

    const check = async () => {
      const validity = await validateGatewayToken(services.http, controller.signal);
      if (controller.signal.aborted || validity !== 'invalid') return;

      const renewed = await services.auth.renew(controller.signal);
      if (controller.signal.aborted) return;
      if (renewed) {
        // Same reason as scheduled renewal: the replacement JWT can carry a
        // different accounts claim.
        setAccountsAttempt((attempt) => attempt + 1);
        return;
      }
      useSessionStore
        .getState()
        .setStatus('expired', 'Your session is no longer valid. Please sign in again.');
    };

    const interval = setInterval(() => void check(), SESSION_VALIDATE_INTERVAL_MS);
    return () => {
      controller.abort();
      clearInterval(interval);
    };
  }, [status, services]);

  // Pull the server-stored layout once BOTH the account and the capability are
  // known — either one alone leaves the sync inert, and the store's own guard
  // means a premature call cannot push the default layout over a real one.
  useEffect(() => {
    if (!activeLogin || !workspaceSyncEnabled) return;
    services.workspaceStore.reset();
    void useWorkspace.getState().resync();
  }, [activeLogin, workspaceSyncEnabled, services]);

  // Once signed in, load the account list and select one. Before the list
  // resolves, a restored session adopts the account snapshot remembered from
  // its last visit — that is what lets the terminal (above all the chart)
  // render in ~0.5 s instead of waiting the measured 5.7–12 s for the CRM
  // account list. The list remains authoritative and reconciles below.
  useEffect(() => {
    if (status !== 'signed-in') return;

    const controller = new AbortController();
    // The JWT accounts claim scopes the fast boot to the signed-in USER: a
    // browser previously used by someone else must not boot their account.
    const gatewayToken = services.tokens.get()?.gatewayToken;
    useSessionStore
      .getState()
      .adoptRecalledAccount(gatewayToken ? parseJwtAccounts(gatewayToken) : []);
    useSessionStore.getState().setAccountsStatus('loading');

    void services.auth
      .listAccounts(controller.signal)
      .then((accounts) => {
        if (controller.signal.aborted) return;
        const session = useSessionStore.getState();
        session.setAccounts(accounts);
        session.setAccountsStatus('ready');

        if (
          session.activeLogin === null ||
          !accounts.some((account) => account.login === session.activeLogin)
        ) {
          // Prefer the account the trader last worked in (a restored session
          // should land where the reload happened), falling back to the first.
          const remembered = recallLastAccount();
          const preferred =
            remembered !== null && accounts.some((account) => account.login === remembered)
              ? remembered
              : (accounts[0]?.login ?? null);
          session.setActiveAccount(preferred);
        } else {
          // The active login is in the list — but it may be running on an
          // adopted snapshot. Re-applying it rebuilds the suffix policy and
          // read-only flag from the authoritative row, so a snapshot can be
          // stale for at most the account-list latency.
          session.setActiveAccount(session.activeLogin);
        }
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const tradingError = TradingError.from(error);
        // An UNAUTHORIZED lookup means the CRM token is dead (it is much
        // shorter-lived than the 30-day gateway JWT, so a restored session can
        // carry a stale one). Retrying can never fix it, and the error screen
        // has no other exit — a trader got stranded on exactly that dead end.
        // The only honest recovery is a clean sign-out to the sign-in screen.
        if (tradingError.kind === 'unauthorized') {
          useSystemMessages.getState().pushError('accounts', tradingError);
          forgetAccountSnapshot();
          services.auth.signOut();
          useSessionStore.getState().reset();
          return;
        }
        // Any other failure (CRM down, network) is retryable. A failed lookup
        // is NOT "you have no accounts"; recording it as an error keeps the
        // two apart on screen.
        useSessionStore.getState().setAccountsStatus('error', tradingError.message);
        useSystemMessages.getState().pushError('accounts', tradingError);
      });

    return () => controller.abort();
  }, [status, services, accountsAttempt]);

  if (status === 'initialising' || !hydrated) {
    return <BrandedLoader label="Starting terminal…" />;
  }

  if (status === 'signed-out' || status === 'signing-in') {
    return <SignInScreen />;
  }

  if (status === 'expired') {
    return <SessionExpired />;
  }

  // An adopted account snapshot renders the terminal immediately; the gates
  // below apply only when no account could be adopted (first visit on this
  // browser, cleared storage). With an active account, a still-loading list
  // is invisible and a failed list surfaces through system messages inside
  // the terminal rather than replacing a working chart with an error screen.
  if (!activeLogin && (accountsStatus === 'idle' || accountsStatus === 'loading')) {
    return <BrandedLoader label="Loading your accounts…" />;
  }

  if (!activeLogin && accountsStatus === 'error') {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <ErrorState
          title="Could not load your accounts"
          description={accountsError ?? 'The account service did not respond.'}
          onRetry={() => {
            useSessionStore.getState().setAccountsStatus('idle');
            setAccountsAttempt((attempt) => attempt + 1);
          }}
        />
      </div>
    );
  }

  // Only now is the list genuinely known to be empty.
  if (!activeLogin) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6">
        <ErrorState
          title="No tradable account"
          description="No account on this profile is supported by the terminal. Open one to start trading, or contact support if you expect one already."
        />
        <CreateAccountButton variant="primary" />
      </div>
    );
  }

  return <TradingTerminalPage />;
}

function SessionExpired() {
  const services = useServices();
  const setStatus = useSessionStore((s) => s.setStatus);

  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="max-w-sm text-center">
        <h1 className="text-sm font-semibold">Your session has expired</h1>
        <p className="mt-1 text-xs text-text-muted">
          The trading server no longer accepts this session. Sign in again to continue.
        </p>
        <div className="mt-4 flex items-center justify-center gap-2">
          <Button
            variant="primary"
            size="md"
            onClick={() => {
              services.auth.signOut();
              useSessionStore.getState().reset();
              setStatus('signed-out');
            }}
          >
            Sign in again
          </Button>
          {/* Someone whose session died may not have an account to sign back
              into — a brand-new visitor reaches this screen too. */}
          <CreateAccountButton />
        </div>
      </div>
    </div>
  );
}

import { isStaleChunkError, reloadForStaleChunk } from '@/app/stale-chunk';
import { CreateAccountButton } from '@/features/auth/CreateAccountButton';

interface BoundaryState {
  error: Error | null;
}

/**
 * The last line of defence. A crash here means the terminal is unusable, so it
 * offers a reload rather than a blank page.
 */
class RootErrorBoundary extends Component<{ children: ReactNode }, BoundaryState> {
  override state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // A stale lazy chunk after a redeploy is not a crash, it is a version
    // skew: the running shell asked for an asset the new release replaced.
    // One automatic reload picks up the current shell; the sessionStorage
    // stamp stops a broken deploy from reload-looping — the second failure
    // inside a minute falls through to the error screen.
    if (isStaleChunkError(error) && reloadForStaleChunk()) return;
    // The last resort: nothing else is left to report through.
    console.error('Terminal crashed', error, info.componentStack);
  }

  override render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="flex h-full items-center justify-center bg-[var(--background-primary)] p-6">
          <ErrorState
            title="The terminal stopped unexpectedly"
            description={this.state.error.message}
            onRetry={() => window.location.reload()}
          />
        </div>
      );
    }
    return this.props.children;
  }
}
