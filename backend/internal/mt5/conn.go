package mt5

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math/rand/v2"
	"net"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"sync"
	"sync/atomic"
	"time"
)

// conn is a single authenticated MT5 connection. It owns an *http.Client whose
// transport is pinned to ONE keep-alive TCP connection with a cookie jar — the
// MT5 Manager session is bound to that connection + cookie (docs/ANALYSIS.md
// §7.3). A mutex serializes the handshake, data requests, and ping on this conn.
type conn struct {
	id     int
	base   string // "https://host:port"
	cfg    Config
	log    *slog.Logger
	client *http.Client

	mu            sync.Mutex
	authenticated atomic.Bool
	failures      atomic.Int32

	// Re-auth backoff state. All of it is read and written under mu, which
	// ping already holds, so no extra synchronization is needed.
	//
	// The ping loop used to retry authentication on every tick for as long as
	// the upstream kept refusing. A real 7-hour rejection produced 645 auth
	// attempts and 645 identical WARN lines: the log said the same thing 645
	// times and never said the one thing an operator needs, which is when it
	// started and when it came back. Hammering an endpoint that is answering
	// 403 can also be what sustains a broker-side lockout.
	reauthFailures  int       // consecutive failed authentications
	nextAuthAttempt time.Time // do not try again before this
	authDownSince   time.Time // when the current outage began
	lastAuthLog     time.Time // when we last logged about this outage
	suppressedLogs  int       // failures not logged since lastAuthLog
}

// Re-auth backoff bounds. The cap is deliberately short: this is a trading
// gateway, and the common case is a weekly broker maintenance window lasting
// three to seven minutes, so recovery latency matters more than politeness.
// Capping at two minutes bounds the worst-case added delay at two minutes while
// still cutting a multi-hour outage from hundreds of auth attempts to dozens.
const (
	minReauthBackoff = 5 * time.Second
	maxReauthBackoff = 2 * time.Minute
	// reauthLogInterval is how often a continuing outage is re-logged. The
	// first failure and the recovery are always logged.
	reauthLogInterval = 5 * time.Minute
)

// reauthBackoff returns the delay before the nth consecutive retry, doubling
// from minReauthBackoff to maxReauthBackoff with ±20% jitter so that pooled
// connections (and restarted pods) do not retry in lockstep.
func reauthBackoff(consecutiveFailures int) time.Duration {
	d := minReauthBackoff
	for i := 1; i < consecutiveFailures && d < maxReauthBackoff; i++ {
		d *= 2
	}
	if d > maxReauthBackoff {
		d = maxReauthBackoff
	}
	jitter := 1 + (rand.Float64()*0.4 - 0.2) // ±20%
	return time.Duration(float64(d) * jitter)
}

// noteAuthFailure records a failed authentication, schedules the next attempt,
// and reports whether this one should be logged. Called under mu.
func (c *conn) noteAuthFailure(now time.Time) (shouldLog bool, suppressed int) {
	c.reauthFailures++
	if c.authDownSince.IsZero() {
		c.authDownSince = now
	}
	c.nextAuthAttempt = now.Add(reauthBackoff(c.reauthFailures))

	if c.reauthFailures == 1 || now.Sub(c.lastAuthLog) >= reauthLogInterval {
		c.lastAuthLog = now
		s := c.suppressedLogs
		c.suppressedLogs = 0
		return true, s
	}
	c.suppressedLogs++
	return false, 0
}

// noteAuthSuccess clears the outage and returns how long it lasted and how many
// attempts it took, so recovery is one readable line. Called under mu.
func (c *conn) noteAuthSuccess(now time.Time) (recovered bool, downFor time.Duration, attempts int) {
	if c.reauthFailures == 0 {
		return false, 0, 0
	}
	attempts = c.reauthFailures
	downFor = now.Sub(c.authDownSince)
	c.reauthFailures = 0
	c.suppressedLogs = 0
	c.authDownSince = time.Time{}
	c.lastAuthLog = time.Time{}
	c.nextAuthAttempt = time.Time{}
	return true, downFor, attempts
}

