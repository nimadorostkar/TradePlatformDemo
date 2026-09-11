package realtime

import (
	"context"
	"encoding/json"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"
)

// PollerLockKey is the advisory-lock key that elects the single active poller
// across replicas (distinct from the price-history job lock).
const PollerLockKey int64 = 0x4f504f504f4c4c52 // "OPOPOLLR"

// Locker elects a single active poller (satisfied by timescale.Store). Optional;
// with no Locker every poller replica is active (run a single replica).
type Locker interface {
	TryLock(ctx context.Context, key int64) (bool, func(), error)
}

// Poller is the demand-driven upstream poller. It tracks which subscriptions are
// wanted (from hub demand heartbeats) and polls each ONCE per cadence
// cluster-wide, publishing results to the per-subscription data subject. This is
// what collapses MT5 load to O(symbols) regardless of pods or connections.
type Poller struct {
	bus     Bus
	svc     Services
	cadence time.Duration
	ttl     time.Duration
	locker  Locker
	log     *slog.Logger

	mu     sync.Mutex
	demand map[string]demandEntry
	active atomic.Bool
}

type demandEntry struct {
	params Params
	seen   time.Time
}

// NewPoller constructs a Poller. demandTTL evicts a subscription when no hub has
// refreshed its demand within that window.
func NewPoller(bus Bus, svc Services, cadence, demandTTL time.Duration, locker Locker, log *slog.Logger) *Poller {
	if cadence <= 0 {
		cadence = 3 * time.Second
	}
	if demandTTL <= 0 {
		demandTTL = 3 * cadence
	}
	return &Poller{
		bus: bus, svc: svc, cadence: cadence, ttl: demandTTL, locker: locker,
		log: log.With(slog.String("component", "ws-poller")), demand: map[string]demandEntry{},
	}
}

// Start subscribes to demand and runs the poll loop until ctx is cancelled.
func (p *Poller) Start(ctx context.Context) error {
	unsub, err := p.bus.Subscribe(DemandSubject, p.onDemand)
	if err != nil {
		return err
	}
	go func() { <-ctx.Done(); unsub() }()

	if p.locker != nil {
		go p.maintainLeadership(ctx)
	} else {
		p.active.Store(true)
	}
	go p.loop(ctx)
	p.log.Info("ws poller started")
	return nil
}

// onDemand records (or refreshes) a wanted subscription.
func (p *Poller) onDemand(data []byte) {
	var params Params
	if err := json.Unmarshal(data, &params); err != nil {
		return
	}
	key := params.Key()
	p.mu.Lock()
	p.demand[key] = demandEntry{params: params, seen: timeNow()}
	p.mu.Unlock()
}

// loop polls each currently-wanted subscription once per cadence and publishes
// the result. Only the active (leader) poller polls.
func (p *Poller) loop(ctx context.Context) {
	ticker := time.NewTicker(p.cadence)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if !p.active.Load() {
				continue
			}
			for key, e := range p.snapshot() {
				msg := p.svc.Dispatch(ctx, e.params)
				_ = p.bus.Publish(ctx, dataSubject(key), msg)
			}
		}
	}
}

// snapshot returns the live demand set and evicts entries past the TTL.
func (p *Poller) snapshot() map[string]demandEntry {
	cutoff := timeNow().Add(-p.ttl)
	p.mu.Lock()
	defer p.mu.Unlock()
	out := make(map[string]demandEntry, len(p.demand))
	for k, e := range p.demand {
		if e.seen.Before(cutoff) {
			delete(p.demand, k)
			continue
		}
		out[k] = e
	}
	return out
}

// maintainLeadership makes this replica the single active poller by holding the
// advisory lock; standbys retry until the holder dies.
func (p *Poller) maintainLeadership(ctx context.Context) {
	for {
		if ctx.Err() != nil {
			return
		}
		ok, release, err := p.locker.TryLock(ctx, PollerLockKey)
		if err == nil && ok {
			p.active.Store(true)
			p.log.Info("ws poller became leader")
			<-ctx.Done()
			release()
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(10 * time.Second):
		}
	}
}

// timeNow is a seam for tests.
var timeNow = time.Now
