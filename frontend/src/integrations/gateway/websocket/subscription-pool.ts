import {
  buildSubscriptionProtocols,
  buildSubscriptionQuery,
  buildSubscriptionUrl,
  redactUrl,
  subscriptionKey,
  type SubscriptionParams,
} from './subscription-key';

/**
 * GatewaySubscriptionPool — one physical WebSocket per distinct subscription,
 * shared by every local consumer of that subscription.
 *
 * The gateway has no multiplex protocol: the subscription IS the query string,
 * so N distinct subscriptions require N sockets. The gateway already shares
 * identical subscriptions upstream (one MT5 poll fans out), but the client
 * still deduplicates by canonical key so a watchlist row and a chart watching
 * the same symbol do not open two sockets.
 *
 * What this pool guarantees:
 *   - reference-counted sharing; the socket closes with its last consumer
 *   - exponential backoff with jitter and a cap; reset after a stable period
 *   - resubscribe by reconnecting with the SAME verified query
 *   - `stale` is surfaced and the half-open socket is replaced automatically
 *   - intentional close is distinguished from failure (no reconnect storm)
 *   - online/offline awareness
 *   - the access token never appears in any diagnostic
 *
 * What it explicitly does NOT claim: duplicate-event or out-of-order protection.
 * The server sends periodic SNAPSHOTS with no sequence id or version, so there
 * is nothing to deduplicate against. Ordering is handled by the reconciler's
 * session generations instead.
 */

export type ConnectionState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'stale'
  | 'disconnected'
  | 'auth-expired'
  | 'failed';

export interface SubscriptionStatus {
  readonly key: string;
  readonly state: ConnectionState;
  readonly lastFrameAt: number | null;
  readonly attempts: number;
  readonly error: string | null;
}

export type FrameListener = (frame: unknown, meta: { receivedAt: number }) => void;
export type StatusListener = (status: SubscriptionStatus) => void;

export interface PoolOptions {
  baseWsUrl: string;
  getToken: () => string | null;
  /** Frames older than this mark the subscription stale (default 4 cadences). */
  staleAfterMs?: number;
  /** How long a handshake may hang before it is replaced (default 10s). */
  connectTimeoutMs?: number;
  maxBackoffMs?: number;
  /** After this long connected, the retry counter resets. */
  stableAfterMs?: number;
  maxAttempts?: number;
  socketFactory?: (url: string, protocols: string[]) => WebSocket;
  now?: () => number;
}

interface Consumer {
  readonly id: number;
  readonly onFrame: FrameListener;
  readonly onStatus: StatusListener | undefined;
}

interface Channel {
  readonly key: string;
  readonly query: Record<string, string>;
  socket: WebSocket | null;
  consumers: Map<number, Consumer>;
  state: ConnectionState;
  attempts: number;
  lastFrameAt: number | null;
  error: string | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  /** Bounds the handshake; see CONNECT_TIMEOUT_MS. */
  connectTimer: ReturnType<typeof setTimeout> | null;
  staleTimer: ReturnType<typeof setTimeout> | null;
  stableTimer: ReturnType<typeof setTimeout> | null;
  /** Armed when the last consumer leaves; see CHANNEL_LINGER_MS. */
  lingerTimer: ReturnType<typeof setTimeout> | null;
  /** Armed when the channel enters 'failed' with consumers still attached. */
  probationTimer: ReturnType<typeof setTimeout> | null;
  /** Set while we are tearing the channel down on purpose. */
  closing: boolean;
}

const DEFAULT_STALE_AFTER_MS = 12_000; // 4 × the 3s server cadence
const DEFAULT_MAX_BACKOFF_MS = 30_000;
const DEFAULT_STABLE_AFTER_MS = 15_000;
const DEFAULT_MAX_ATTEMPTS = 12;
const BASE_BACKOFF_MS = 500;
/**
 * How long a FAILED channel with live consumers waits before one fresh retry.
 *
 * Exhausting maxAttempts used to be terminal: during a broker-side flap one
 * symbol's quote channel could burn its whole budget and then sit dead
 * forever, rendering "—" while every other symbol streamed — the exact
 * intermittent single-symbol blank both QA passes caught (AUDUSD, USDCAD).
 * As long as somebody is still rendering the data, the pool owes them a slow
 * heartbeat of retries, not a permanent grave.
 */
const FAILED_RETRY_MS = 60_000;