// newConn constructs a conn with a pinned HTTP/1.1 keep-alive transport.
func newConn(id int, cfg Config, log *slog.Logger) (*conn, error) {
	if cfg.MaxResponseBytes <= 0 {
		cfg.MaxResponseBytes = 32 << 20
	}
	jar, err := cookiejar.New(nil)
	if err != nil {
		return nil, fmt.Errorf("cookie jar: %w", err)
	}
	dialTimeout := cfg.DialTimeout
	if dialTimeout <= 0 {
		dialTimeout = 5 * time.Second
	}
	transport := &http.Transport{
		// Pin to a single upstream connection, mirroring the .NET
		// MaxConnectionsPerServer=1 design that keeps auth on one socket.
		MaxConnsPerHost:     1,
		MaxIdleConnsPerHost: 1,
		MaxIdleConns:        1,
		IdleConnTimeout:     600 * time.Second,
		ForceAttemptHTTP2:   false, // keep HTTP/1.1 keep-alive semantics
		// Without an explicit dial timeout a broker that silently drops SYNs
		// (observed 2026-08-24: the farm's whitelist dropping this gateway's
		// IP) costs every caller the OS connect timeout — ~21s on Windows —
		// before the request even fails. Bound the connect and TLS phases so
		// an unreachable upstream fails in seconds and the circuit breaker
		// takes over; an ESTABLISHED connection's slow reads still get the
		// full RequestTimeout.
		DialContext: (&net.Dialer{
			Timeout:   dialTimeout,
			KeepAlive: 30 * time.Second,
		}).DialContext,
		TLSHandshakeTimeout: dialTimeout,
	}
	return &conn{
		id:   id,
		base: cfg.BaseURL,
		cfg:  cfg,
		log:  log.With(slog.Int("mt5_conn", id)),
		client: &http.Client{
			Transport: transport,
			Jar:       jar,
			Timeout:   cfg.RequestTimeout,
		},
	}, nil
}

// authenticate performs the two-step MT5 handshake (auth/start → auth/answer).
// On HTTP 200 from auth/answer the session cookie is captured by the jar.
func (c *conn) authenticate(ctx context.Context) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.authenticateLocked(ctx)
}

func (c *conn) authenticateLocked(ctx context.Context) error {
	// Step 1: auth/start
	startPath := fmt.Sprintf(PathAuthStart, c.cfg.Version, c.cfg.Agent, c.cfg.Login, c.cfg.Type)
	body, status, err := c.rawGet(ctx, startPath)
	if err != nil {
		return fmt.Errorf("auth/start: %w", err)
	}
	if status != http.StatusOK {
		return fmt.Errorf("auth/start: unexpected status %d", status)
	}
	var start authStartResponse
	if err := json.Unmarshal(body, &start); err != nil {
		return fmt.Errorf("auth/start decode: %w", err)
	}
	if start.SrvRand == "" {
		return fmt.Errorf("auth/start: empty srv_rand (retcode=%q)", start.Retcode)
	}

	// Step 2: compute answer + client nonce
	answer, err := srvRandAnswer(c.cfg.Password, start.SrvRand)
	if err != nil {
		return err
	}
	cliRand, err := newCliRand()
	if err != nil {
		return err
	}

	// Step 3: auth/answer — HTTP 200 means authenticated.
	answerPath := fmt.Sprintf(PathAuthAnswer, answer, cliRand)
	_, status, err = c.rawGet(ctx, answerPath)
	if err != nil {
		return fmt.Errorf("auth/answer: %w", err)
	}
	if status != http.StatusOK {
		c.authenticated.Store(false)
		return fmt.Errorf("auth/answer: unexpected status %d", status)
	}

	c.authenticated.Store(true)
	c.failures.Store(0)
	c.log.Info("mt5 session authenticated")
	return nil
}

// do executes a request on this conn, (re)authenticating if needed, and tracks
// consecutive failures to drive re-auth. Returns the response body on 2xx with a
// non-empty body; otherwise an error (matching the .NET success criteria).
func (c *conn) do(ctx context.Context, method, path string, reqBody []byte) ([]byte, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if !c.authenticated.Load() {
		if err := c.authenticateLocked(ctx); err != nil {
			return nil, err
		}
	}

	body, status, err := c.executeWithRetry(ctx, method, path, reqBody)
	if err != nil {
		c.noteFailure()
		return nil, err
	}
	if status < 200 || status >= 300 {
		if replayed, rBody, rErr := c.reauthAndReplayLocked(ctx, method, path, reqBody, status); replayed {
			return rBody, rErr
		}
		c.noteHTTPFailure(status, path)
		return nil, &UpstreamError{Status: status, Body: body}
	}
	if len(body) == 0 {
		// .NET treated empty bodies as failure.
		c.noteFailure()
		return nil, &UpstreamError{Status: status, Body: nil}
	}
	c.failures.Store(0)
	return body, nil
}

