import { useCallback, useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { env } from '@/app/config/env';
import { reportError, useServices } from '@/app/providers/services';
import {
  accountStateSchema,
  tvOrderListSchema,
  tvPositionListSchema,
} from '@/integrations/gateway/contracts/schemas';
import {
  mapAccountState,
  mapTvOrder,
  mapTvPosition,
} from '@/integrations/gateway/mappers/to-domain';
import { SnapshotGate, type Generation } from '@/integrations/gateway/websocket/session-generation';
import { probeSuffix } from '@/integrations/gateway/suffix-probe';
import { TradingError } from '@/domain/common/errors';
import type { ConnectionState } from '@/integrations/gateway/websocket/subscription-pool';
import { useSessionStore } from '@/stores/session-store';
import { useTradingStore } from '@/stores/trading-store';
import { quoteStore } from '@/stores/quote-store';
import { useSystemMessages } from '@/stores/system-messages-store';
import type { Position, TradingOrder } from '@/domain/common/models';
import { shouldApplyRestSnapshot } from './reconciliation-policy';

/**
 * Account synchronisation and reconciliation.
 *
 * The gateway pushes periodic SNAPSHOTS with no sequence ids, so the ordering
 * discipline is:
 *
 *   1. advance the session generation (invalidates everything older)
 *   2. open the WebSocket subscriptions — frames start BUFFERING, not applying
 *   3. fetch the authoritative REST snapshots
 *   4. apply the REST snapshots
 *   5. release the gates and apply the newest buffered frame, if any
 *   6. apply frames live from then on
 *
 * Step 2 before step 3 is deliberate: opening the socket after the fetch would
 * lose every update that happened during the fetch.
 *
 * See docs/architecture/realtime-reconciliation.md for what this does and does
 * not guarantee.
 */

export function useAccountSync(): { reconcile: (reason: string) => void } {
  const services = useServices();
  const config = env();
  const queryClient = useQueryClient();

  const activeLogin = useSessionStore((s) => s.activeLogin);
  const suffixPolicy = useSessionStore((s) => s.suffixPolicy);

  const generationRef = useRef<Generation>(services.generations.generation);
  const reconcileRef = useRef<(reason: string) => void>(() => {});

  const reconcile = useCallback((reason: string) => reconcileRef.current(reason), []);

  useEffect(() => {
    services.setReconciler(reconcile);
  }, [services, reconcile]);

  useEffect(() => {
    if (!activeLogin) return;

    const store = useTradingStore.getState();
    // Every account switch starts a new generation. Any frame or in-flight
    // response tagged with an older one is dropped on arrival.
    const generation = services.generations.advance();
    generationRef.current = generation;

    // Wipe account-scoped data BEFORE the new account's data arrives, so the
    // previous account's positions cannot be visible for even one frame.
    store.resetForAccountSwitch(generation);
    quoteStore.clear();
    // Symbol records are cached by DISPLAY name, but contract limits (volume
    // min/step, tick value) are per account GROUP. Carrying them across a
    // switch would validate the new account's orders against the old group's
    // limits.
    services.symbolCache.clear();

    const accountGate = new SnapshotGate<unknown>();
    const positionsGate = new SnapshotGate<unknown>();
    const ordersGate = new SnapshotGate<unknown>();

    // Read the account list imperatively rather than subscribing to it, and
    // resolve it AT EACH USE rather than capturing it once.
    //
    // Depending on the array would tear down and rebuild every WebSocket each
    // time the list is refreshed. But capturing a single lookup here is wrong
    // too: the list can arrive after a login is already active (a restored
    // session, a slow CRM), which would pin name/server to undefined for the
    // lifetime of this effect.
    const accountMeta = () =>
      useSessionStore.getState().accounts.find((a) => a.login === activeLogin);
    const abort = new AbortController();
    let reconcileSequence = 0;
    let reconnectReconcileTimer: ReturnType<typeof setTimeout> | null = null;
    let historyLagTimer: ReturnType<typeof setTimeout> | null = null;
    const hasConnected = { account: false, positions: false, orders: false };
    // The order-side warning below is per-connection, not per-frame: the stream
    // repeats, and one broken gateway must not fill the message log.
    let warnedMissingOrderSide = false;

    const isCurrent = () => services.generations.isCurrent(generation);

    // DATA-001: History and Deals are TanStack queries, not stream-fed stores,
    // so a reconciliation must invalidate them explicitly — the production
    // test closed a position and watched History stay one trade short until a
    // manual reload. MT5 writes the closing deal to its history with a small
    // lag, so a second invalidation runs after HISTORY_LAG_MS: the first pass
    // shows what is already there, the second catches what the dealer was
    // still writing.
    const HISTORY_LAG_MS = 2_500;
    const refreshHistory = () => {
      if (!isCurrent()) return;
      void queryClient.invalidateQueries({ queryKey: ['history', activeLogin] });
      void queryClient.invalidateQueries({ queryKey: ['order-history', activeLogin] });
      if (historyLagTimer !== null) clearTimeout(historyLagTimer);
      historyLagTimer = setTimeout(() => {
        historyLagTimer = null;
        if (!isCurrent()) return;
        void queryClient.invalidateQueries({ queryKey: ['history', activeLogin] });
        void queryClient.invalidateQueries({ queryKey: ['order-history', activeLogin] });
      }, HISTORY_LAG_MS);
    };

    // ── frame handlers ───────────────────────────────────────────────────────

    const applyAccountFrame = (frame: unknown, receivedAt: number) => {
      if (!isCurrent()) return;
      const parsed = accountStateSchema.safeParse(frame);
      if (!parsed.success) return;
      const meta = accountMeta();
      useTradingStore.getState().applyAccount(
        mapAccountState(activeLogin, parsed.data, {
          name: meta?.name,
          server: meta?.server ?? null,
          currency: meta?.currency ?? null,
          readOnly: meta?.readOnly ?? false,
          asOf: receivedAt,
        }),
        generation,
        receivedAt,
      );
    };

    const applyPositionsFrame = (frame: unknown, receivedAt: number) => {
      if (!isCurrent()) return;
      const parsed = tvPositionListSchema.safeParse(frame);
      if (!parsed.success) return;
      const positions = parsed.data
        .map((dto) => mapTvPosition(dto, suffixPolicy))
        .filter((p): p is Position => p !== null);
      // Replace, never merge: absence IS the close signal in a snapshot stream.
      useTradingStore.getState().applyPositions(positions, generation, receivedAt);
    };

    const applyOrdersFrame = (frame: unknown, receivedAt: number) => {
      if (!isCurrent()) return;
      const parsed = tvOrderListSchema.safeParse(frame);
      if (!parsed.success) return;

      // A TV side is 1 (buy) or -1 (sell); 0 means the gateway could not state
      // one. `side >= 0` would read that as BUY, which is how a resting Sell
      // Stop came to render as a Buy Stop everywhere and then refused to
      // cancel (the cancel re-derives the MT5 order type from this side).
      // Gateways are deployed by hand, so an older one can still be serving
      // this: drop the whole frame rather than replace good REST state with a
      // confident lie. The reconciler refetches orders on its own timer.
      if (parsed.data.some((dto) => dto.side === 0)) {
        if (!warnedMissingOrderSide) {
          warnedMissingOrderSide = true;
          useSystemMessages.getState().push({
            level: 'warning',
            scope: 'sync',
            text: 'Live order updates are paused: this gateway does not report order side. Orders shown are from the last refresh.',
            code: 'sync.order-side-missing',
            requestId: null,
          });
        }
        return;
      }

      const orders = parsed.data
        .map((dto) => mapTvOrder(dto, suffixPolicy))
        .filter((o): o is TradingOrder => o !== null);
      useTradingStore.getState().applyOrders(orders, generation, receivedAt);
    };

    const onConnection =
      (scope: 'account' | 'positions' | 'orders') => (status: { state: ConnectionState }) => {
        if (!isCurrent()) return;
        useTradingStore.getState().setConnection(scope, status.state);

        if (status.state !== 'connected') return;
        if (!hasConnected[scope]) {
          hasConnected[scope] = true;
          return;
        }

        // A recovered snapshot stream may have missed changes while it was
        // disconnected or stale. Coalesce the three independently reconnecting
        // sockets into one authoritative REST refresh.
        if (reconnectReconcileTimer !== null) return;
        reconnectReconcileTimer = setTimeout(() => {
          reconnectReconcileTimer = null;
          if (isCurrent()) void loadSnapshots(`${scope} stream reconnected`);
        }, 250);
      };

    // ── step 2: subscribe first, buffering until the snapshot lands ──────────

    const unsubscribeAccount = services.pool.subscribe(
      { family: 'account', login: activeLogin },
      (frame, meta) => {
        if (!accountGate.isOpen) accountGate.buffer(frame, meta.receivedAt);
        else applyAccountFrame(frame, meta.receivedAt);
      },
      onConnection('account'),
    );

    const unsubscribePositions = services.pool.subscribe(
      { family: 'positions', login: activeLogin },
      (frame, meta) => {
        if (!positionsGate.isOpen) positionsGate.buffer(frame, meta.receivedAt);
        else applyPositionsFrame(frame, meta.receivedAt);
      },
      onConnection('positions'),
    );

    const unsubscribeOrders = services.pool.subscribe(
      { family: 'orders', login: activeLogin },
      (frame, meta) => {
        if (!ordersGate.isOpen) ordersGate.buffer(frame, meta.receivedAt);
        else applyOrdersFrame(frame, meta.receivedAt);
      },
      onConnection('orders'),
    );

    // ── steps 3–5: authoritative snapshot, then release the gates ────────────

    const loadSnapshots = async (reason: string) => {
      if (!isCurrent()) return;
      const sequence = ++reconcileSequence;
      const requestStartedAt = Date.now();
      const meta = accountMeta();

      try {
        const [accountState, positions, orders, tradeDisabled] = await Promise.all([
          services.trading.accountState(
            activeLogin,
            {
              name: meta?.name,
              server: meta?.server ?? null,
              currency: meta?.currency ?? null,
              readOnly: meta?.readOnly,
            },
            abort.signal,
          ),
          services.trading.positions(activeLogin, suffixPolicy, {}, abort.signal),
          services.trading.orders(activeLogin, suffixPolicy, {}, abort.signal),
          services.trading.tradeDisabled(activeLogin, abort.signal),
        ]);

        // A newer mutation/reconciliation request supersedes this one. Without
        // this check, a slow older response can roll the terminal backward.
        if (!isCurrent() || sequence !== reconcileSequence) return;

        const now = Date.now();
        const trading = useTradingStore.getState();
        if (shouldApplyRestSnapshot(trading.accountFreshness.updatedAt, requestStartedAt)) {
          trading.applyAccount(accountState, generation, now);
        }
        if (shouldApplyRestSnapshot(trading.positionsFreshness.updatedAt, requestStartedAt)) {
          trading.applyPositions(positions, generation, now);
        }
        if (shouldApplyRestSnapshot(trading.ordersFreshness.updatedAt, requestStartedAt)) {
          trading.applyOrders(orders, generation, now);
        }
        trading.setInitialLoadPending(false);

        // MT5 rights are only trusted when the gateway actually reported them;
        // null means "unknown", not "tradable".
        if (tradeDisabled !== null) {
          // Re-read rather than reusing `meta`: the account list may have
          // resolved while these requests were in flight, and a read-only flag
          // that arrives late must still be honoured.
          useSessionStore
            .getState()
            .setReadOnly(tradeDisabled || (accountMeta()?.readOnly ?? false));
        }

        // Now apply anything that arrived while we were fetching.
        const bufferedAccount = accountGate.release();
        if (bufferedAccount) {
          applyAccountFrame(bufferedAccount.frame, bufferedAccount.receivedAt);
        }
        const bufferedPositions = positionsGate.release();
        if (bufferedPositions) {
          applyPositionsFrame(bufferedPositions.frame, bufferedPositions.receivedAt);
        }
        const bufferedOrders = ordersGate.release();
        if (bufferedOrders) {
          applyOrdersFrame(bufferedOrders.frame, bufferedOrders.receivedAt);
        }

        refreshHistory();

        useSystemMessages.getState().push({
          level: 'info',
          scope: 'sync',
          text: `Account ${activeLogin} synchronised (${reason}).`,
          code: 'sync.complete',
          requestId: null,
        });
      } catch (error) {
        if (abort.signal.aborted || !isCurrent() || sequence !== reconcileSequence) return;
        reportError('sync', error);
        // Open the gates anyway: live frames are better than a frozen UI, and
        // their freshness is still reported honestly.
        const bufferedAccount = accountGate.release();
        if (bufferedAccount) {
          applyAccountFrame(bufferedAccount.frame, bufferedAccount.receivedAt);
        }
        const bufferedPositions = positionsGate.release();
        if (bufferedPositions) {
          applyPositionsFrame(bufferedPositions.frame, bufferedPositions.receivedAt);
        }
        const bufferedOrders = ordersGate.release();
        if (bufferedOrders) {
          applyOrdersFrame(bufferedOrders.frame, bufferedOrders.receivedAt);
        }
        useTradingStore.getState().setInitialLoadPending(false);
      }
    };

    reconcileRef.current = (reason: string) => {
      // Called after every accepted trade mutation. We do NOT optimistically
      // mutate local state — we refetch and let the authoritative snapshot say
      // what happened.
      void loadSnapshots(reason);
    };

    void loadSnapshots('account selected');

    // A reconnect invalidates our snapshot: refetch before presenting the
    // account as fully synchronised again.
    const unsubscribeGeneration = services.generations.onAdvance(() => {
      accountGate.reset();
      positionsGate.reset();
      ordersGate.reset();
    });

    return () => {
      abort.abort();
      if (reconnectReconcileTimer !== null) clearTimeout(reconnectReconcileTimer);
      if (historyLagTimer !== null) clearTimeout(historyLagTimer);
      unsubscribeAccount();
      unsubscribePositions();
      unsubscribeOrders();
      unsubscribeGeneration();
      reconcileRef.current = () => {};
    };
  }, [activeLogin, suffixPolicy, services, config.quoteStaleAfterMs, queryClient]);

  // Empirically verify the active account's symbol suffix. The configured
  // suffix (gateway env, or the built-in type map) can be wrong for a group —
  // live QA: Social PRO mapped to "#", a dialect its MT5 group does not serve,
  // and every chart and quote silently died; another account mapped to bare
  // names whose group serves no bare history. The probe uses the strict
  // history endpoint as the witness. Hard evidence for bare names corrects the
  // policy in place (re-pointing every stream through the existing
  // suffix-change paths); a dead dialect with only suffixed survivors is
  // REPORTED, never guessed — charting another group's prices is worse than an
  // honest error. The probe result is stable per policy, so this cannot loop:
  // 'ok' and 'indeterminate' change nothing, and a corrected policy probes
  // 'ok' on its next run.
  useEffect(() => {
    if (!activeLogin) return;

    const controller = new AbortController();
    const configured = suffixPolicy.suffix;
    void probeSuffix(services.market, configured, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      // Production-safe diagnostics: suffixes and symbol dialects only.
      if (result.outcome === 'corrected') {
        console.warn('[symbols] configured suffix serves no history; corrected after live probe', {
          configured,
          corrected: result.suffix,
        });
        useSessionStore.getState().correctSuffix(activeLogin, result.suffix);
      } else if (result.outcome === 'misconfigured') {
        console.warn('[symbols] configured symbol dialect serves no history', result);
        reportError(
          'symbols',
          new TradingError({
            kind: 'unavailable',
            message:
              'Chart history is unavailable for this account: its symbol naming ' +
              `("${configured === '' ? 'no suffix' : configured}") appears misconfigured ` +
              'on the trading server. Please contact support.',
            code: 'symbols.dialect-misconfigured',
            retryable: false,
          }),
        );
      }
    });
    return () => controller.abort();
  }, [activeLogin, suffixPolicy, services]);

  return { reconcile };
}