/**
 * How long a consumer-less channel survives before its socket really closes.
 *
 * During boot the chart library forms and re-forms its quote sessions as
 * panels settle, so the same subscription is dropped and re-taken within a
 * second or two. Closing eagerly tore down sockets mid-handshake — three
 * "WebSocket is closed before the connection is established" warnings on
 * every load — and paid a fresh handshake for each return. A short linger
 * lets the returning consumer reuse the live socket; a subscription nobody
 * returns to still closes, just three seconds later.
 */
const CHANNEL_LINGER_MS = 3_000;

/**
 * How long a socket may sit in `connecting` before it is given up on.
 *
 * There was no bound at all. The only exits from `connecting` were the
 * socket's own events, and the stale timer — the pool's other watchdog — is
 * armed in `onopen`, so a handshake that never completed armed nothing and
 * waited forever. Switching accounts two or three times in quick succession
 * left the header badge reading "Connecting" indefinitely, because one channel
 * stuck in that state pins the whole badge, and the probation retry could not
 * help: it only fires from `failed`, which is reachable only through a close
 * event that was never coming.
 *
 * A handshake that has not completed in this long is not going to. Treating it
 * as a failure puts it back on the ordinary backoff path, which does reach
 * `failed`, and therefore does reach probation.
 */
const CONNECT_TIMEOUT_MS = 10_000;

/**
 * Spacing between sockets when a sweep reopens the whole pool at once.
 *
 * A watchlist of N symbols means N+3 channels, and the gateway rate-limits
 * /ws along with everything else (50 rps, burst 20 per IP), so a simultaneous
 * sweep earns 429s on the overflow — which looks exactly like the flap it was
 * meant to repair.
 */
const SWEEP_STAGGER_MS = 60;

/**
 * The stability deadline must fall INSIDE the stale window.
 *
 * A silent socket is replaced at `staleAfterMs`, and that teardown cancels the
 * stability timer. If the deadline sat at or beyond the stale window it could
 * never be reached on that path, the retry budget would never reset, and a
 * channel that keeps connecting but never receives a frame would exhaust
 * `maxAttempts` and fail PERMANENTLY — taking broker tradability down with it.
 */
const STABLE_WINDOW_FRACTION = 0.75;

export class GatewaySubscriptionPool {
  private readonly channels = new Map<string, Channel>();
  private readonly options: Required<Omit<PoolOptions, 'socketFactory' | 'now'>> &
    Pick<PoolOptions, 'socketFactory' | 'now'>;
  private nextConsumerId = 1;
  /** Distinguishes one reconnectAll sweep from the next; see reconnectAll. */
  private sweepGeneration = 0;
  private disposed = false;
  private onlineHandler: (() => void) | null = null;
  private offlineHandler: (() => void) | null = null;

  constructor(options: PoolOptions) {
    const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    this.options = {
      baseWsUrl: options.baseWsUrl,
      getToken: options.getToken,
      staleAfterMs,
      maxBackoffMs: options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS,
      // Clamped, not merely defaulted: `staleAfterMs` is operator-tunable via
      // VITE_QUOTE_STALE_AFTER_MS, so any fixed deadline can be configured out
      // of reach. See STABLE_WINDOW_FRACTION.
      stableAfterMs: Math.max(
        1,
        Math.min(
          options.stableAfterMs ?? DEFAULT_STABLE_AFTER_MS,
          Math.floor(staleAfterMs * STABLE_WINDOW_FRACTION),
        ),
      ),
      connectTimeoutMs: options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS,
      maxAttempts: options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      socketFactory: options.socketFactory,
      now: options.now,
    };
    this.attachNetworkListeners();
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }

  /**
   * Subscribes a consumer. Returns an unsubscribe function; calling it twice is
   * safe. When the last consumer of a key leaves, the socket is closed.
   */
  subscribe(
    params: SubscriptionParams,
    onFrame: FrameListener,
    onStatus?: StatusListener,
  ): () => void {
    if (this.disposed) return () => {};

    const query = buildSubscriptionQuery(params);
    const key = subscriptionKey(query);
    const id = this.nextConsumerId++;

    let channel = this.channels.get(key);
    if (!channel) {
      channel = {
        key,
        query,
        socket: null,
        consumers: new Map(),
        state: 'idle',
        attempts: 0,
        lastFrameAt: null,
        error: null,
        reconnectTimer: null,
        connectTimer: null,
        staleTimer: null,
        stableTimer: null,
        lingerTimer: null,
        probationTimer: null,
        closing: false,
      };
      this.channels.set(key, channel);
    }

    // A returning consumer within the linger window adopts the live channel —
    // socket, state, backoff history and all — instead of paying a handshake.
    this.clearTimer(channel, 'lingerTimer');
    channel.consumers.set(id, { id, onFrame, onStatus });

    // Report current status immediately so a late subscriber does not render as
    // "connecting" against an already-live channel.
    onStatus?.(statusOf(channel));

    if (channel.socket === null && channel.reconnectTimer === null) {
      this.open(channel);
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      const current = this.channels.get(key);
      if (!current) return;
      current.consumers.delete(id);
      if (current.consumers.size === 0) this.lingerThenClose(current);
    };
  }

