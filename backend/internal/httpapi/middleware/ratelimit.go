package middleware

import (
	"context"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"golang.org/x/time/rate"

	"github.com/nimadorostkar/TradePlatformDemo/backend/internal/httpapi/response"
)

// Limiter decides whether a request keyed by a client identifier is allowed.
// Implemented in-process (ipLimiter) and distributed (cache.RedisLimiter).
type Limiter interface {
	Allow(ctx context.Context, key string) (bool, error)
}

// RateLimit returns an in-process per-IP token-bucket middleware. rps<=0 disables.
// ctx bounds the janitor goroutine that evicts idle IP entries; it stops when
// ctx is cancelled (app shutdown). clientIP keys requests (see ClientIPKeyer);
// nil keys by the TCP peer address.
func RateLimit(ctx context.Context, rps float64, burst int, clientIP func(*http.Request) string) func(http.Handler) http.Handler {
	if rps <= 0 {
		return passthrough
	}
	return RateLimitWith(newIPLimiter(ctx, rate.Limit(rps), burst), clientIP, nil)
}

// RateLimitWith applies any Limiter (e.g. a Redis-backed distributed limiter).
// Operational paths are exempt. clientIP keys requests (nil = TCP peer address).
// Limiter errors fail open (don't block traffic); onFailOpen, if non-nil, is
// invoked with each such error so the outage is observable (metric + log)
// instead of silently dropping rate protection.
func RateLimitWith(l Limiter, clientIP func(*http.Request) string, onFailOpen func(error)) func(http.Handler) http.Handler {
	if l == nil {
		return passthrough
	}
	if clientIP == nil {
		clientIP = remoteIP
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch r.URL.Path {
			case "/healthz", "/readyz", "/metrics":
				next.ServeHTTP(w, r)
				return
			}
			key := clientIP(r)
			if key == "" {
				// Client identity not established (see ClientIPKeyer): a
				// shared bucket would cap the whole site, so fail open.
				next.ServeHTTP(w, r)
				return
			}
			allowed, err := l.Allow(r.Context(), key)
			if err != nil && onFailOpen != nil {
				onFailOpen(err)
			}
			if err == nil && !allowed {
				response.WriteJSON(w, http.StatusTooManyRequests, response.Failure("Too Many Requests"))
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func passthrough(next http.Handler) http.Handler { return next }

// ── in-process limiter ───────────────────────────────────────────────────────

type ipLimiter struct {
	mu    sync.Mutex
	rps   rate.Limit
	burst int
	seen  map[string]*entry
}

type entry struct {
	lim  *rate.Limiter
	last time.Time
}

func newIPLimiter(ctx context.Context, rps rate.Limit, burst int) *ipLimiter {
	l := &ipLimiter{rps: rps, burst: burst, seen: map[string]*entry{}}
	go l.janitor(ctx)
	return l
}

// Allow satisfies Limiter.
func (l *ipLimiter) Allow(_ context.Context, key string) (bool, error) {
	return l.get(key).Allow(), nil
}

func (l *ipLimiter) get(ip string) *rate.Limiter {
	l.mu.Lock()
	defer l.mu.Unlock()
	e, ok := l.seen[ip]
	if !ok {
		e = &entry{lim: rate.NewLimiter(l.rps, l.burst)}
		l.seen[ip] = e
	}
	e.last = time.Now()
	return e.lim
}

func (l *ipLimiter) janitor(ctx context.Context) {
	t := time.NewTicker(time.Minute)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			cutoff := time.Now().Add(-10 * time.Minute)
			l.mu.Lock()
			for ip, e := range l.seen {
				if e.last.Before(cutoff) {
					delete(l.seen, ip)
				}
			}
			l.mu.Unlock()
		}
	}
}

// ClientIPKeyer builds the request-keying function for per-IP rate limiting.
// trustedProxies lists CIDRs (or bare IPs) of reverse proxies whose
// X-Forwarded-For header is honored. When the TCP peer is NOT a trusted proxy
// the header is ignored entirely — an untrusted client cannot spoof XFF to
// bypass its limit. When it IS trusted, the client IP is the rightmost XFF
// entry that is not itself a trusted proxy (entries to its left are
// client-supplied and unverifiable). Empty trustedProxies keys every request
// by the peer address.
//
// When the peer is trusted but NO untrusted hop exists — the chain dead-ends
// in proxy addresses, or a trusted peer sent no XFF at all — the keyer returns
// "" (client identity not established) rather than the proxy's own address.
// Keying on a proxy address collapses every user of that proxy into ONE
// bucket: the volume limiter becomes a site-wide cap, and the login throttle
// becomes a site-wide lockout that any five failed sign-ins can arm (HGH-02
// retest, 2026-08-28: Caddy without trusted_proxies strips the client hop, so
// all Cloudflare traffic keyed to 127.0.0.1). Both middlewares treat "" as
// exempt, and the keyer logs a warning (at most hourly) whenever a forwarded
// chain dead-ends, because that means the proxy in front is not configured to
// pass the client hop through.
func ClientIPKeyer(trustedProxies []string, log *slog.Logger) (func(*http.Request) string, error) {
	if len(trustedProxies) == 0 {
		return remoteIP, nil
	}
	nets := make([]*net.IPNet, 0, len(trustedProxies))
	for _, p := range trustedProxies {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		if !strings.Contains(p, "/") {
			if strings.Contains(p, ":") {
				p += "/128"
			} else {
				p += "/32"
			}
		}
		_, n, err := net.ParseCIDR(p)
		if err != nil {
			return nil, fmt.Errorf("trusted proxy %q: %w", p, err)
		}
		nets = append(nets, n)
	}
	trusted := func(ip net.IP) bool {
		if ip == nil {
			return false
		}
		for _, n := range nets {
			if n.Contains(ip) {
				return true
			}
		}
		return false
	}
	var warnMu sync.Mutex
	var lastWarn time.Time
	return func(r *http.Request) string {
		peer := remoteIP(r)
		if !trusted(net.ParseIP(peer)) {
			return peer
		}
		xff := r.Header.Get("X-Forwarded-For")
		hops := strings.Split(xff, ",")
		for i := len(hops) - 1; i >= 0; i-- {
			hop := strings.TrimSpace(hops[i])
			if hop == "" {
				continue
			}
			if ip := net.ParseIP(hop); ip != nil && !trusted(ip) {
				return hop
			}
		}
		// A forwarded chain made entirely of trusted proxies means the proxy
		// in front dropped the client hop — real users would all share one
		// key, so report it. A trusted peer with no XFF at all is a direct
		// local request (health probe, operator curl), not worth a warning.
		if strings.TrimSpace(xff) != "" && log != nil {
			warnMu.Lock()
			if time.Since(lastWarn) >= time.Hour {
				lastWarn = time.Now()
				warnMu.Unlock()
				log.Warn("client IP not established: every X-Forwarded-For hop is a trusted proxy, so rate limiting and the login throttle cannot tell clients apart and are DISABLED for these requests — the proxy in front is not forwarding the client hop (e.g. Caddy needs trusted_proxies for Cloudflare)",
					slog.String("peer", peer),
					slog.String("xff", xff))
			} else {
				warnMu.Unlock()
			}
		}
		return "" // client identity not established
	}, nil
}

// remoteIP keys a request by its TCP peer address (no proxy headers).
func remoteIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
