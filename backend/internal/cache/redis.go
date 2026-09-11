// Package cache provides the Redis client and a Redis-backed distributed rate
// limiter (a token bucket evaluated atomically via a Lua script), so the limit
// holds across all replicas — the multi-replica upgrade of the in-process
// limiter (docs/ARCHITECTURE.md §6).
package cache

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/redis/go-redis/v9"
)

// go-redis writes its internal diagnostics — connection-retry notices and the
// like — straight to stderr through a package-level logger. That is a hazard
// for a service launcher that treats any native stderr write as fatal: the
// Windows run.ps1 wrapper runs with $ErrorActionPreference = "Stop", so a
// single "failed to dial" notice from an optional, degradable dependency was
// enough to terminate the whole gateway at startup.
//
// Routing those notices into slog keeps stderr clean and puts them where every
// other diagnostic already goes.
type slogRedisLogger struct{ log *slog.Logger }

func (s slogRedisLogger) Printf(_ context.Context, format string, v ...any) {
	s.log.Warn("redis client", slog.String("detail", fmt.Sprintf(format, v...)))
}

// SetLogger redirects go-redis's internal logging into the given logger.
// Call it once, before any Redis client is constructed.
func SetLogger(l *slog.Logger) {
	redis.SetLogger(slogRedisLogger{log: l.With(slog.String("component", "redis"))})
}

// Redis wraps a go-redis universal client (works against a single node or a
// cluster).
type Redis struct {
	client redis.UniversalClient
}

// NewRedis builds a client for the given addresses.
func NewRedis(addrs []string, password string) *Redis {
	return &Redis{client: redis.NewUniversalClient(&redis.UniversalOptions{
		Addrs:    addrs,
		Password: password,
	})}
}

// Ping verifies connectivity (for readiness / startup checks).
func (r *Redis) Ping(ctx context.Context) error { return r.client.Ping(ctx).Err() }

// Close releases the client.
func (r *Redis) Close() error { return r.client.Close() }

// Client exposes the underlying client for future cache use (e.g. symbol cache).
func (r *Redis) Client() redis.UniversalClient { return r.client }

// tokenBucket is an atomic token-bucket: refill by elapsed time, consume one
// token if available. KEYS[1]=bucket key; ARGV: rate, burst, now(ms), requested.
var tokenBucket = redis.NewScript(`
local key = KEYS[1]
local rate = tonumber(ARGV[1])
local burst = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local requested = tonumber(ARGV[4])
local data = redis.call("HMGET", key, "tokens", "ts")
local tokens = tonumber(data[1])
local ts = tonumber(data[2])
if tokens == nil then tokens = burst; ts = now end
local delta = math.max(0, now - ts) / 1000.0
tokens = math.min(burst, tokens + delta * rate)
local allowed = 0
if tokens >= requested then tokens = tokens - requested; allowed = 1 end
redis.call("HMSET", key, "tokens", tokens, "ts", now)
local ttl = math.ceil(burst / rate * 1000) + 1000
redis.call("PEXPIRE", key, ttl)
return allowed
`)

// RedisLimiter is a distributed token-bucket limiter satisfying middleware.Limiter.
type RedisLimiter struct {
	r     *Redis
	rps   float64
	burst int
}

// NewRedisLimiter builds a distributed limiter.
func NewRedisLimiter(r *Redis, rps float64, burst int) *RedisLimiter {
	return &RedisLimiter{r: r, rps: rps, burst: burst}
}

// Allow evaluates the bucket for key. On a Redis error it returns (true, err)
// so the caller fails open.
func (l *RedisLimiter) Allow(ctx context.Context, key string) (bool, error) {
	now := time.Now().UnixMilli()
	res, err := tokenBucket.Run(ctx, l.r.client, []string{"rl:" + key},
		l.rps, l.burst, now, 1).Int()
	if err != nil {
		return true, err // fail open
	}
	return res == 1, nil
}