  /** Status of every live channel, for the diagnostics widget. */
  statuses(): SubscriptionStatus[] {
    return [...this.channels.values()].map(statusOf);
  }

  /**
   * Reconnects every channel with a freshly read token. Call after a token
   * refresh; without it, existing sockets keep the old token until they drop.
   *
   * Spaced out rather than fired at once. Every account switch renews the
   * token and therefore calls this, so a switch used to slam the gateway with
   * one simultaneous handshake per subscription — and switching again while
   * that was still in flight killed those handshakes and started another full
   * set. The stagger keeps a sweep under the gateway's own rate limit, and a
   * second sweep supersedes the first instead of racing it.
   */
  reconnectAll(reason: string): void {
    const sweep = ++this.sweepGeneration;
    let index = 0;

    for (const channel of this.channels.values()) {
      channel.error = reason;
      // A channel already mid-handshake keeps its attempt count: wiping it
      // meant a switching storm could never exhaust the budget, never reach
      // `failed`, and so never arm the probation retry that exists to rescue
      // exactly this.
      if (channel.state !== 'connecting' && channel.state !== 'reconnecting') {
        channel.attempts = 0;
      }
      this.teardownSocket(channel);

      this.clearTimer(channel, 'reconnectTimer');
      const delay = index++ * SWEEP_STAGGER_MS;
      channel.reconnectTimer = setTimeout(() => {
        channel.reconnectTimer = null;
        // A newer sweep has already taken responsibility for this channel.
        if (this.sweepGeneration !== sweep) return;
        if (this.channels.get(channel.key) !== channel) return;
        this.open(channel);
      }, delay);
    }
  }