// reauthAndReplayLocked absorbs the broker's session FLAP: an authenticated
// read answered 401/403 by an upstream that accepts a fresh handshake one
// second later (observed live 2026-08-24 — the trade server refused single
// requests every minute or two while every re-auth succeeded immediately).
//
// Before this, one flapped request cost THREE parties: the caller got the
// error, the session was declared dead, and the next caller paid the full
// re-auth latency. Now the flapped call re-authenticates in place and replays
// itself once, so a flap costs one caller ~a second and nobody an error.
//
// Strictly bounded: only reads on the retry-safe allowlist are replayed
// (replaying a mutation after an ambiguous answer can apply it twice), only
// ONE replay is attempted, and a replay that is refused AGAIN is treated as
// the real session rejection it now demonstrably is. Called under mu; reports
// whether it handled the failure, and if so, the result to return.
func (c *conn) reauthAndReplayLocked(
	ctx context.Context, method, path string, reqBody []byte, status int,
) (replayed bool, body []byte, err error) {
	if status != http.StatusUnauthorized && status != http.StatusForbidden {
		return false, nil, nil
	}
	if sessionNeutralPath(path) || !retrySafeMT5Read(method, path) {
		return false, nil, nil
	}

	// The refusal itself is still reported: the metric describes what the
	// trade server said, not what this gateway managed to hide.
	if c.cfg.OnUpstreamError != nil {
		c.cfg.OnUpstreamError(endpointLabel(path), status)
	}

	if aerr := c.authenticateLocked(ctx); aerr != nil {
		// The handshake was refused too — this is a genuinely dead session,
		// exactly what the pre-replay behavior assumed every 403 to be.
		c.authenticated.Store(false)
		c.failures.Store(0)
		c.log.Warn("mt5 session rejected by upstream", slog.Int("status", status))
		return true, nil, &UpstreamError{Status: status}
	}

	rBody, rStatus, rErr := c.executeWithRetry(ctx, method, path, reqBody)
	switch {
	case rErr != nil:
		c.noteFailure()
		return true, nil, rErr
	case rStatus >= 200 && rStatus < 300 && len(rBody) > 0:
		c.failures.Store(0)
		c.log.Info("mt5 read replayed through a session flap",
			slog.String("endpoint", endpointLabel(path)), slog.Int("refused_status", status))
		return true, rBody, nil
	case rStatus >= 200 && rStatus < 300:
		c.noteFailure()
		return true, nil, &UpstreamError{Status: rStatus, Body: nil}
	default:
		// Refused twice across a fresh handshake: the ordinary path decides,
		// and for a second 401/403 that means invalidating the session.
		c.noteHTTPFailure(rStatus, path)
		return true, nil, &UpstreamError{Status: rStatus, Body: rBody}
	}
}

// noteFailure increments the consecutive-failure counter and drops the auth
// flag once the threshold is reached, forcing re-auth on the next request.
func (c *conn) noteFailure() {
	if c.failures.Add(1) >= int32(c.cfg.MaxConsecutiveFailures) {
		c.authenticated.Store(false)
		c.failures.Store(0)
		c.log.Warn("mt5 conn marked unauthenticated after consecutive failures")
	}
}

// sessionNeutralPath reports whether a 401/403 on this path describes the
// OPERATION rather than the session.
//
// A Manager Web API answers "you may not do this" and "your session is gone"
// with the same status. For most endpoints, assuming the latter is right and
// safe. For an OPTIONAL capability probe it is neither: the call is expected to
// be refused on deployments that do not offer it, and treating each refusal as
// a dead session invalidates the shared Manager connection and forces a global
// re-auth. A polled probe then re-refuses on the next tick, and the gateway
// spends its life re-authenticating — observed live at ~33x the normal 403
// rate after market-depth subscription was introduced, while every trading
// call on the same connection paid the re-auth latency.
//
// An allowlist, not a heuristic: an endpoint earns session-neutral treatment
// only once someone has reasoned about what its 403 actually means.
func sessionNeutralPath(path string) bool {
	u, err := url.Parse(path)
	if err != nil {
		return false
	}
	switch u.Path {
	// Depth subscription is optional and per-symbol: refused for an instrument
	// with no book, or wholesale on a server without the command. Neither says
	// anything about whether this Manager session is still valid — and
	// GetMarketDepth already degrades to an empty ladder on failure.
	case "/api/book/subscribe":
		return true
	default:
		return false
	}
}

