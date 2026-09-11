package middleware

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/nimadorostkar/TradePlatformDemo/backend/internal/auth"
)

func testJWT(t *testing.T) *auth.JWT {
	t.Helper()
	j, err := auth.NewJWT(auth.JWTConfig{Secret: "secret", Expiry: time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	return j
}

func okHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
}

func TestJWTAuth(t *testing.T) {
	j := testJWT(t)
	good, _ := j.GenerateForUser("alice")

	tests := []struct {
		name   string
		header string
		want   int
	}{
		{"valid bearer", "Bearer " + good, http.StatusOK},
		{"missing", "", http.StatusUnauthorized},
		{"malformed", "Bearer not.a.jwt", http.StatusUnauthorized},
		{"wrong scheme", good, http.StatusUnauthorized},
	}
	h := JWTAuth(j)(okHandler())
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodGet, "/api/Order/get", nil)
			if tc.header != "" {
				r.Header.Set("Authorization", tc.header)
			}
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			if w.Code != tc.want {
				t.Errorf("status = %d, want %d", w.Code, tc.want)
			}
		})
	}
}

func TestAccountsAuthorize(t *testing.T) {
	j := testJWT(t)
	accountsTok, _ := j.GenerateForAccounts([]string{"1001", "1002"})
	noAccountsTok, _ := j.GenerateForUser("bob")

	// JWTAuth populates claims; AccountsAuthorize enforces membership.
	chain := JWTAuth(j)(AccountsAuthorize()(okHandler()))

	tests := []struct {
		name  string
		token string
		query string
		body  string
		want  int
	}{
		{"member via query", accountsTok, "?login=1002", "", http.StatusOK},
		{"not a member", accountsTok, "?login=9999", "", http.StatusForbidden},
		{"member via body", accountsTok, "", `{"login":"1001"}`, http.StatusOK},
		{"no accounts claim", noAccountsTok, "?login=1001", "", http.StatusUnauthorized},
		{"missing login is rejected", accountsTok, "", "", http.StatusBadRequest},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var body *strings.Reader
			method := http.MethodGet
			if tc.body != "" {
				body = strings.NewReader(tc.body)
				method = http.MethodPost
			} else {
				body = strings.NewReader("")
			}
			r := httptest.NewRequest(method, "/api/Order/get_page"+tc.query, body)
			r.Header.Set("Authorization", "Bearer "+tc.token)
			w := httptest.NewRecorder()
			chain.ServeHTTP(w, r)
			if w.Code != tc.want {
				t.Errorf("status = %d, want %d", w.Code, tc.want)
			}
		})
	}
}

func TestManagerAuthorize(t *testing.T) {
	const key = "0123456789abcdef0123456789abcdef"
	tests := []struct {
		name, configured, provided string
		want                       int
	}{
		{"disabled is hidden", "", "", http.StatusNotFound},
		{"missing key", key, "", http.StatusForbidden},
		{"wrong key", key, "0123456789abcdef0123456789abcdeg", http.StatusForbidden},
		{"valid key", key, key, http.StatusOK},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodDelete, "/api/Order/delete?ticket=1", nil)
			if tc.provided != "" {
				r.Header.Set("X-Manager-Key", tc.provided)
			}
			w := httptest.NewRecorder()
			ManagerAuthorize(tc.configured)(okHandler()).ServeHTTP(w, r)
			if w.Code != tc.want {
				t.Fatalf("status = %d, want %d", w.Code, tc.want)
			}
		})
	}
}

func TestCORS_FailClosed(t *testing.T) {
	// Empty allowlist must not emit Access-Control-Allow-Origin for a cross origin.
	h := CORS(nil)(okHandler())
	r := httptest.NewRequest(http.MethodGet, "/api/Order/get", nil)
	r.Header.Set("Origin", "https://evil.example.com")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if got := w.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Errorf("cross-origin allowed with empty allowlist: %q", got)
	}

	// Allowlisted origin is reflected.
	h2 := CORS([]string{"https://terminal.example.com"})(okHandler())
	r2 := httptest.NewRequest(http.MethodGet, "/api/Order/get", nil)
	r2.Header.Set("Origin", "https://terminal.example.com")
	w2 := httptest.NewRecorder()
	h2.ServeHTTP(w2, r2)
	if got := w2.Header().Get("Access-Control-Allow-Origin"); got != "https://terminal.example.com" {
		t.Errorf("allowlisted origin not reflected: %q", got)
	}
}

func TestRateLimit_InProc(t *testing.T) {
	h := RateLimit(t.Context(), 1, 1, nil)(okHandler()) // 1 rps, burst 1
	call := func() int {
		r := httptest.NewRequest(http.MethodGet, "/api/Order/get", nil)
		r.RemoteAddr = "1.2.3.4:5555"
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w.Code
	}
	if call() != http.StatusOK {
		t.Fatal("first request should pass")
	}
	if call() != http.StatusTooManyRequests {
		t.Error("second rapid request should be limited")
	}
	// Operational paths are exempt.
	r := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	r.RemoteAddr = "1.2.3.4:5555"
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Error("/healthz should be exempt from rate limiting")
	}
}

