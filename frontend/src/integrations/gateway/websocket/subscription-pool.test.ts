import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GatewaySubscriptionPool } from './subscription-pool';

/** Minimal controllable WebSocket double. */
class FakeSocket {
  static instances: FakeSocket[] = [];

  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  closed = false;
  closeCode: number | null = null;

  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {
    FakeSocket.instances.push(this);
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  emit(data: unknown): void {
    this.onmessage?.({
      data: typeof data === 'string' ? data : JSON.stringify(data),
    } as MessageEvent);
  }

  serverClose(code = 1006): void {
    this.readyState = 3;
    this.onclose?.({ code } as CloseEvent);
  }

  close(code?: number): void {
    this.closed = true;
    this.closeCode = code ?? null;
    this.readyState = 3;
  }
}

function createPool(
  overrides: Partial<ConstructorParameters<typeof GatewaySubscriptionPool>[0]> = {},
) {
  return new GatewaySubscriptionPool({
    baseWsUrl: 'ws://gateway.test',
    getToken: () => 'test-token',
    staleAfterMs: 1_000,
    socketFactory: (url, protocols) => new FakeSocket(url, protocols) as unknown as WebSocket,
    ...overrides,
  });
}

beforeEach(() => {
  FakeSocket.instances = [];
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('GatewaySubscriptionPool', () => {
  it('opens one socket and delivers frames to the consumer', () => {
    const pool = createPool();
    const frames: unknown[] = [];

    pool.subscribe({ family: 'quote', symbol: 'EURUSD.' }, (frame) => frames.push(frame));

    const socket = FakeSocket.instances[0];
    expect(socket).toBeDefined();
    expect(socket?.url).not.toContain('test-token');
    expect(socket?.url).not.toContain('access_token');
    expect(socket?.protocols).toEqual(['tradeplatform.v1', 'tradeplatform.jwt.test-token']);
    socket?.open();
    socket?.emit([{ symbolname: 'EURUSD.', bid: 1.1, ask: 1.1002 }]);

    expect(frames).toHaveLength(1);
    pool.dispose();
  });

  it('shares ONE socket between identical subscriptions', () => {
    // The gateway needs a separate socket per distinct query string, so
    // deduplicating identical ones is what stops a watchlist and a chart from
    // opening two connections for the same symbol.
    const pool = createPool();
    const a: unknown[] = [];
    const b: unknown[] = [];

    pool.subscribe({ family: 'quote', symbol: 'EURUSD.' }, (f) => a.push(f));
    pool.subscribe({ family: 'quote', symbol: 'EURUSD.' }, (f) => b.push(f));

    expect(FakeSocket.instances).toHaveLength(1);

    FakeSocket.instances[0]?.open();
    FakeSocket.instances[0]?.emit([{ bid: 1 }]);

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    pool.dispose();
  });

  it('opens separate sockets for different subscriptions', () => {
    const pool = createPool();
    pool.subscribe({ family: 'quote', symbol: 'EURUSD.' }, () => {});
    pool.subscribe({ family: 'quote', symbol: 'GBPUSD.' }, () => {});
    expect(FakeSocket.instances).toHaveLength(2);
    pool.dispose();
  });

  it('closes the socket only when the LAST consumer unsubscribes', () => {
    const pool = createPool();
    const first = pool.subscribe({ family: 'quote', symbol: 'EURUSD.' }, () => {});
    const second = pool.subscribe({ family: 'quote', symbol: 'EURUSD.' }, () => {});
    const socket = FakeSocket.instances[0];
    socket?.open();

    first();
    expect(socket?.closed).toBe(false);

    second();
    // The linger window holds the socket for a returning consumer; only its
    // expiry actually closes the channel.
    expect(socket?.closed).toBe(false);
    vi.advanceTimersByTime(3_100);
    expect(socket?.closed).toBe(true);
    pool.dispose();
  });

  it('is safe to unsubscribe twice', () => {
    const pool = createPool();
    const release = pool.subscribe({ family: 'quote', symbol: 'EURUSD.' }, () => {});
    release();
    expect(() => release()).not.toThrow();
    pool.dispose();
  });

  it('marks a subscription stale and replaces a half-open socket', () => {
    // A frozen price that still looks live is the most dangerous state a
    // trading terminal can be in.
    const pool = createPool({ staleAfterMs: 1_000 });
    const states: string[] = [];

    pool.subscribe(
      { family: 'quote', symbol: 'EURUSD.' },
      () => {},
      (status) => states.push(status.state),
    );

    const socket = FakeSocket.instances[0];
    socket?.open();
    socket?.emit([{ bid: 1 }]);
    expect(states).toContain('connected');

    vi.advanceTimersByTime(1_100);
    expect(states).toContain('stale');
    expect(states).toContain('reconnecting');
    expect(socket?.closed).toBe(true);

    vi.advanceTimersByTime(1_000);
    expect(FakeSocket.instances).toHaveLength(2);

    pool.dispose();
  });

  it('reconnects with backoff after an unexpected close', () => {
    const pool = createPool();
    pool.subscribe({ family: 'quote', symbol: 'EURUSD.' }, () => {});

    FakeSocket.instances[0]?.open();
    FakeSocket.instances[0]?.serverClose(1006);

    expect(FakeSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(2_000);
    expect(FakeSocket.instances.length).toBeGreaterThan(1);

    pool.dispose();
  });

  it('pauses offline and replaces a possibly half-open socket immediately online', () => {
    const pool = createPool();
    const states: string[] = [];
    pool.subscribe(
      { family: 'quote', symbol: 'EURUSD.' },
      () => {},
      (status) => states.push(status.state),
    );

    const original = FakeSocket.instances[0];
    original?.open();
    window.dispatchEvent(new Event('offline'));

    expect(original?.closed).toBe(true);
    expect(states.at(-1)).toBe('disconnected');
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.instances).toHaveLength(1);

    window.dispatchEvent(new Event('online'));
    expect(FakeSocket.instances).toHaveLength(2);
    expect(states.at(-1)).toBe('connecting');
    pool.dispose();
  });

  it('does NOT reconnect after a deliberate unsubscribe', () => {
    // Reconnecting after an intentional teardown is how reconnect storms start
    // on an account switch.
    const pool = createPool();
    const release = pool.subscribe({ family: 'quote', symbol: 'EURUSD.' }, () => {});
    FakeSocket.instances[0]?.open();

    release();
    vi.advanceTimersByTime(10_000);

    expect(FakeSocket.instances).toHaveLength(1);
    pool.dispose();
  });

  it('does not reconnect after an auth rejection', () => {
    const pool = createPool();
    const states: string[] = [];
    pool.subscribe(
      { family: 'quote', symbol: 'EURUSD.' },
      () => {},
      (s) => states.push(s.state),
    );

    FakeSocket.instances[0]?.open();
    FakeSocket.instances[0]?.serverClose(1008);

    vi.advanceTimersByTime(30_000);
    expect(states).toContain('auth-expired');
    expect(FakeSocket.instances).toHaveLength(1);
    pool.dispose();
  });

  it('reports auth-expired without opening a socket when there is no token', () => {
    const pool = createPool({ getToken: () => null });
    const states: string[] = [];
    pool.subscribe(
      { family: 'quote', symbol: 'EURUSD.' },
      () => {},
      (s) => states.push(s.state),
    );

    expect(FakeSocket.instances).toHaveLength(0);
    expect(states).toContain('auth-expired');
    pool.dispose();
  });

  it('fails the subscription when the gateway rejects its parameters', () => {
    // internal/realtime/dispatch.go answers an unknown TP with this literal.
    const pool = createPool();
    const states: string[] = [];
    pool.subscribe(
      { family: 'quote', symbol: 'EURUSD.' },
      () => {},
      (s) => states.push(s.state),
    );

    FakeSocket.instances[0]?.open();
    FakeSocket.instances[0]?.emit('Invalid TP value');

    expect(states).toContain('failed');
    pool.dispose();
  });

  it('replaces a stream that sends a non-JSON frame instead of treating it as fresh', () => {
    const pool = createPool();
    const frames: unknown[] = [];
    const states: string[] = [];
    pool.subscribe(
      { family: 'quote', symbol: 'EURUSD.' },
      (f) => frames.push(f),
      (status) => states.push(status.state),
    );

    const original = FakeSocket.instances[0];
    original?.open();
    original?.emit('<html>gateway error</html>');

    expect(frames).toHaveLength(0);
    expect(original?.closed).toBe(true);
    expect(states.at(-1)).toBe('reconnecting');

    vi.advanceTimersByTime(1_000);
    expect(FakeSocket.instances).toHaveLength(2);
    pool.dispose();
  });

  it('never exposes the token in status diagnostics', () => {
    const pool = createPool({ getToken: () => 'super-secret-jwt' });
    pool.subscribe({ family: 'quote', symbol: 'EURUSD.' }, () => {});

    const serialised = JSON.stringify(pool.statuses());
    expect(serialised).not.toContain('super-secret-jwt');
    expect(serialised).not.toContain('access_token');
    pool.dispose();
  });

  it('closes everything on dispose', () => {
    const pool = createPool();
    pool.subscribe({ family: 'quote', symbol: 'EURUSD.' }, () => {});
    pool.subscribe({ family: 'account', login: '1001' }, () => {});
    FakeSocket.instances.forEach((s) => s.open());

    pool.dispose();
    expect(FakeSocket.instances.every((s) => s.closed)).toBe(true);
    expect(pool.statuses()).toHaveLength(0);
  });
});

/**
 * These run at the SHIPPED defaults rather than the fast values the suite uses
 * elsewhere. The defect they cover was invisible at `staleAfterMs: 1_000`,
 * because it comes from the ORDERING of the stale and stability windows.
 */
describe('GatewaySubscriptionPool retry budget (production defaults)', () => {
  const openLatest = () => {
    const socket = FakeSocket.instances.at(-1);
    if (socket && socket.readyState === 0) socket.open();
    return socket;
  };

  it('keeps recovering a silent stream instead of failing it permanently', () => {
    // Every socket connects, but the gateway never pushes. The channel must
    // keep replacing the half-open socket rather than exhausting its budget:
    // a `failed` account/orders/positions stream disables broker tradability
    // with no recovery short of a page reload.
    const pool = new GatewaySubscriptionPool({
      baseWsUrl: 'ws://gateway.test',
      getToken: () => 'test-token',
      socketFactory: (url, protocols) => new FakeSocket(url, protocols) as unknown as WebSocket,
    });
    pool.subscribe({ family: 'positions', login: '1001' }, () => {});

    for (let cycle = 0; cycle < 30; cycle++) {
      openLatest();
      vi.advanceTimersByTime(60_000);
    }

    expect(pool.statuses()[0]?.state).not.toBe('failed');
    pool.dispose();
  });

  it('resets the retry budget when a frame actually arrives', () => {
    const pool = new GatewaySubscriptionPool({
      baseWsUrl: 'ws://gateway.test',
      getToken: () => 'test-token',
      // Short backoff so each replacement socket is opened promptly. Leaving a
      // socket in CONNECTING for a minute is now a HUNG HANDSHAKE and is
      // retried as one, which is a different scenario from this one.
      maxBackoffMs: 200,
      socketFactory: (url, protocols) => new FakeSocket(url, protocols) as unknown as WebSocket,
    });
    pool.subscribe({ family: 'positions', login: '1001' }, () => {});

    // Drop the socket repeatedly to build the budget up...
    for (let i = 0; i < 5; i++) {
      openLatest();
      FakeSocket.instances.at(-1)?.serverClose();
      vi.advanceTimersByTime(300);
    }
    expect(pool.statuses()[0]?.attempts).toBeGreaterThan(0);

    // ...then prove one delivered frame clears it.
    openLatest();
    FakeSocket.instances.at(-1)?.emit([{ symbolname: 'EURUSD.' }]);
    expect(pool.statuses()[0]?.attempts).toBe(0);
    pool.dispose();
  });

  it('stays connected across a normal 3s server cadence', () => {
    const pool = new GatewaySubscriptionPool({
      baseWsUrl: 'ws://gateway.test',
      getToken: () => 'test-token',
      socketFactory: (url, protocols) => new FakeSocket(url, protocols) as unknown as WebSocket,
    });
    pool.subscribe({ family: 'positions', login: '1001' }, () => {});
    FakeSocket.instances[0]?.open();

    for (let i = 0; i < 40; i++) {
      vi.advanceTimersByTime(3_000);
      FakeSocket.instances.at(-1)?.emit([]);
    }

    expect(FakeSocket.instances).toHaveLength(1);
    expect(pool.statuses()[0]?.state).toBe('connected');
    pool.dispose();
  });

  describe('channel linger', () => {
    // Boot churn (2026-08-24 console report): the chart library re-forms its
    // quote sessions while panels settle, dropping and re-taking the same
    // subscription within a second. Eager teardown closed sockets
    // MID-HANDSHAKE — three "closed before the connection is established"
    // warnings per load — and paid a fresh handshake for every return.
    it('a returning consumer within the linger window reuses the live socket', () => {
      const pool = createPool();
      const unsubscribe = pool.subscribe({ family: 'quote', symbol: 'EURUSD.' }, () => {});
      const socket = FakeSocket.instances[0]!;

      // Consumer leaves while the handshake is still in flight.
      unsubscribe();
      expect(socket.closed).toBe(false); // NOT torn down mid-handshake

      // ...and returns within the linger window.
      vi.advanceTimersByTime(1_000);
      const frames: unknown[] = [];
      pool.subscribe({ family: 'quote', symbol: 'EURUSD.' }, (frame) => frames.push(frame));

      expect(FakeSocket.instances).toHaveLength(1); // same socket, no churn
      socket.open();
      socket.emit({ bid: 1.1 });
      expect(frames).toHaveLength(1);

      // The cancelled linger must never close the adopted channel later.
      // Frames keep the stale timer at bay while we cross the old deadline.
      for (let i = 0; i < 5; i++) {
        vi.advanceTimersByTime(900);
        socket.emit({ bid: 1.1 });
      }
      expect(socket.closed).toBe(false);
      expect(pool.statuses()).toHaveLength(1);
      pool.dispose();
    });

    it('a subscription nobody returns to still closes, after the linger', () => {
      const pool = createPool();
      const unsubscribe = pool.subscribe({ family: 'quote', symbol: 'EURUSD.' }, () => {});
      const socket = FakeSocket.instances[0]!;
      socket.open();

      unsubscribe();
      expect(socket.closed).toBe(false); // lingering
      vi.advanceTimersByTime(3_100);
      expect(socket.closed).toBe(true); // and gone
      expect(pool.statuses()).toHaveLength(0);
      pool.dispose();
    });

    it('dispose closes lingering channels immediately', () => {
      const pool = createPool();
      const unsubscribe = pool.subscribe({ family: 'quote', symbol: 'EURUSD.' }, () => {});
      unsubscribe();
      pool.dispose();
      expect(FakeSocket.instances[0]?.closed).toBe(true);
    });
  });
});

describe('failed-channel probation (single-symbol blank quote)', () => {
  it('a channel that exhausts its retry budget tries again while consumers remain', async () => {
    const pool = createPool({ maxAttempts: 2, maxBackoffMs: 100 });
    const states: string[] = [];
    pool.subscribe(
      { family: 'quote', symbol: 'AUDUSD' },
      () => {},
      (status) => states.push(status.state),
    );

    // Burn the whole budget: every socket the pool opens dies immediately.
    for (let i = 0; i < 8; i++) {
      FakeSocket.instances.at(-1)?.serverClose();
      await vi.advanceTimersByTimeAsync(200);
    }
    expect(states).toContain('failed');
    const socketsAtFailure = FakeSocket.instances.length;

    // The old behaviour ended here forever — the QA-observed "— —" symbol.
    // Probation: one fresh attempt after the interval, budget restored.
    await vi.advanceTimersByTimeAsync(61_000);
    expect(FakeSocket.instances.length).toBeGreaterThan(socketsAtFailure);

    // And the fresh attempt can actually recover the stream.
    const revived = FakeSocket.instances.at(-1)!;
    revived.open();
    revived.emit({ symbolname: 'AUDUSD', bid: 0.65 });
    expect(states.at(-1)).toBe('connected');
  });

  it('probation does not retry after the last consumer leaves', async () => {
    const pool = createPool({ maxAttempts: 1, maxBackoffMs: 100 });
    const unsubscribe = pool.subscribe({ family: 'quote', symbol: 'AUDUSD' }, () => {});
    for (let i = 0; i < 5; i++) {
      FakeSocket.instances.at(-1)?.serverClose();
      await vi.advanceTimersByTimeAsync(200);
    }
    unsubscribe();
    // Linger + probation both elapse; a consumer-less channel must stay quiet.
    const socketsAtFailure = FakeSocket.instances.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(FakeSocket.instances.length).toBe(socketsAtFailure);
  });
});

/**
 * QA, 2026-08-24: switching accounts two or three times in quick succession
 * left the header badge on "Connecting" indefinitely — still stuck 25 seconds
 * after the last switch, with the System log showing GetQuotes subscriptions
 * that never completed.
 */
describe('a handshake that never completes', () => {
  it('does not sit in "connecting" forever', async () => {
    const pool = createPool({ connectTimeoutMs: 5_000 });
    const states: string[] = [];
    pool.subscribe(
      { family: 'quote', symbol: 'EURUSD' },
      () => {},
      (status) => states.push(status.state),
    );

    // The socket is created and then simply never opens, errors or closes —
    // a hung upgrade behind a proxy, or one queued behind a storm of others.
    expect(FakeSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(states.at(-1)).toBe('connecting');

    await vi.advanceTimersByTimeAsync(2_000);
    expect(states.at(-1)).not.toBe('connecting');
    expect(FakeSocket.instances[0]?.closed).toBe(true);
  });

  it('reaches "failed" — and therefore probation — instead of hanging', async () => {
    const pool = createPool({ connectTimeoutMs: 1_000, maxAttempts: 2, maxBackoffMs: 100 });
    const states: string[] = [];
    pool.subscribe(
      { family: 'quote', symbol: 'EURUSD' },
      () => {},
      (status) => states.push(status.state),
    );

    // Every handshake hangs. Without a connect timeout this loop produces
    // exactly one socket and one state, forever.
    await vi.advanceTimersByTimeAsync(20_000);

    expect(states).toContain('failed');
    expect(FakeSocket.instances.length).toBeGreaterThan(1);
  });

  it('a socket that opens in time is left alone', async () => {
    const pool = createPool({ connectTimeoutMs: 1_000, staleAfterMs: 60_000 });
    pool.subscribe({ family: 'quote', symbol: 'EURUSD' }, () => {});
    const socket = FakeSocket.instances[0]!;
    socket.open();

    await vi.advanceTimersByTimeAsync(5_000);

    expect(socket.closed).toBe(false);
    expect(FakeSocket.instances).toHaveLength(1);
  });
});

describe('reconnectAll during an account switch', () => {
  it('spaces the sweep out instead of opening every socket at once', async () => {
    const pool = createPool();
    for (const symbol of ['EURUSD', 'GBPUSD', 'XAUUSD', 'USDJPY']) {
      pool.subscribe({ family: 'quote', symbol }, () => {});
    }
    for (const socket of FakeSocket.instances) socket.open();
    const before = FakeSocket.instances.length;

    pool.reconnectAll('token renewed');
    // Nothing opens synchronously any more.
    expect(FakeSocket.instances.length).toBe(before);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeSocket.instances.length).toBe(before * 2);
  });

  it('a second sweep supersedes the first rather than racing it', async () => {
    const pool = createPool();
    for (const symbol of ['EURUSD', 'GBPUSD', 'XAUUSD']) {
      pool.subscribe({ family: 'quote', symbol }, () => {});
    }
    for (const socket of FakeSocket.instances) socket.open();
    const before = FakeSocket.instances.length;

    // Three switches in quick succession, none of the sweeps yet settled.
    pool.reconnectAll('token renewed');
    await vi.advanceTimersByTimeAsync(20);
    pool.reconnectAll('token renewed');
    await vi.advanceTimersByTimeAsync(20);
    pool.reconnectAll('token renewed');
    await vi.advanceTimersByTimeAsync(1_000);

    // Sockets already opened by an earlier sweep are closed, not left dangling,
    // and each channel ends with exactly one live socket rather than one per
    // sweep fighting over the same subscription.
    const live = FakeSocket.instances.filter((socket) => !socket.closed);
    expect(live).toHaveLength(before);
  });

  it('keeps the attempt count of a channel already mid-handshake', async () => {
    // Wiping it meant a switching storm could never exhaust the budget, so
    // the channel never reached `failed` and probation never armed.
    const pool = createPool({ connectTimeoutMs: 1_000, maxAttempts: 2, maxBackoffMs: 50 });
    const states: string[] = [];
    pool.subscribe(
      { family: 'quote', symbol: 'EURUSD' },
      () => {},
      (status) => states.push(status.state),
    );

    for (let i = 0; i < 4; i++) {
      pool.reconnectAll('token renewed');
      await vi.advanceTimersByTimeAsync(1_200);
    }

    expect(states).toContain('failed');
  });
});
