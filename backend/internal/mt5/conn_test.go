package mt5

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func testConn(t *testing.T, base string) *conn {
	t.Helper()
	c, err := newConn(0, Config{BaseURL: base, RequestTimeout: 2 * time.Second}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	return c
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestRetrySafeMT5Read_FailsClosedForMutations(t *testing.T) {
	tests := []struct {
		method, path string
		want         bool
	}{
		{http.MethodGet, "/api/order/get_page?login=1", true},
		{http.MethodGet, "/api/dealer/get_request_result?id=7", true},
		{http.MethodPost, "/api/dealer/send_request", false},
		{http.MethodGet, "/api/order/cancel?ticket=7", false},
		{http.MethodGet, "/api/position/fix?login=1", false},
		{http.MethodGet, "/api/trade/balance?login=1", false},
		{http.MethodGet, "/api/future/unknown", false},
	}
	for _, tc := range tests {
		if got := retrySafeMT5Read(tc.method, tc.path); got != tc.want {
			t.Errorf("retrySafeMT5Read(%q, %q) = %v, want %v", tc.method, tc.path, got, tc.want)
		}
	}
}

func TestExecuteWithRetry_DoesNotReplayPost(t *testing.T) {
	requests := 0
	c := testConn(t, "http://mt5.invalid")
	c.client.Transport = roundTripFunc(func(_ *http.Request) (*http.Response, error) {
		requests++
		return nil, errors.New("connection lost after write")
	})

	_, _, err := c.executeWithRetry(context.Background(), http.MethodPost, "/api/dealer/send_request", []byte(`{}`))
	if err == nil {
		t.Fatal("expected transport error")
	}
	if requests != 1 {
		t.Fatalf("dealer POST reached upstream %d times, want exactly 1", requests)
	}
}

func TestRawDo_RejectsOversizedResponse(t *testing.T) {
	c := testConn(t, "http://mt5.invalid")
	c.cfg.MaxResponseBytes = 4
	c.client.Transport = roundTripFunc(func(_ *http.Request) (*http.Response, error) {
		return &http.Response{
			StatusCode: http.StatusOK,
			Body:       io.NopCloser(strings.NewReader("12345")),
			Header:     make(http.Header),
		}, nil
	})
	_, _, err := c.rawDo(context.Background(), http.MethodGet, "/", nil)
	if err == nil {
		t.Fatal("expected oversized response error")
	}
}

func TestHTTPBusinessErrorsDoNotInvalidateSession(t *testing.T) {
	c := testConn(t, "http://mt5.invalid")
	c.cfg.MaxConsecutiveFailures = 2
	c.authenticated.Store(true)

	for range 10 {
		c.noteHTTPFailure(http.StatusBadRequest, "/api/order/get")
	}

	if !c.authenticated.Load() {
		t.Fatal("ordinary MT5 business errors invalidated the shared Manager session")
	}
	if failures := c.failures.Load(); failures != 0 {
		t.Fatalf("business errors accumulated %d session failures, want 0", failures)
	}
}

func TestHTTPSessionFailuresInvalidateAuthentication(t *testing.T) {
	t.Run("auth rejection is immediate", func(t *testing.T) {
		c := testConn(t, "http://mt5.invalid")
		c.cfg.MaxConsecutiveFailures = 3
		c.authenticated.Store(true)

		c.noteHTTPFailure(http.StatusUnauthorized, "/api/order/get")

		if c.authenticated.Load() {
			t.Fatal("401 left the Manager session authenticated")
		}
	})

	t.Run("server failures use threshold", func(t *testing.T) {
		c := testConn(t, "http://mt5.invalid")
		c.cfg.MaxConsecutiveFailures = 2
		c.authenticated.Store(true)

		c.noteHTTPFailure(http.StatusServiceUnavailable, "/api/order/get")
		if !c.authenticated.Load() {
			t.Fatal("one transient 503 invalidated the Manager session")
		}
		c.noteHTTPFailure(http.StatusServiceUnavailable, "/api/order/get")
		if c.authenticated.Load() {
			t.Fatal("repeated 503s did not invalidate the Manager session")
		}
	})
}

func TestPingReauthenticatesAfterSessionLoss(t *testing.T) {
	var authStarts atomic.Int32
	mux := http.NewServeMux()
	mux.HandleFunc("/api/test/access", func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "session expired", http.StatusForbidden)
	})
	mux.HandleFunc("/api/auth/start", func(w http.ResponseWriter, _ *http.Request) {
		authStarts.Add(1)
		_, _ = io.WriteString(w, `{"retcode":"0 Done","srv_rand":"a1b2c3d4e5f60718293a4b5c6d7e8f90"}`)
	})
	mux.HandleFunc("/api/auth/answer", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{"retcode":"0 Done"}`)
	})
	server := httptest.NewServer(mux)
	defer server.Close()

	c := testConn(t, server.URL)
	c.cfg.Password = "test"
	c.authenticated.Store(true)
	c.ping(context.Background())

	if !c.authenticated.Load() {
		t.Fatal("ping did not restore authentication after the upstream rejected the session")
	}
	if got := authStarts.Load(); got != 1 {
		t.Fatalf("auth/start requests = %d, want exactly 1", got)
	}
}

// Retries must back off (50ms + 100ms between the 3 attempts), not hammer a
// struggling MT5 with back-to-back requests.
func TestExecuteWithRetry_BacksOffBetweenAttempts(t *testing.T) {
	// Unroutable base → every attempt fails at the transport layer.
	c := testConn(t, "http://127.0.0.1:1")

	start := time.Now()
	_, _, err := c.executeWithRetry(context.Background(), http.MethodGet, "/api/tick/last?symbol=EURUSD", nil)
	elapsed := time.Since(start)

	if err == nil {
		t.Fatal("expected transport error")
	}
	if elapsed < 150*time.Millisecond {
		t.Errorf("3 attempts completed in %v; want >= 150ms of backoff between retries", elapsed)
	}
}

// Backoff must abort as soon as the context is cancelled.
func TestExecuteWithRetry_BackoffRespectsCancel(t *testing.T) {
	c := testConn(t, "http://127.0.0.1:1")

	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(20 * time.Millisecond) // cancel during the first backoff window
		cancel()
	}()

	start := time.Now()
	_, _, err := c.executeWithRetry(ctx, http.MethodGet, "/api/tick/last?symbol=EURUSD", nil)
	elapsed := time.Since(start)

	if err == nil {
		t.Fatal("expected error after cancel")
	}
	if elapsed > 120*time.Millisecond {
		t.Errorf("executeWithRetry blocked %v after cancel; want prompt return", elapsed)
	}
}

// A refused OPTIONAL capability probe must not condemn the shared session.
//
// This is a regression test for a live incident: market-depth subscription was
// introduced, `/api/book/subscribe` came back 403, and because 403 was treated
// as "session dead" every refusal invalidated the shared Manager connection.
// The depth poller then re-refused on its next tick, and the gateway's 403 rate
// rose ~33x while every trading call on that connection paid re-auth latency.
func TestSessionNeutralPathRefusalKeepsSession(t *testing.T) {
	for _, status := range []int{http.StatusUnauthorized, http.StatusForbidden} {
		c := testConn(t, "http://mt5.invalid")
		c.authenticated.Store(true)

		for range 10 {
			c.noteHTTPFailure(status, "/api/book/subscribe?symbol=XAUUSD")
		}

		if !c.authenticated.Load() {
			t.Fatalf("status %d on an optional probe invalidated the Manager session", status)
		}
		if failures := c.failures.Load(); failures != 0 {
			t.Fatalf("status %d on an optional probe accumulated %d failures, want 0", status, failures)
		}
	}
}

// The carve-out is an allowlist, so a 403 anywhere else still means what it
// always meant. Losing this would silently stop the gateway noticing a dead
// session.
func TestSessionNeutralPathIsNarrow(t *testing.T) {
	for _, path := range []string{
		"/api/book/get?symbol=XAUUSD",
		"/api/order/get?login=1",
		"/api/dealer/send_request",
		"/api/auth/start",
	} {
		c := testConn(t, "http://mt5.invalid")
		c.authenticated.Store(true)

		c.noteHTTPFailure(http.StatusForbidden, path)

		if c.authenticated.Load() {
			t.Fatalf("a 403 on %s left the session marked authenticated", path)
		}
	}
}

func TestSessionNeutralPathIgnoresQueryString(t *testing.T) {
	if !sessionNeutralPath("/api/book/subscribe?symbol=EURUSD%23") {
		t.Fatal("query string defeated the path match")
	}
	if sessionNeutralPath("/api/book/subscribe/../order/get") {
		t.Fatal("path traversal was treated as session-neutral")
	}
}

// Metric labels must not carry unbounded values. MT5 query strings hold
// symbols, logins and ticket ids, so labelling with the raw path would mint a
// time series per symbol per login and take the metrics backend down instead of
// explaining the 403.
func TestEndpointLabelDropsTheQueryString(t *testing.T) {
	cases := map[string]string{
		"/api/book/subscribe?symbol=XAUUSD":           "/api/book/subscribe",
		"/api/order/get?login=15597243":               "/api/order/get",
		"/api/tick/history?symbol=EURUSD&from=1&to=2": "/api/tick/history",
		"/api/symbol/get?symbol=EURUSD%23":            "/api/symbol/get",
		"/api/book/get":                               "/api/book/get",
	}
	for path, want := range cases {
		if got := endpointLabel(path); got != want {
			t.Errorf("endpointLabel(%q) = %q, want %q", path, got, want)
		}
	}
}

// Every non-2xx is reported, whatever the gateway then concludes about session
// health — the metric describes what the trade server said, not our reading of
// it. Without this, a session-neutral refusal would be invisible in metrics
// precisely when someone is trying to attribute it.
func TestUpstreamErrorHookSeesEveryNon2xx(t *testing.T) {
	type observed struct {
		endpoint string
		status   int
	}
	var seen []observed

	c := testConn(t, "http://mt5.invalid")
	c.cfg.OnUpstreamError = func(endpoint string, status int) {
		seen = append(seen, observed{endpoint, status})
	}
	c.authenticated.Store(true)

	// A session-neutral refusal, an ordinary business error, and a real session
	// rejection.
	c.noteHTTPFailure(http.StatusForbidden, "/api/book/subscribe?symbol=XAUUSD")
	c.noteHTTPFailure(http.StatusBadRequest, "/api/order/get?login=1")
	c.noteHTTPFailure(http.StatusForbidden, "/api/book/get?symbol=XAUUSD")

	want := []observed{
		{"/api/book/subscribe", 403},
		{"/api/order/get", 400},
		{"/api/book/get", 403},
	}
	if len(seen) != len(want) {
		t.Fatalf("recorded %d upstream errors, want %d: %+v", len(seen), len(want), seen)
	}
	for i := range want {
		if seen[i] != want[i] {
			t.Errorf("error %d = %+v, want %+v", i, seen[i], want[i])
		}
	}
}

// The hook is optional; a conn without one must not panic.
func TestUpstreamErrorHookIsOptional(t *testing.T) {
	c := testConn(t, "http://mt5.invalid")
	c.cfg.OnUpstreamError = nil
	c.authenticated.Store(true)
	c.noteHTTPFailure(http.StatusForbidden, "/api/book/get")
}
