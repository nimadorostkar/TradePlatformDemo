package mt5

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// A real 403 episode on the production broker lasted 6h56m. The ping loop
// retried authentication on every tick for the whole outage: 645 auth attempts
// and 645 identical WARN lines. These tests pin the behavior that replaced it —
// bounded retries, a log an operator can read, and recovery that is still
// prompt enough for the weekly 3-to-7-minute broker maintenance window.

func TestReauthBackoffGrowsAndIsCapped(t *testing.T) {
	// Jitter is ±20%, so assert on bounds rather than exact values.
	for _, tc := range []struct {
		failures int
		min, max time.Duration
	}{
		{1, 4 * time.Second, 6 * time.Second},
		{2, 8 * time.Second, 12 * time.Second},
		{3, 16 * time.Second, 24 * time.Second},
		{10, 96 * time.Second, 144 * time.Second},   // capped at 2m ±20%
		{1000, 96 * time.Second, 144 * time.Second}, // stays capped
	} {
		for i := 0; i < 50; i++ {
			got := reauthBackoff(tc.failures)
			if got < tc.min || got > tc.max {
				t.Fatalf("reauthBackoff(%d) = %v, want within [%v,%v]", tc.failures, got, tc.min, tc.max)
			}
		}
	}
}

// The cap must stay short. A trading gateway that is down is costing money, so
// politeness toward the broker must never add more than a couple of minutes.
func TestReauthBackoffCapStaysShortEnoughForMaintenanceWindows(t *testing.T) {
	if maxReauthBackoff > 2*time.Minute {
		t.Fatalf("maxReauthBackoff = %v; a longer cap delays recovery from the weekly maintenance window", maxReauthBackoff)
	}
}

// authCountingServer serves the MT5 handshake, refusing until releaseAfter
// successful-auth attempts have been made. It counts auth/start hits.
func authCountingServer(t *testing.T, refuse *atomic.Bool, authAttempts *atomic.Int32) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/api/auth/start", func(w http.ResponseWriter, r *http.Request) {
		authAttempts.Add(1)
		if refuse.Load() {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{
			"retcode": "0 Done", "srv_rand": "a1b2c3d4e5f60718293a4b5c6d7e8f90",
		})
	})
	mux.HandleFunc("/api/auth/answer", func(w http.ResponseWriter, r *http.Request) {
		if refuse.Load() {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		http.SetCookie(w, &http.Cookie{Name: "MT5Session", Value: "ok"})
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"retcode":"0 Done","cli_rand_answer":"00"}`))
	})
	mux.HandleFunc("/api/test/access", func(w http.ResponseWriter, r *http.Request) {
		if refuse.Load() {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		w.WriteHeader(http.StatusOK)
	})
	s := httptest.NewServer(mux)
	t.Cleanup(s.Close)
	return s
}

// The core regression: a sustained rejection must not produce one auth attempt
// per ping tick.
func TestSustainedRejectionDoesNotRetryEveryTick(t *testing.T) {
	var refuse atomic.Bool
	var attempts atomic.Int32
	refuse.Store(true)
	s := authCountingServer(t, &refuse, &attempts)

	c := testConn(t, s.URL)
	c.cfg.Password = "pw"

	// 60 ping ticks against a refusing upstream. The old code authenticated on
	// every one of them.
	for i := 0; i < 60; i++ {
		c.ping(context.Background())
	}

	got := int(attempts.Load())
	if got >= 60 {
		t.Fatalf("attempted auth %d times in 60 ticks; backoff is not being applied", got)
	}
	// The first tick attempts, then a 5s-and-growing window suppresses the
	// rest of this (near-instant) loop.
	if got > 3 {
		t.Errorf("attempted auth %d times; expected a small handful under backoff", got)
	}
	t.Logf("60 ticks against a refusing upstream produced %d auth attempts (was 60)", got)
}

// Backoff must not strand the session: once the upstream returns, the very next
// eligible tick has to reconnect.
func TestSessionRecoversOnceUpstreamReturns(t *testing.T) {
	var refuse atomic.Bool
	var attempts atomic.Int32
	refuse.Store(true)
	s := authCountingServer(t, &refuse, &attempts)

	c := testConn(t, s.URL)
	c.cfg.Password = "pw"

	c.ping(context.Background()) // first failure, starts backoff
	if c.authenticated.Load() {
		t.Fatal("should not be authenticated while upstream refuses")
	}

	refuse.Store(false)
	// Clear the backoff window the way the passage of time would.
	c.mu.Lock()
	c.nextAuthAttempt = time.Now().Add(-time.Second)
	c.mu.Unlock()

	c.ping(context.Background())
	if !c.authenticated.Load() {
		t.Fatal("session did not recover on the first eligible tick after the upstream returned")
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.reauthFailures != 0 || !c.authDownSince.IsZero() {
		t.Errorf("outage state not cleared on recovery: failures=%d downSince=%v", c.reauthFailures, c.authDownSince)
	}
}

// The log has to tell an operator when it broke, how long it was broken, and
// how many attempts it took — not repeat one line hundreds of times.
func TestOutageIsLoggedOnceAndRecoveryReportsDuration(t *testing.T) {
	var refuse atomic.Bool
	var attempts atomic.Int32
	refuse.Store(true)
	s := authCountingServer(t, &refuse, &attempts)

	var buf bytes.Buffer
	c := testConn(t, s.URL)
	c.cfg.Password = "pw"
	c.log = slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug}))

	// Many ticks, forcing the backoff open each time so every tick really tries.
	for i := 0; i < 40; i++ {
		c.mu.Lock()
		c.nextAuthAttempt = time.Time{}
		c.mu.Unlock()
		c.ping(context.Background())
	}

	failLines := strings.Count(buf.String(), "mt5 ping re-auth failed")
	if failLines == 0 {
		t.Fatal("an outage must be logged at least once")
	}
	if failLines > 3 {
		t.Errorf("logged %d re-auth failures for one outage; expected suppression to collapse them", failLines)
	}

	refuse.Store(false)
	c.mu.Lock()
	c.nextAuthAttempt = time.Time{}
	c.mu.Unlock()
	c.ping(context.Background())

	out := buf.String()
	if !strings.Contains(out, "mt5 session recovered") {
		t.Error("recovery must be logged so an operator can see the episode ended")
	}
	if !strings.Contains(out, "down_for") || !strings.Contains(out, "attempts") {
		t.Errorf("recovery line must carry down_for and attempts; got:\n%s", out)
	}
	t.Logf("40 failing ticks produced %d log lines (was 40)", failLines)
}

// A healthy session must be completely unaffected: no backoff state, no
// behavior change on the happy path.
func TestHealthyPingLeavesNoBackoffState(t *testing.T) {
	var refuse atomic.Bool
	var attempts atomic.Int32
	s := authCountingServer(t, &refuse, &attempts)

	c := testConn(t, s.URL)
	c.cfg.Password = "pw"
	if err := c.authenticate(context.Background()); err != nil {
		t.Fatalf("authenticate: %v", err)
	}
	before := attempts.Load()

	for i := 0; i < 10; i++ {
		c.ping(context.Background())
	}

	if !c.authenticated.Load() {
		t.Fatal("healthy session should stay authenticated")
	}
	if got := attempts.Load(); got != before {
		t.Errorf("healthy pings triggered %d re-authentications; want 0", got-before)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.reauthFailures != 0 || !c.nextAuthAttempt.IsZero() {
		t.Errorf("healthy path left backoff state: failures=%d next=%v", c.reauthFailures, c.nextAuthAttempt)
	}
}
