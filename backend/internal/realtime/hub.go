package realtime

import (
	"context"
	"encoding/json"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"
)

// subscriber is one connected client's outbound queue.
type subscriber struct {
	id   uint64
	ch   chan []byte
	drop atomic.Uint64 // dropped-message counter (backpressure metric)
}

// topic is a shared upstream poller for one canonical subscription. All
// subscribers with the same Key() share a single MT5 poll loop.
type topic struct {
	key     string
	params  Params
	mu      sync.Mutex
	subs    map[uint64]*subscriber
	last    []byte // most recent message, replayed to late joiners
	hasLast bool
	cancel  context.CancelFunc
}

// Hub manages topics and fan-out. One poller goroutine runs per active topic.
type Hub struct {
	svc     Services
	cadence time.Duration
	sendBuf int
	log     *slog.Logger
	rootCtx context.Context
	mu      sync.Mutex
	topics  map[string]*topic
	nextID  atomic.Uint64
	wg      sync.WaitGroup
	onDrop  func() // optional backpressure-drop metric hook
	bus     Bus    // optional; when set, topics run in distributed (bus) mode
}

// SetOnDrop registers a hook called whenever a message is dropped (backpressure).
func (h *Hub) SetOnDrop(fn func()) { h.onDrop = fn }

// SetBus enables distributed mode: topics subscribe to the bus for data and
// publish demand instead of polling MT5 locally (the poller does the polling).
func (h *Hub) SetBus(bus Bus) { h.bus = bus }

// NewHub constructs a Hub. cadence is the push interval (default 3s to match .NET).
func NewHub(ctx context.Context, svc Services, cadence time.Duration, sendBuf int, log *slog.Logger) *Hub {
	if cadence <= 0 {
		cadence = 3 * time.Second
	}
	if sendBuf <= 0 {
		sendBuf = 32
	}
	return &Hub{
		svc:     svc,
		cadence: cadence,
		sendBuf: sendBuf,
		log:     log.With(slog.String("component", "ws-hub")),
		rootCtx: ctx,
		topics:  map[string]*topic{},
	}
}

// subscribe attaches a new subscriber to the topic for p, starting the topic
// poller if it is the first subscriber. It returns the subscriber and a release
// func to call on disconnect.
func (h *Hub) subscribe(p Params) (*subscriber, func()) {
	key := p.Key()
	sub := &subscriber{id: h.nextID.Add(1), ch: make(chan []byte, h.sendBuf)}

	h.mu.Lock()
	t, ok := h.topics[key]
	if !ok {
		ctx, cancel := context.WithCancel(h.rootCtx)
		t = &topic{key: key, params: p, subs: map[uint64]*subscriber{}, cancel: cancel}
		h.topics[key] = t
		h.wg.Add(1)
		if h.bus != nil {
			go h.runTopicDistributed(ctx, t)
		} else {
			go h.poll(ctx, t)
		}
	}
	// Keep the hub lock until the subscriber is present. Otherwise the previous
	// last subscriber can observe an empty topic, cancel it, and remove it in
	// the gap between our lookup above and this insertion. The new subscriber
	// would then be attached to an orphaned topic whose poller has already
	// stopped (a connected-but-permanently-stale WebSocket).
	t.mu.Lock()
	t.subs[sub.id] = sub
	if t.hasLast {
		// Replay the latest message so a late joiner gets data immediately.
		h.deliver(sub, t.last)
	}
	t.mu.Unlock()
	h.mu.Unlock()

	release := func() {
		// All operations that can add/remove a topic use the same h.mu -> t.mu
		// order. This makes "last leaves" atomic with "new subscriber joins".
		h.mu.Lock()
		t.mu.Lock()
		delete(t.subs, sub.id)
		empty := len(t.subs) == 0
		if empty {
			if cur, ok := h.topics[key]; ok && cur == t {
				cur.cancel()
				delete(h.topics, key)
			}
		}
		t.mu.Unlock()
		h.mu.Unlock()
		close(sub.ch)
	}
	return sub, release
}

// poll runs the per-topic loop: dispatch immediately, then every cadence, and
// broadcast the serialized data to all subscribers.
func (h *Hub) poll(ctx context.Context, t *topic) {
	defer h.wg.Done()
	ticker := time.NewTicker(h.cadence)
	defer ticker.Stop()

	push := func() {
		msg := h.svc.Dispatch(ctx, t.params)
		t.mu.Lock()
		t.last = msg
		t.hasLast = true
		for _, sub := range t.subs {
			h.deliver(sub, msg)
		}
		t.mu.Unlock()
	}

	push()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			push()
		}
	}
}

// runTopicDistributed runs a topic in bus mode: subscribe to the topic's data
// subject (fan out received frames to local subscribers) and publish demand
// heartbeats so the poller keeps polling this subscription. No local MT5 poll.
func (h *Hub) runTopicDistributed(ctx context.Context, t *topic) {
	defer h.wg.Done()

	unsub, err := h.bus.Subscribe(dataSubject(t.key), func(msg []byte) {
		t.mu.Lock()
		t.last = msg
		t.hasLast = true
		for _, sub := range t.subs {
			h.deliver(sub, msg)
		}
		t.mu.Unlock()
	})
	if err != nil {
		h.log.Error("bus subscribe failed", slog.String("key", t.key), slog.Any("error", err))
		return
	}
	defer unsub()

	demand, _ := json.Marshal(t.params)
	_ = h.bus.Publish(ctx, DemandSubject, demand)

	ticker := time.NewTicker(h.cadence)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			_ = h.bus.Publish(ctx, DemandSubject, demand)
		}
	}
}

// deliver does a non-blocking send. When the subscriber's buffer is full it
// evicts one oldest queued snapshot and retains the newest one. A slow market
// data client must catch up to current state instead of draining stale prices.
// Every eviction is counted as backpressure loss.
func (h *Hub) deliver(sub *subscriber, msg []byte) {
	select {
	case sub.ch <- msg:
	default:
		// This subscriber remains in its topic while deliver runs, so release
		// cannot close the channel until the topic lock is yielded.
		select {
		case <-sub.ch:
		default:
		}
		// The writer may have freed a slot between the failed send and drain.
		// Either way, never block the shared poller on one slow client.
		select {
		case sub.ch <- msg:
		default:
		}
		sub.drop.Add(1)
		if h.onDrop != nil {
			h.onDrop()
		}
	}
}

// Wait blocks until all topic pollers have exited (after the root ctx is done).
func (h *Hub) Wait() { h.wg.Wait() }