  /** Closes every socket and clears every timer. Idempotent. */
  dispose(): void {
    this.disposed = true;
    for (const channel of [...this.channels.values()]) {
      this.closeChannel(channel);
    }
    this.channels.clear();
    this.detachNetworkListeners();
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private open(channel: Channel): void {
    if (this.disposed || channel.consumers.size === 0) return;

    this.clearTimer(channel, 'reconnectTimer');
    channel.closing = false;

    const token = this.options.getToken();
    if (!token) {
      // Without a token the gateway answers 401 before the upgrade. Retrying in
      // a tight loop would be pointless; wait for reconnectAll() after login.
      this.setState(channel, 'auth-expired', 'no access token');
      return;
    }

    const url = buildSubscriptionUrl(this.options.baseWsUrl, channel.query);
    const protocols = buildSubscriptionProtocols(token);
    this.setState(channel, channel.attempts === 0 ? 'connecting' : 'reconnecting', channel.error);

    let socket: WebSocket;
    try {
      socket = this.options.socketFactory
        ? this.options.socketFactory(url, protocols)
        : new WebSocket(url, protocols);
    } catch (error) {
      this.scheduleReconnect(channel, error instanceof Error ? error.message : 'socket error');
      return;
    }

    channel.socket = socket;

    // Nothing else bounds a handshake: the stale timer is armed in `onopen`,
    // which is precisely the event that never arrives here.
    this.clearTimer(channel, 'connectTimer');
    channel.connectTimer = setTimeout(() => {
      channel.connectTimer = null;
      if (channel.socket !== socket) return;
      const reason = 'handshake timed out';
      this.teardownSocket(channel);
      this.scheduleReconnect(channel, reason);
    }, this.options.connectTimeoutMs);

    socket.onopen = () => {
      if (channel.socket !== socket) return;
      this.clearTimer(channel, 'connectTimer');
      channel.error = null;
      this.setState(channel, 'connected', null);
      this.armStaleTimer(channel);
      // Only treat the connection as stable after it survives a while; a socket
      // that opens and immediately drops must not reset the backoff.
      this.clearTimer(channel, 'stableTimer');
      channel.stableTimer = setTimeout(() => {
        channel.attempts = 0;
      }, this.options.stableAfterMs);
    };

    socket.onmessage = (event: MessageEvent) => {
      if (channel.socket !== socket) return;
      const raw = typeof event.data === 'string' ? event.data : null;
      if (raw === null) {
        this.teardownSocket(channel);
        this.scheduleReconnect(channel, 'gateway sent a non-text frame');
        return;
      }

      // The gateway answers an unknown TP with this literal, not JSON.
      if (raw === 'Invalid TP value') {
        this.setState(channel, 'failed', 'gateway rejected the subscription parameters');
        this.teardownSocket(channel);
        return;
      }

      let frame: unknown;
      try {
        frame = JSON.parse(raw);
      } catch {
        // An HTML proxy error or any other non-JSON frame means this stream no
        // longer satisfies the gateway contract. Replace it instead of
        // allowing invalid traffic to keep the connection looking healthy.
        this.teardownSocket(channel);
        this.scheduleReconnect(channel, 'gateway sent a non-JSON frame');
        return;
      }

      const receivedAt = this.now();
      channel.lastFrameAt = receivedAt;
      // A delivered frame proves the subscription works end to end — a stronger
      // signal than a socket merely staying open, and one the stale-replacement
      // path cannot cancel. Without it, a stream that is intermittently silent
      // would ratchet toward the give-up threshold and never recover.
      channel.attempts = 0;
      if (channel.state !== 'connected') this.setState(channel, 'connected', null);
      this.armStaleTimer(channel);

      for (const consumer of channel.consumers.values()) {
        consumer.onFrame(frame, { receivedAt });
      }
    };

    socket.onerror = () => {
      if (channel.socket !== socket) return;
      channel.error = 'connection error';
    };

    socket.onclose = (event: CloseEvent) => {
      if (channel.socket !== socket) return;
      channel.socket = null;
      this.clearTimer(channel, 'connectTimer');
      this.clearTimer(channel, 'staleTimer');
      this.clearTimer(channel, 'stableTimer');

      // A deliberate teardown must never trigger a reconnect.
      if (channel.closing || this.disposed || channel.consumers.size === 0) {
        this.setState(channel, 'disconnected', null);
        return;
      }

      // 1008/4401 are the gateway's auth rejections; retrying with the same
      // dead token would just hammer the endpoint.
      if (event.code === 1008 || event.code === 4401) {
        this.setState(channel, 'auth-expired', 'authentication rejected');
        return;
      }

      this.scheduleReconnect(channel, channel.error ?? `closed (${event.code})`);
    };
  }

  private scheduleReconnect(channel: Channel, reason: string): void {
    channel.attempts += 1;

    if (channel.attempts > this.options.maxAttempts) {
      this.setState(channel, 'failed', `${reason} — giving up after ${channel.attempts} attempts`);
      // Not the end while consumers remain: one fresh attempt per probation
      // interval, with the full backoff budget restored. A dead channel that
      // someone is rendering must keep trying at SOME cadence.
      this.armProbationRetry(channel);
      return;
    }

    // Exponential backoff with full jitter, capped. Jitter matters: without it
    // every socket in the pool retries in lockstep after a gateway restart.
    const exponential = Math.min(
      this.options.maxBackoffMs,
      BASE_BACKOFF_MS * 2 ** (channel.attempts - 1),
    );
    const delay = Math.round(exponential / 2 + Math.random() * (exponential / 2));

    this.setState(channel, 'reconnecting', reason);
    this.clearTimer(channel, 'reconnectTimer');
    channel.reconnectTimer = setTimeout(() => {
      channel.reconnectTimer = null;
      this.open(channel);
    }, delay);
  }

  private armProbationRetry(channel: Channel): void {
    this.clearTimer(channel, 'probationTimer');
    channel.probationTimer = setTimeout(() => {
      channel.probationTimer = null;
      if (this.disposed || channel.consumers.size === 0) return;
      if (this.channels.get(channel.key) !== channel) return;
      if (channel.state !== 'failed') return;
      channel.attempts = 0;
      this.open(channel);
    }, FAILED_RETRY_MS);
  }

  private armStaleTimer(channel: Channel): void {
    this.clearTimer(channel, 'staleTimer');
    channel.staleTimer = setTimeout(() => {
      // The socket is still open but the server stopped pushing. The data is
      // not wrong, it is old — surface that transition, then replace the
      // half-open connection rather than waiting forever for a close event.
      if (channel.state === 'connected') {
        const reason = 'no update within the expected interval';
        this.setState(channel, 'stale', reason);
        this.teardownSocket(channel);
        this.scheduleReconnect(channel, reason);
      }
    }, this.options.staleAfterMs);
  }

  /**
   * The last consumer left. Keep the channel (and its socket, whatever state
   * the handshake is in) alive for the linger window; only a channel nobody
   * re-adopted actually closes. Disposal bypasses this — see dispose().
   */
  private lingerThenClose(channel: Channel): void {
    this.clearTimer(channel, 'lingerTimer');
    channel.lingerTimer = setTimeout(() => {
      channel.lingerTimer = null;
      if (channel.consumers.size === 0) this.closeChannel(channel);
    }, CHANNEL_LINGER_MS);
  }

  private closeChannel(channel: Channel): void {
    channel.closing = true;
    this.clearTimer(channel, 'reconnectTimer');
    this.clearTimer(channel, 'connectTimer');
    this.clearTimer(channel, 'staleTimer');
    this.clearTimer(channel, 'stableTimer');
    this.clearTimer(channel, 'lingerTimer');
    this.clearTimer(channel, 'probationTimer');
    this.teardownSocket(channel);
    channel.consumers.clear();
    this.channels.delete(channel.key);
  }

  private teardownSocket(channel: Channel): void {
    // Timers belong to the physical socket, not the logical subscription. In
    // particular, an old stability timer must not reset the retry budget of
    // its replacement while that replacement is still failing.
    this.clearTimer(channel, 'connectTimer');
    this.clearTimer(channel, 'staleTimer');
    this.clearTimer(channel, 'stableTimer');
    const socket = channel.socket;
    channel.socket = null;
    if (!socket) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    try {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close(1000, 'client closed');
      }
    } catch {
      // A socket already torn down by the browser throws here; nothing to do.
    }
  }

