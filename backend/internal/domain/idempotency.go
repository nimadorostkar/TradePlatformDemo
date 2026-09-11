package domain

import (
	"context"
	"sync"
	"time"
)

// Trade submission forwards straight to MT5's dealer endpoint, so a request
// that times out has genuinely unknown outcome and a naive retry can open a
// second position. A client-supplied key makes the retry safe: the first
// submission's result is remembered for a short window and replayed verbatim,
// and a retry that arrives while the original is still in flight is answered
// with "unknown" rather than being sent to the dealer a second time.

// IdempotencyStore remembers trade submissions by client key. Implementations
// must be safe for concurrent use; the Redis-backed one additionally makes the
// guarantee hold across replicas (a single-node store only protects retries
// that land on the same pod).
type IdempotencyStore interface {
	// Load returns the stored result for key, if any.
	Load(ctx context.Context, key string) (payload []byte, found bool, err error)
	// Claim atomically marks key as in-flight. It returns false when the key
	// is already claimed or already has a result.
	Claim(ctx context.Context, key string, ttl time.Duration) (bool, error)
	// Store records the final result and releases the in-flight claim.
	Store(ctx context.Context, key string, payload []byte, ttl time.Duration) error
	// Release drops an in-flight claim without recording a result, so a
	// submission that never reached the dealer can be retried immediately.
	Release(ctx context.Context, key string) error
}

// MemoryIdempotencyStore is the single-node IdempotencyStore. It is the default
// when Redis is not configured: it still prevents the common double-submit
// (a client retrying against the same pod), and it never grows without bound
// because every entry carries an expiry that is swept on access.
type MemoryIdempotencyStore struct {
	mu        sync.Mutex
	entries   map[string]memoEntry
	nextSweep time.Time
}

const memoryIdempotencySweepInterval = time.Minute

type memoEntry struct {
	payload  []byte // nil while the submission is still in flight
	expires  time.Time
	inFlight bool
}

// NewMemoryIdempotencyStore constructs an in-process store.
func NewMemoryIdempotencyStore() *MemoryIdempotencyStore {
	return &MemoryIdempotencyStore{entries: map[string]memoEntry{}}
}

// Load returns the stored result for key.
func (m *MemoryIdempotencyStore) Load(_ context.Context, key string) ([]byte, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	now := time.Now()
	m.sweepLocked(now)
	e, ok := m.entries[key]
	if ok && now.After(e.expires) {
		delete(m.entries, key)
		return nil, false, nil
	}
	if !ok || e.inFlight || e.payload == nil {
		return nil, false, nil
	}
	return e.payload, true, nil
}

// Claim marks key as in-flight when it is neither claimed nor completed.
func (m *MemoryIdempotencyStore) Claim(_ context.Context, key string, ttl time.Duration) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	now := time.Now()
	m.sweepLocked(now)
	if existing, exists := m.entries[key]; exists {
		if now.After(existing.expires) {
			delete(m.entries, key)
		} else {
			return false, nil
		}
	}
	m.entries[key] = memoEntry{expires: now.Add(ttl), inFlight: true}
	return true, nil
}

// Store records the final result for key.
func (m *MemoryIdempotencyStore) Store(_ context.Context, key string, payload []byte, ttl time.Duration) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	now := time.Now()
	m.sweepLocked(now)
	m.entries[key] = memoEntry{payload: payload, expires: now.Add(ttl)}
	return nil
}

// Release drops an in-flight claim.
func (m *MemoryIdempotencyStore) Release(_ context.Context, key string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if e, ok := m.entries[key]; ok && e.inFlight {
		delete(m.entries, key)
	}
	return nil
}

// sweepLocked amortizes bulk expiry to avoid an O(n) map walk on every trade
// request. Load and Claim still check their requested key directly, so an
// expired idempotency key is reusable immediately. No background goroutine is
// needed, and stale unrelated entries live at most one extra sweep interval.
func (m *MemoryIdempotencyStore) sweepLocked(now time.Time) {
	if !m.nextSweep.IsZero() && now.Before(m.nextSweep) {
		return
	}
	m.nextSweep = now.Add(memoryIdempotencySweepInterval)
	for k, e := range m.entries {
		if now.After(e.expires) {
			delete(m.entries, k)
		}
	}
}