// endpointLabel reduces a request path to something safe to use as a metric
// label: the path alone, with the query string discarded.
//
// MT5 query strings carry symbols, logins, ticket ids and time windows. Using
// the raw path would mint a new time series per symbol per login — unbounded
// cardinality, which takes the metrics backend down rather than explaining
// anything. An unparseable path is reported as "invalid" rather than passed
// through, for the same reason.
func endpointLabel(path string) string {
	u, err := url.Parse(path)
	if err != nil {
		return "invalid"
	}
	if u.Path == "" {
		return "unknown"
	}
	return u.Path
}

// noteHTTPFailure distinguishes a rejected business request from a broken
// Manager session. Invalid symbols, tickets, volumes, and other ordinary 4xx
// responses must not let a client force repeated global reauthentication.
// Authentication rejection is definitive and invalidates the session at once —
// except on the session-neutral paths above, where a refusal is about the
// operation. Repeated server failures still use the configured threshold
// because they can indicate a dead/stale upstream session.
func (c *conn) noteHTTPFailure(status int, path string) {
	// Reported for EVERY non-2xx, before the session-health decision below, so
	// the metric describes what the trade server actually said rather than what
	// this gateway concluded from it.
	if c.cfg.OnUpstreamError != nil {
		c.cfg.OnUpstreamError(endpointLabel(path), status)
	}

	switch {
	case status == http.StatusUnauthorized || status == http.StatusForbidden:
		if sessionNeutralPath(path) {
			// Refused, but the session is untouched. The caller sees the
			// UpstreamError and decides; nothing global changes here.
			c.failures.Store(0)
			return
		}
		c.authenticated.Store(false)
		c.failures.Store(0)
		c.log.Warn("mt5 session rejected by upstream", slog.Int("status", status))
	case status >= http.StatusInternalServerError:
		c.noteFailure()
	default:
		// Business/client response. It is returned to the caller but says
		// nothing about the health of this authenticated connection.
		c.failures.Store(0)
	}
}

// ping issues a lightweight keep-alive request; on failure it forces re-auth.
func (c *conn) ping(ctx context.Context) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.authenticated.Load() {
		c.tryReauthLocked(ctx)
		return
	}
	_, status, err := c.rawGet(ctx, PathPing)
	if err != nil || status != http.StatusOK {
		c.authenticated.Store(false)
		// Logged once per outage, not once per tick: the re-auth path below
		// reports the episode, and a dead session produces one of these every
		// ping interval for as long as it stays dead.
		if c.reauthFailures == 0 {
			c.log.Warn("mt5 ping failed, will re-auth", slog.Int("status", status), slog.Any("error", err))
		}
		c.tryReauthLocked(ctx)
	}
}

// tryReauthLocked re-authenticates unless the backoff window says to wait.
// Called under mu.
func (c *conn) tryReauthLocked(ctx context.Context) {
	now := time.Now()
	if !c.nextAuthAttempt.IsZero() && now.Before(c.nextAuthAttempt) {
		return // still backing off; the next ping tick will look again
	}

	if err := c.authenticateLocked(ctx); err != nil {
		if c.cfg.OnReauthFailure != nil {
			c.cfg.OnReauthFailure()
		}
		shouldLog, suppressed := c.noteAuthFailure(now)
		if shouldLog {
			attrs := []any{
				slog.Any("error", err),
				slog.Int("consecutive_failures", c.reauthFailures),
				// Rendered as strings: slog's JSON handler writes a Duration as
				// raw nanoseconds, and "83999455323" is not something an
				// operator reads at 3am.
				slog.String("retry_in", time.Until(c.nextAuthAttempt).Round(time.Second).String()),
			}
			if !c.authDownSince.IsZero() {
				attrs = append(attrs, slog.String("down_for", now.Sub(c.authDownSince).Round(time.Second).String()))
			}
			if suppressed > 0 {
				attrs = append(attrs, slog.Int("suppressed_since_last_log", suppressed))
			}
			c.log.Warn("mt5 ping re-auth failed", attrs...)
		}
		return
	}

	if recovered, downFor, attempts := c.noteAuthSuccess(now); recovered {
		c.log.Warn("mt5 session recovered",
			slog.String("down_for", downFor.Round(time.Second).String()),
			slog.Int("attempts", attempts))
	}
}

