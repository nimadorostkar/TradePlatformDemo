package realtime

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"sync"
)

// Bus is the publish/subscribe transport for cross-pod fan-out. The in-process
// implementation serves single-node; the NATS implementation (natsbus.go) makes
// the WebSocket fan-out cluster-wide (docs/ARCHITECTURE.md §5.2).
type Bus interface {
	Publish(ctx context.Context, subject string, data []byte) error
	Subscribe(subject string, handler func([]byte)) (unsub func(), err error)
	Close() error
}

// DemandSubject carries subscription demand from hub pods to the poller.
const DemandSubject = "ws.demand"

// dataSubject is the per-subscription fan-out subject. The topic key is hashed
// so the subject is always NATS-token-safe.
func dataSubject(key string) string {
	h := sha256.Sum256([]byte(key))
	return "ws.data." + hex.EncodeToString(h[:8])
}

// InProcBus is an in-process Bus (single node, and the test transport).
type InProcBus struct {
	mu   sync.RWMutex
	next int
	subs map[string]map[int]func([]byte)
}

// NewInProcBus constructs an in-process bus.
func NewInProcBus() *InProcBus {
	return &InProcBus{subs: map[string]map[int]func([]byte){}}
}

// Publish delivers data synchronously to all subscribers of subject. Handlers
// must not call back into the bus (they don't — hub/poller use separate locks).
func (b *InProcBus) Publish(_ context.Context, subject string, data []byte) error {
	b.mu.RLock()
	handlers := make([]func([]byte), 0, len(b.subs[subject]))
	for _, h := range b.subs[subject] {
		handlers = append(handlers, h)
	}
	b.mu.RUnlock()
	for _, h := range handlers {
		h(data)
	}
	return nil
}

// Subscribe registers handler for subject and returns an unsubscribe func.
func (b *InProcBus) Subscribe(subject string, handler func([]byte)) (func(), error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.subs[subject] == nil {
		b.subs[subject] = map[int]func([]byte){}
	}
	id := b.next
	b.next++
	b.subs[subject][id] = handler
	return func() {
		b.mu.Lock()
		defer b.mu.Unlock()
		delete(b.subs[subject], id)
	}, nil
}

// Close is a no-op for the in-process bus.
func (b *InProcBus) Close() error { return nil }
