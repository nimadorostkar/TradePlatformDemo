package cache

import (
	"context"
	"errors"
	"time"

	"github.com/redis/go-redis/v9"
)

// RedisIdempotencyStore implements domain.IdempotencyStore on Redis, so the
// no-double-submit guarantee holds across every replica rather than only for
// retries that happen to land on the same pod.
//
// One key per client key holds either the in-flight marker or the serialized
// result; SET NX makes the claim atomic, so two replicas racing on the same
// retry can never both reach the dealer.
type RedisIdempotencyStore struct {
	r      *Redis
	prefix string
}

// inFlightMarker is the sentinel value stored while a submission is in flight.
// It is a single byte that can never be confused with a JSON envelope.
const inFlightMarker = "\x00"

// NewRedisIdempotencyStore builds a Redis-backed store.
func NewRedisIdempotencyStore(r *Redis) *RedisIdempotencyStore {
	return &RedisIdempotencyStore{r: r, prefix: "idem:trade:"}
}

// Load returns the stored result for key. An in-flight marker is not a result.
func (s *RedisIdempotencyStore) Load(ctx context.Context, key string) ([]byte, bool, error) {
	val, err := s.r.client.Get(ctx, s.prefix+key).Bytes()
	if errors.Is(err, redis.Nil) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	if string(val) == inFlightMarker {
		return nil, false, nil
	}
	return val, true, nil
}

// Claim atomically marks key as in-flight.
func (s *RedisIdempotencyStore) Claim(ctx context.Context, key string, ttl time.Duration) (bool, error) {
	return s.r.client.SetNX(ctx, s.prefix+key, inFlightMarker, ttl).Result()
}

// Store records the final result, overwriting the in-flight marker.
func (s *RedisIdempotencyStore) Store(ctx context.Context, key string, payload []byte, ttl time.Duration) error {
	return s.r.client.Set(ctx, s.prefix+key, payload, ttl).Err()
}

// Release drops an in-flight claim so the submission can be retried at once.
// A key that already holds a result is left alone: losing a recorded outcome
// would let a retry reach the dealer twice.
func (s *RedisIdempotencyStore) Release(ctx context.Context, key string) error {
	return releaseIfInFlight.Run(ctx, s.r.client, []string{s.prefix + key}, inFlightMarker).Err()
}

// releaseIfInFlight deletes the key only when it still holds the in-flight
// marker (compare-and-delete; a plain DEL would race with a concurrent Store).
var releaseIfInFlight = redis.NewScript(`
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`)