type erroringLimiter struct{ err error }

func (e *erroringLimiter) Allow(context.Context, string) (bool, error) { return true, e.err }

// A limiter error must fail open (request passes) AND report via onFailOpen —
// a Redis outage silently dropping rate protection is not acceptable.
func TestRateLimitWith_FailOpenIsReported(t *testing.T) {
	limErr := errors.New("redis: connection refused")
	var reported []error
	h := RateLimitWith(&erroringLimiter{err: limErr}, nil, func(err error) {
		reported = append(reported, err)
	})(okHandler())

	r := httptest.NewRequest(http.MethodGet, "/api/Order/get", nil)
	r.RemoteAddr = "1.2.3.4:5555"
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)

	if w.Code != http.StatusOK {
		t.Errorf("fail open: request should pass, got %d", w.Code)
	}
	if len(reported) != 1 || !errors.Is(reported[0], limErr) {
		t.Errorf("onFailOpen not invoked with the limiter error: %v", reported)
	}
}

// Spoofed X-Forwarded-For from an untrusted peer must NOT change the rate key;
// XFF from a trusted proxy resolves to the rightmost untrusted hop.
func TestClientIPKeyer_TrustedProxyGuard(t *testing.T) {
	req := func(remote, xff string) *http.Request {
		r := httptest.NewRequest(http.MethodGet, "/api/Order/get", nil)
		r.RemoteAddr = remote
		if xff != "" {
			r.Header.Set("X-Forwarded-For", xff)
		}
		return r
	}

	// No trusted proxies: XFF ignored, peer address is the key.
	keyer, err := ClientIPKeyer(nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := keyer(req("1.2.3.4:5555", "9.9.9.9")); got != "1.2.3.4" {
		t.Errorf("no-proxy: key = %q, want peer 1.2.3.4 (spoofed XFF must be ignored)", got)
	}

	keyer, err = ClientIPKeyer([]string{"10.0.0.0/8", "192.168.1.1"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	// Untrusted peer sending XFF: still keyed by peer.
	if got := keyer(req("1.2.3.4:5555", "9.9.9.9")); got != "1.2.3.4" {
		t.Errorf("untrusted peer: key = %q, want 1.2.3.4", got)
	}
	// Trusted proxy forwards the client: rightmost untrusted hop wins, and a
	// client-prepended fake entry (5.5.5.5) is ignored.
	if got := keyer(req("10.1.2.3:7777", "5.5.5.5, 8.8.8.8")); got != "8.8.8.8" {
		t.Errorf("trusted proxy: key = %q, want rightmost untrusted 8.8.8.8", got)
	}
	// Two chained trusted proxies collapse to the real client.
	if got := keyer(req("10.1.2.3:7777", "8.8.8.8, 192.168.1.1")); got != "8.8.8.8" {
		t.Errorf("chained proxies: key = %q, want 8.8.8.8", got)
	}
	// Trusted peer but no XFF (direct local probe): identity not established.
	if got := keyer(req("10.1.2.3:7777", "")); got != "" {
		t.Errorf("trusted peer without XFF: key = %q, want \"\" (not established)", got)
	}
	// A chain that dead-ends in trusted proxies must NOT key to the proxy
	// address — that would collapse every user of the proxy into one bucket
	// (the HGH-02 shared-lockout failure). Identity not established.
	if got := keyer(req("10.1.2.3:7777", "192.168.1.1")); got != "" {
		t.Errorf("all-trusted chain: key = %q, want \"\" (not established)", got)
	}

	// Bad CIDR fails loudly at startup.
	if _, err := ClientIPKeyer([]string{"not-a-cidr"}, nil); err == nil {
		t.Error("expected error for invalid trusted proxy entry")
	}
}

// An unestablished client identity ("" key) must exempt the request from the
// volume limiter rather than pool every user into one shared bucket.
func TestRateLimit_UnestablishedKeyFailsOpen(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	unestablished := func(*http.Request) string { return "" }
	h := RateLimit(ctx, 0.0001, 1, unestablished)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	for i := 0; i < 5; i++ {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/Order/get", nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("request %d: status = %d, want 200 (unestablished key must fail open)", i+1, rec.Code)
		}
	}
}

func TestRateLimit_JanitorStopsOnCancel(t *testing.T) {
	before := runtime.NumGoroutine()
	ctx, cancel := context.WithCancel(context.Background())
	_ = RateLimit(ctx, 1, 1, nil) // starts the janitor goroutine
	cancel()

	deadline := time.Now().Add(2 * time.Second)
	for runtime.NumGoroutine() > before {
		if time.Now().After(deadline) {
			t.Fatalf("janitor goroutine still running after context cancel (goroutines: %d > %d)",
				runtime.NumGoroutine(), before)
		}
		time.Sleep(10 * time.Millisecond)
	}
}