// executeWithRetry retries transient transport errors only for explicitly
// read-only MT5 operations. Dealer submissions, POSTs, and the Manager API's
// legacy mutation-via-GET endpoints receive exactly one attempt: after a lost
// response their outcome is ambiguous, and replaying can apply the action twice.
func (c *conn) executeWithRetry(ctx context.Context, method, path string, reqBody []byte) ([]byte, int, error) {
	maxAttempts := 1
	if retrySafeMT5Read(method, path) {
		maxAttempts = 3
	}
	const baseBackoff = 50 * time.Millisecond
	var lastErr error
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		body, status, err := c.rawDo(ctx, method, path, reqBody)
		if err == nil {
			return body, status, nil
		}
		lastErr = err
		if ctx.Err() != nil {
			return nil, 0, ctx.Err()
		}
		if attempt < maxAttempts {
			backoff := baseBackoff << (attempt - 1)
			t := time.NewTimer(backoff)
			select {
			case <-t.C:
			case <-ctx.Done():
				t.Stop()
				return nil, 0, ctx.Err()
			}
		}
	}
	return nil, 0, lastErr
}

// retrySafeMT5Read is intentionally an allowlist. New MT5 endpoints do not gain
// automatic replay until their semantics have been reviewed.
func retrySafeMT5Read(method, path string) bool {
	if method != http.MethodGet {
		return false
	}
	u, err := url.Parse(path)
	if err != nil {
		return false
	}
	switch u.Path {
	case "/api/order/get", "/api/order/get_total", "/api/order/get_page", "/api/order/get_batch",
		"/api/order/backup/list", "/api/order/backup/get",
		"/api/history/get", "/api/history/get_total", "/api/history/get_page", "/api/history/get_batch",
		"/api/deal/get", "/api/deal/get_total", "/api/deal/get_page", "/api/deal/get_batch",
		"/api/deal/backup/list", "/api/deal/backup/get",
		"/api/position/get", "/api/position/get_total", "/api/position/get_page", "/api/position/get_batch",
		"/api/position/backup/list", "/api/position/backup/get", "/api/position/check",
		"/api/trade/calc_rate_buy", "/api/trade/calc_rate_sell", "/api/trade/check_margin", "/api/trade/calc_profit",
		"/api/dealer/get_request_result",
		"/api/tick/last", "/api/tick/last_group", "/api/tick/stat", "/api/tick/history",
		// Subscribing twice leaves the connection in the same state as
		// subscribing once, so a replayed subscribe is harmless.
		"/api/chart/get", "/api/book/get", "/api/book/subscribe",
		"/api/user/get", "/api/user/account/get",
		"/api/symbol/list", "/api/symbol/get", "/api/symbol/get_group", "/api/group/get":
		return true
	default:
		return false
	}
}

func (c *conn) rawGet(ctx context.Context, path string) ([]byte, int, error) {
	return c.rawDo(ctx, http.MethodGet, path, nil)
}

// rawDo performs a single HTTP request to base+path.
func (c *conn) rawDo(ctx context.Context, method, path string, reqBody []byte) ([]byte, int, error) {
	var bodyReader io.Reader
	if reqBody != nil {
		bodyReader = bytes.NewReader(reqBody)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.base+path, bodyReader)
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("Connection", "keep-alive")
	if reqBody != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := c.client.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, c.cfg.MaxResponseBytes+1))
	if err != nil {
		return nil, resp.StatusCode, err
	}
	if int64(len(body)) > c.cfg.MaxResponseBytes {
		return nil, resp.StatusCode, fmt.Errorf("mt5 response exceeds %d bytes", c.cfg.MaxResponseBytes)
	}
	return body, resp.StatusCode, nil
}

// UpstreamError represents a non-success MT5 response.
type UpstreamError struct {
	Status int
	Body   []byte
}

func (e *UpstreamError) Error() string {
	return fmt.Sprintf("mt5 upstream status %d", e.Status)
}

// ErrNotReady indicates no authenticated connection is available.
var ErrNotReady = errors.New("mt5: no authenticated connection available")
