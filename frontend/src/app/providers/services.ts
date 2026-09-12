import { createContext, useContext } from 'react';
import { env } from '@/app/config/env';
import { GatewayHttpClient } from '@/integrations/gateway/api/http-client';
import { MarketApi } from '@/integrations/gateway/api/market-api';
import { TradingApi } from '@/integrations/gateway/api/trading-api';
import { CapabilitiesApi } from '@/integrations/gateway/api/capabilities';
import { FeaturesApi } from '@/integrations/gateway/api/features-api';
import { useCapabilities } from '@/stores/capabilities-store';
import { CrmAuthSession } from '@/integrations/gateway/auth/crm-session';
import { TokenStore } from '@/integrations/gateway/auth/token-store';
import { GatewaySubscriptionPool } from '@/integrations/gateway/websocket/subscription-pool';
import { SessionGenerationTracker } from '@/integrations/gateway/websocket/session-generation';
import { TradingService } from '@/domain/orders/trading-service';
import { LocalWorkspaceStore } from '@/workspace/persistence/storage';
import { SyncedWorkspaceStore } from '@/workspace/persistence/synced-store';
import {
  mergeRemoteJournal,
  readJournalEntries,
  setJournalSyncHook,
} from '@/features/journal/journal-store';
import { installWorkspaceStore } from '@/workspace/layout/workspace-store';
import { useSessionStore } from '@/stores/session-store';
import { useSystemMessages } from '@/stores/system-messages-store';
import { TradingError } from '@/domain/common/errors';
import { createUnauthorizedHandler } from '@/app/providers/unauthorized-policy';
import type { TradingSymbol } from '@/domain/common/models';

/**
 * The application service container.
 *
 * Constructed once and provided through context. Everything below reads its
 * mutable inputs (token, active login, suffix policy) through GETTERS rather
 * than captured values, so an account switch does not require rebuilding the
 * whole graph — which would drop every open WebSocket.
 */

export interface Services {
  http: GatewayHttpClient;
  market: MarketApi;
  trading: TradingApi;
  capabilities: CapabilitiesApi;
  features: FeaturesApi;
  workspaceStore: SyncedWorkspaceStore;
  tradingService: TradingService;
  auth: CrmAuthSession;
  tokens: TokenStore;
  pool: GatewaySubscriptionPool;
  generations: SessionGenerationTracker;
  /** Symbol metadata cache, keyed by DISPLAY name. */
  symbolCache: Map<string, TradingSymbol>;
  /** Set by the terminal so trade mutations can trigger reconciliation. */
  setReconciler: (reconcile: (reason: string) => void) => void;
}

/** Provided by <ServicesProvider> (ServicesProvider.tsx); read with useServices. */
export const ServicesContext = createContext<Services | null>(null);

export function useServices(): Services {
  const services = useContext(ServicesContext);
  if (!services) throw new Error('useServices must be used inside <ServicesProvider>');
  return services;
}

export function createServices(): Services {
  const config = env();

  const tokens = new TokenStore({ legacyStorage: config.enableLegacyAuthStorage });
  const generations = new SessionGenerationTracker();
  const symbolCache = new Map<string, TradingSymbol>();

  let reconcile: (reason: string) => void = () => {};

  // Forward reference: the 401 handler renews through `auth`, and `auth` is
  // built from the same token store the handler reads. One of the two has to
  // be declared first, and splitting the graph to avoid it would buy nothing.
  let auth: CrmAuthSession | null = null;

  const http = new GatewayHttpClient({
    baseUrl: config.gatewayHttpUrl,
    getToken: () => tokens.gatewayToken(),
    // A 401 gets one silent renewal before the session is declared over — see
    // unauthorized-policy.ts for why, and for what stops it looping.
    onUnauthorized: createUnauthorizedHandler({
      currentToken: () => tokens.gatewayToken(),
      renew: async () => (await auth?.renew())?.gatewayToken ?? null,
      onExpired: (error) => {
        useSessionStore.getState().setStatus('expired', error.message);
        useSystemMessages.getState().pushError('auth', error);
      },
    }),
  });

  const market = new MarketApi(http);
  const capabilities = new CapabilitiesApi(http);
  const features = new FeaturesApi(http);
  // Idempotency is only claimed when the gateway says it deduplicates; a key
  // sent to a server that ignores it would imply a guarantee we do not have.
  const trading = new TradingApi(
    http,
    () => useCapabilities.getState().capabilities.tradeIdempotency.enabled,
  );

  // Layouts always persist locally; this only adds the server mirror, and only
  // while the gateway says it stores workspaces.
  const workspaceStore = new SyncedWorkspaceStore({
    local: new LocalWorkspaceStore(),
    remote: features,
    getLogin: () => useSessionStore.getState().activeLogin,
    isEnabled: () => useCapabilities.getState().capabilities.workspace.enabled,
    onError: (error) =>
      useSystemMessages.getState().pushError('workspace', TradingError.from(error)),
    // Journal notes ride in the same bundle (MED-07), so they follow the
    // account like every other piece of workspace state.
    readJournal: () => readJournalEntries(),
    applyJournal: (entries) => mergeRemoteJournal(entries),
  });
  installWorkspaceStore(workspaceStore);
  // A note edit schedules a push exactly like a layout change.
  setJournalSyncHook(() => workspaceStore.notifyExternalChange());

  const pool = new GatewaySubscriptionPool({
    baseWsUrl: config.gatewayWsUrl,
    getToken: () => tokens.gatewayToken(),
    staleAfterMs: config.quoteStaleAfterMs,
  });

  auth = new CrmAuthSession({
    gatewayBaseUrl: config.gatewayHttpUrl,
    crmBaseUrl: config.crmHttpUrl,
    tokenStore: tokens,
  });

  const tradingService = new TradingService({
    trading,
    market,
    getLogin: () => useSessionStore.getState().activeLogin,
    getSuffixPolicy: () => useSessionStore.getState().suffixPolicy,
    getSymbol: (displaySymbol) => symbolCache.get(displaySymbol),
    isReadOnly: () => useSessionStore.getState().readOnly,
    onStateChanged: (reason) => reconcile(reason),
    onDiagnostic: (scope, error) => reportError(scope, error),
  });

  // Replacing every socket after a token change is required: an existing
  // socket keeps the token it was opened with until it drops. Clearing a token
  // must tear sockets down too; JWT expiry is checked at handshake, so an
  // already-open socket could otherwise keep streaming after sign-out.
  tokens.subscribe((next) => {
    pool.reconnectAll(next ? 'token renewed' : 'session cleared');
  });

  return {
    http,
    market,
    trading,
    capabilities,
    features,
    workspaceStore,
    tradingService,
    auth,
    tokens,
    pool,
    generations,
    symbolCache,
    setReconciler: (next) => {
      reconcile = next;
    },
  };
}

/** Reports an error to the diagnostics feed with a consistent scope. */
export function reportError(scope: string, error: unknown): void {
  useSystemMessages.getState().pushError(scope, TradingError.from(error));
}
