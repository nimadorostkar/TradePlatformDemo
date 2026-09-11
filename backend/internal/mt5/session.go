// Package mt5 manages the authenticated session(s) to the MetaTrader 5 Manager
// Web API and proxies REST calls to it. It reproduces the .NET behavior: a
// keep-alive connection bound to its auth cookie, a periodic ping, and
// re-authentication after consecutive failures — generalized to a bounded pool
// (PoolSize=1 = exact parity). See docs/ANALYSIS.md §7 and docs/ARCHITECTURE.md §5.1.
package mt5

import (
	"context"
	"log/slog"
	"sync"
	"time"
)

// Config holds the MT5 connection settings (a flattened view of config.MT5).
type Config struct {
	BaseURL                string // "https://host:port"
	Login                  uint64
	Password               string
	Version                string
	Agent                  string
	Type                   string
	PoolSize               int
	PingInterval           time.Duration
	MaxConsecutiveFailures int
	RequestTimeout         time.Duration
	DialTimeout            time.Duration
	MaxResponseBytes       int64

	// OnReauthFailure, when set, is called once per failed re-authentication.
	// It exists so a sustained broker rejection is alertable from metrics
	// rather than only discoverable by reading the log. Optional; must be
	// safe for concurrent use.
	OnReauthFailure func()

	// OnUpstreamError, when set, is called for every non-2xx answer from the
	// trade server, with the request path stripped of its query string and the
	// status.
	//
	// It exists because "403s are elevated" is not an actionable statement. The
	// rate was measurable but the CULPRIT was not: the existing counter carries
	// only a coarse result label, so attributing a 403 to a specific endpoint
	// meant grepping the log by hand. Deciding whether an endpoint's 403 means
	// "your session is gone" or "you may not do this" — the session-neutral
	// allowlist in conn.go — needs exactly this attribution.
	//
	// The path arrives WITHOUT its query string, and callers must keep it that
	// way: MT5 query strings carry symbols, logins and ticket ids, which as a
	// metric label would be unbounded cardinality. Optional; must be safe for
	// concurrent use.
	OnUpstreamError func(endpoint string, status int)
}

// Manager owns the connection pool and hands out connections per request.
type Manager struct {
	cfg   Config
	log   *slog.Logger
	conns []*conn
	pool  chan *conn

	wg     sync.WaitGroup
	stopMu sync.Mutex
	stop   context.CancelFunc
}

// NewManager builds the pool (not yet authenticated; call Start).
func NewManager(cfg Config, log *slog.Logger) (*Manager, error) {
	if cfg.PoolSize < 1 {
		cfg.PoolSize = 1
	}
	m := &Manager{
		cfg:  cfg,
		log:  log.With(slog.String("component", "mt5")),
		pool: make(chan *conn, cfg.PoolSize),
	}
	for i := 0; i < cfg.PoolSize; i++ {
		c, err := newConn(i, cfg, m.log)
		if err != nil {
			return nil, err
		}
		m.conns = append(m.conns, c)
		m.pool <- c
	}
	return m, nil
}

// Start authenticates every connection and launches per-connection ping loops.
// It returns an error only if no connection could authenticate; partial success
// is tolerated (degraded but serving).
func (m *Manager) Start(ctx context.Context) error {
	pingCtx, cancel := context.WithCancel(context.Background())
	m.stopMu.Lock()
	m.stop = cancel
	m.stopMu.Unlock()

	authed := 0
	for _, c := range m.conns {
		if err := c.authenticate(ctx); err != nil {
			m.log.Warn("mt5 conn initial auth failed", slog.Int("conn", c.id), slog.Any("error", err))
		} else {
			authed++
		}
		m.wg.Add(1)
		go m.pingLoop(pingCtx, c)
	}
	if authed == 0 {
		m.log.Error("no MT5 connection authenticated at startup; will keep retrying via ping loop")
	}
	m.log.Info("mt5 manager started", slog.Int("pool_size", m.cfg.PoolSize), slog.Int("authenticated", authed))
	return nil
}

// pingLoop keeps a connection warm and re-authenticates it on failure.
func (m *Manager) pingLoop(ctx context.Context, c *conn) {
	defer m.wg.Done()
	ticker := time.NewTicker(m.cfg.PingInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			reqCtx, cancel := context.WithTimeout(ctx, m.cfg.RequestTimeout)
			c.ping(reqCtx)
			cancel()
		}
	}
}

// Stop cancels ping loops and waits for them to exit.
func (m *Manager) Stop() {
	m.stopMu.Lock()
	if m.stop != nil {
		m.stop()
	}
	m.stopMu.Unlock()
	m.wg.Wait()
}

// Ready reports whether at least one connection is authenticated.
func (m *Manager) Ready() bool {
	for _, c := range m.conns {
		if c.authenticated.Load() {
			return true
		}
	}
	return false
}

// Get acquires a connection, performs a GET on the given path (path only — the
// host is prepended internally), and returns the raw response body on success.
func (m *Manager) Get(ctx context.Context, path string) ([]byte, error) {
	c, err := m.acquire(ctx)
	if err != nil {
		return nil, err
	}
	defer m.release(c)
	return c.do(ctx, "GET", path, nil)
}

// Post acquires a connection and performs a POST with a JSON body.
func (m *Manager) Post(ctx context.Context, path string, body []byte) ([]byte, error) {
	c, err := m.acquire(ctx)
	if err != nil {
		return nil, err
	}
	defer m.release(c)
	return c.do(ctx, "POST", path, body)
}

// acquire blocks until a pooled connection is free or the context is done.
func (m *Manager) acquire(ctx context.Context) (*conn, error) {
	select {
	case c := <-m.pool:
		return c, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (m *Manager) release(c *conn) { m.pool <- c }
