package mt5

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/sony/gobreaker"
)

// blockingInner counts calls and holds every request until released, so a
// test can prove concurrency was collapsed rather than merely fast.
type blockingInner struct {
	calls   atomic.Int64
	posts   atomic.Int64
	release chan struct{}
}

func (b *blockingInner) Get(ctx context.Context, path string) ([]byte, error) {
	b.calls.Add(1)
	<-b.release
	return []byte(`{"answer":[1]}`), nil
}

func (b *blockingInner) Post(ctx context.Context, path string, body []byte) ([]byte, error) {
	b.posts.Add(1)
	<-b.release
	return []byte(`{}`), nil
}

func flightSettings() gobreaker.Settings {
	return gobreaker.Settings{Name: "test", MaxRequests: 100,
		ReadyToTrip: func(c gobreaker.Counts) bool { return false }}
}

// The gateway serializes on one MT5 socket, so duplicate concurrent reads
// used to queue behind each other — measured as 18-21s history TTFBs with
// 4ms downloads. Identical GETs must share one upstream round trip.
func TestConcurrentIdenticalGetsShareOneUpstreamCall(t *testing.T) {
	up := &blockingInner{release: make(chan struct{})}
	c := newCircuitClient(up, flightSettings(), nil)

	const dups = 8
	var wg sync.WaitGroup
	bodies := make([][]byte, dups)
	for i := range dups {
		wg.Add(1)
		go func() {
			defer wg.Done()
			bodies[i], _ = c.Get(context.Background(), "/api/tick/last?symbol=EURUSD")
		}()
	}
	// A different path must not join the flight.
	var other []byte
	wg.Add(1)
	go func() { defer wg.Done(); other, _ = c.Get(context.Background(), "/api/tick/last?symbol=GBPUSD") }()

	// Wait for both distinct flights to be in the upstream, then give every
	// launched goroutine time to JOIN its flight before releasing — a
	// straggler that entered Do after the flight completed would start a
	// third upstream call and fail the assertion below spuriously.
	for up.calls.Load() < 2 {
	}
	time.Sleep(100 * time.Millisecond)
	close(up.release)
	wg.Wait()

	if got := up.calls.Load(); got != 2 {
		t.Fatalf("upstream saw %d GETs, want 2 (one per distinct path)", got)
	}
	if other == nil || bodies[0] == nil {
		t.Fatal("callers did not all receive bodies")
	}
	// Duplicates must not share a buffer with each other.
	bodies[0][0] = 'X'
	if bodies[1][0] == 'X' {
		t.Fatal("two callers observed the same backing buffer")
	}
}

// Mutations are never coalesced: two identical POSTs are two orders.
func TestConcurrentIdenticalPostsAreNeverCoalesced(t *testing.T) {
	up := &blockingInner{release: make(chan struct{})}
	c := newCircuitClient(up, flightSettings(), nil)

	var wg sync.WaitGroup
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, _ = c.Post(context.Background(), "/api/trade/send", []byte(`{"volume":1}`))
		}()
	}
	for up.posts.Load() < 2 {
	}
	close(up.release)
	wg.Wait()

	if got := up.posts.Load(); got != 2 {
		t.Fatalf("upstream saw %d POSTs, want 2 — a coalesced mutation is a lost order", got)
	}
}

// errorWithBodyInner answers every GET with an UpstreamError that still
// carries a body — MT5's shape for a business refusal.
type errorWithBodyInner struct{}

func (e *errorWithBodyInner) Get(ctx context.Context, path string) ([]byte, error) {
	return []byte(`{"retcode":"1 Partial","answer":[{"Symbol":"EURUSD"}]}`),
		&UpstreamError{Status: 502, Body: []byte("partial")}
}
func (e *errorWithBodyInner) Post(ctx context.Context, path string, body []byte) ([]byte, error) {
	return nil, nil
}

// A business error's body must survive the single-flight wrapper. toEnvelope
// forwards that body as the envelope's data even when err != nil; dropping it
// turned a flapped head-window answer into an empty envelope, which the chart
// library reads as "this symbol has no data, stop asking" — the 2026-08-24
// permanently-blank-chart regression.
func TestFlightPreservesBodyAlongsideUpstreamError(t *testing.T) {
	c := newCircuitClient(&errorWithBodyInner{}, flightSettings(), nil)

	body, err := c.Get(context.Background(), "/api/chart/get?symbol=EURUSD")
	if err == nil {
		t.Fatal("the upstream error must propagate")
	}
	if len(body) == 0 {
		t.Fatal("the body accompanying an UpstreamError was dropped by the flight wrapper")
	}
}
