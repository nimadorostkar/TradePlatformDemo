package middleware

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// failNTimes returns 401 for the first n requests, 200 afterwards.
func failNTimes(n int) http.Handler {
	count := 0
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		count++
		if count <= n {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.WriteHeader(http.StatusOK)
	})
}

func attempt(t *testing.T, h http.Handler, ip string) int {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/Authentication/login", nil)
	req.RemoteAddr = ip + ":51234"
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec.Code
}

func TestLoginThrottleLocksAfterThresholdAndBacksOffExponentially(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	_ = ctx
	now := time.Now()
	throttle := &loginThrottle{
		threshold: 3,
		base:      10 * time.Second,
		max:       time.Minute,
		seen:      map[string]*loginAttempts{},
		now:       func() time.Time { return now },
	}
	h := throttle.middleware(nil)(failNTimes(1000))

	// Two failures: still open.
	for i := 0; i < 2; i++ {
		if got := attempt(t, h, "203.0.113.7"); got != http.StatusUnauthorized {
			t.Fatalf("attempt %d: got %d, want 401", i+1, got)
		}
	}
	// Third failure arms the base lockout…
	if got := attempt(t, h, "203.0.113.7"); got != http.StatusUnauthorized {
		t.Fatalf("third failure: got %d, want 401 (the attempt itself still ran)", got)
	}
	// …so the fourth attempt is refused without reaching the handler.
	if got := attempt(t, h, "203.0.113.7"); got != http.StatusTooManyRequests {
		t.Fatalf("locked attempt: got %d, want 429", got)
	}

	// Another client is unaffected.
	if got := attempt(t, h, "198.51.100.9"); got != http.StatusUnauthorized {
		t.Fatalf("other client: got %d, want 401", got)
	}

	// After the base lockout expires, the next failure doubles it.
	now = now.Add(11 * time.Second)
	if got := attempt(t, h, "203.0.113.7"); got != http.StatusUnauthorized {
		t.Fatalf("post-lockout failure: got %d, want 401", got)
	}
	now = now.Add(11 * time.Second) // inside the doubled (20s) lockout
	if got := attempt(t, h, "203.0.113.7"); got != http.StatusTooManyRequests {
		t.Fatalf("doubled lockout: got %d, want 429", got)
	}
}

// When the keyer cannot establish a client identity ("" key), the throttle
// must fail open: a shared key would let five failures by anyone lock EVERYONE
// out, while any success by anyone clears the count — worse than no throttle.
func TestLoginThrottleUnestablishedKeyFailsOpen(t *testing.T) {
	throttle := &loginThrottle{
		threshold: 2,
		base:      time.Minute,
		max:       time.Minute,
		seen:      map[string]*loginAttempts{},
		now:       time.Now,
	}
	unestablished := func(*http.Request) string { return "" }
	h := throttle.middleware(unestablished)(failNTimes(1000))

	// Far past any threshold: never locked, and nothing recorded.
	for i := 0; i < 6; i++ {
		if got := attempt(t, h, "203.0.113.7"); got != http.StatusUnauthorized {
			t.Fatalf("attempt %d: got %d, want 401 (unestablished key must fail open)", i+1, got)
		}
	}
	if len(throttle.seen) != 0 {
		t.Fatalf("throttle recorded %d entries for an unestablished key; want none", len(throttle.seen))
	}
}

func TestLoginThrottleSuccessClearsTheSlate(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	mw := LoginThrottle(ctx, 3, 10*time.Second, time.Minute, nil)
	h := mw(failNTimes(2)) // two failures, then success

	if got := attempt(t, h, "203.0.113.7"); got != http.StatusUnauthorized {
		t.Fatalf("got %d, want 401", got)
	}
	if got := attempt(t, h, "203.0.113.7"); got != http.StatusUnauthorized {
		t.Fatalf("got %d, want 401", got)
	}
	if got := attempt(t, h, "203.0.113.7"); got != http.StatusOK {
		t.Fatalf("got %d, want 200", got)
	}

	// The slate is clean: three fresh failures are needed to lock again.
	h2 := mw(failNTimes(1000))
	for i := 0; i < 3; i++ {
		if got := attempt(t, h2, "203.0.113.7"); got != http.StatusUnauthorized {
			t.Fatalf("fresh failure %d: got %d, want 401", i+1, got)
		}
	}
	if got := attempt(t, h2, "203.0.113.7"); got != http.StatusTooManyRequests {
		t.Fatalf("got %d, want 429", got)
	}
}

func TestLoginThrottleIgnoresServerTrouble(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	mw := LoginThrottle(ctx, 1, time.Minute, time.Minute, nil)
	h := mw(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
	}))
	// A CRM outage (5xx) must never lock a client out.
	for i := 0; i < 5; i++ {
		if got := attempt(t, h, "203.0.113.7"); got != http.StatusBadGateway {
			t.Fatalf("got %d, want 502", got)
		}
	}
}

func TestLoginThrottleDisabled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	mw := LoginThrottle(ctx, 0, time.Second, time.Second, nil)
	h := mw(failNTimes(1000))
	for i := 0; i < 20; i++ {
		if got := attempt(t, h, "203.0.113.7"); got != http.StatusUnauthorized {
			t.Fatalf("disabled throttle interfered: got %d", got)
		}
	}
}