  private clearTimer(
    channel: Channel,
    field:
      | 'reconnectTimer'
      | 'connectTimer'
      | 'staleTimer'
      | 'stableTimer'
      | 'lingerTimer'
      | 'probationTimer',
  ): void {
    const timer = channel[field];
    if (timer !== null) {
      clearTimeout(timer);
      channel[field] = null;
    }
  }

  private setState(channel: Channel, state: ConnectionState, error: string | null): void {
    if (channel.state === state && channel.error === error) return;
    channel.state = state;
    channel.error = error;
    const status = statusOf(channel);
    for (const consumer of channel.consumers.values()) {
      consumer.onStatus?.(status);
    }
  }

  private attachNetworkListeners(): void {
    if (typeof window === 'undefined') return;

    this.onlineHandler = () => {
      for (const channel of this.channels.values()) {
        // A browser may keep a WebSocket in OPEN state while the underlying
        // network path is dead. Always replace it on `online`; waiting for a
        // close event can leave the terminal disconnected forever.
        channel.attempts = 0;
        this.clearTimer(channel, 'reconnectTimer');
        this.clearTimer(channel, 'probationTimer');
        this.teardownSocket(channel);
        this.open(channel);
      }
    };
    this.offlineHandler = () => {
      for (const channel of this.channels.values()) {
        // Do not burn through the retry budget while the browser explicitly
        // says there is no network. Online will open a fresh socket at once.
        this.clearTimer(channel, 'reconnectTimer');
        this.clearTimer(channel, 'staleTimer');
        this.clearTimer(channel, 'stableTimer');
        this.teardownSocket(channel);
        this.setState(channel, 'disconnected', 'browser is offline');
      }
    };

    window.addEventListener('online', this.onlineHandler);
    window.addEventListener('offline', this.offlineHandler);
  }

  private detachNetworkListeners(): void {
    if (typeof window === 'undefined') return;
    if (this.onlineHandler) window.removeEventListener('online', this.onlineHandler);
    if (this.offlineHandler) window.removeEventListener('offline', this.offlineHandler);
    this.onlineHandler = null;
    this.offlineHandler = null;
  }
}

function statusOf(channel: Channel): SubscriptionStatus {
  return {
    key: channel.key,
    state: channel.state,
    lastFrameAt: channel.lastFrameAt,
    attempts: channel.attempts,
    error: channel.error,
  };
}

/** Re-exported so diagnostics can render a redacted URL without the token. */
export { redactUrl };
