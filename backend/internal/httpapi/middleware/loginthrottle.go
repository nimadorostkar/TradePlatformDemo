package middleware

import (
	"context"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/nimadorostkar/TradePlatformDemo/backend/internal/httpapi/response"
)

// LoginThrottle guards credential endpoints against online guessing (HGH-02).
//
// The general per-IP limiter bounds request VOLUME; it says nothing about
// outcomes, so a patient attacker under the volume limit could still walk a
// password list. This middleware watches the RESULT of each attempt: repeated
// failures from one client earn an exponentially growing lockout, and one
// success clears the slate. Applied only to the anonymous credential routes —
// authenticated traffic never pays for it.
//
// threshold failures arm the first lockout of baseLockout; each further
// failure doubles it up to maxLockout. A locked-out client receives 429 with
// Retry-After, and the attempt never reaches the CRM. threshold<=0 disables
// the middleware entirely.
//
// State is in-process and keyed by client IP (the same keyer as the volume
// limiter, so XFF is honoured exactly as far as it is trusted). ctx bounds the
// janitor that evicts idle entries.
func LoginThrottle(ctx context.Context, threshold int, baseLockout, maxLockout time.Duration, clientIP func(*http.Request) string) func(http.Handler) http.Handler {
	if threshold <= 0 {
		return passthrough
	}
	if clientIP == nil {
		clientIP = remoteIP
	}
	t := &loginThrottle{
		threshold: threshold,
		base:      baseLockout,
		max:       maxLockout,
		seen:      map[string]*loginAttempts{},
		now:       time.Now,
	}
	go t.janitor(ctx)
	return t.middleware(clientIP)
}

// middleware wraps a handler with the throttle; split from the constructor so
// tests can drive an instance with an injected clock.
func (t *loginThrottle) middleware(clientIP func(*http.Request) string) func(http.Handler) http.Handler {
	if clientIP == nil {
		clientIP = remoteIP
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			key := clientIP(r)
			if key == "" {
				// Client identity not established (see ClientIPKeyer). A
				// shared key is worse than no throttle here: any success by
				// anyone clears the count (no protection), while five
				// failures by anyone lock EVERYONE out (a DoS). Fail open;
				// the keyer has already logged the misconfiguration.
				next.ServeHTTP(w, r)
				return
			}
			if retryAfter, locked := t.locked(key); locked {
				w.Header().Set("Retry-After", strconv.Itoa(int(retryAfter.Seconds()+0.999)))
				response.WriteJSON(w, http.StatusTooManyRequests,
					response.Failure("Too many failed sign-in attempts. Try again later."))
				return
			}
			rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
			next.ServeHTTP(rec, r)
			// 401/403 is a rejected credential; anything under 400 is success.
			// 4xx validation noise (400) and 5xx infrastructure trouble prove
			// nothing about the credential and MUST not lock a real user out
			// during a CRM outage.
			switch {
			case rec.status == http.StatusUnauthorized || rec.status == http.StatusForbidden:
				t.recordFailure(key)
			case rec.status < 400:
				t.reset(key)
			}
		})
	}
}

type loginThrottle struct {
	mu        sync.Mutex
	threshold int
	base      time.Duration
	max       time.Duration
	seen      map[string]*loginAttempts
	now       func() time.Time // injectable for tests
}

type loginAttempts struct {
	failures    int
	lockedUntil time.Time
	last        time.Time
}

func (t *loginThrottle) locked(key string) (time.Duration, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	e, ok := t.seen[key]
	if !ok {
		return 0, false
	}
	remaining := e.lockedUntil.Sub(t.now())
	if remaining <= 0 {
		return 0, false
	}
	e.last = t.now()
	return remaining, true
}

func (t *loginThrottle) recordFailure(key string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	e, ok := t.seen[key]
	if !ok {
		e = &loginAttempts{}
		t.seen[key] = e
	}
	e.failures++
	e.last = t.now()
	if e.failures >= t.threshold {
		// threshold-th failure → base; each one after doubles, capped.
		lockout := t.base << uint(min(e.failures-t.threshold, 30))
		if lockout > t.max || lockout <= 0 {
			lockout = t.max
		}
		e.lockedUntil = t.now().Add(lockout)
	}
}

func (t *loginThrottle) reset(key string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	delete(t.seen, key)
}

func (t *loginThrottle) janitor(ctx context.Context) {
	tick := time.NewTicker(time.Minute)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
			// An entry idle for an hour has aged out of any plausible attack;
			// keeping it would only punish a shared NAT forever.
			cutoff := t.now().Add(-time.Hour)
			t.mu.Lock()
			for key, e := range t.seen {
				if e.last.Before(cutoff) && e.lockedUntil.Before(t.now()) {
					delete(t.seen, key)
				}
			}
			t.mu.Unlock()
		}
	}
}
