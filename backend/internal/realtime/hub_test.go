package realtime

import (
	"context"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/nimadorostkar/TradePlatformDemo/backend/internal/domain"
)

// fakeMT5 returns a fixed body so the tick dispatch produces a deterministic msg.
type fakeMT5 struct{ body []byte }

func (f fakeMT5) Get(_ context.Context, _ string) ([]byte, error)            { return f.body, nil }
func (f fakeMT5) Post(_ context.Context, _ string, _ []byte) ([]byte, error) { return f.body, nil }

func testServices() Services {
	c := fakeMT5{body: []byte(`{"retcode":"0 Done","answer":[{"Symbol":"EURUSD","Bid":1.1,"Ask":1.2,"Last":0,"Volume":5}]}`)}
	return Services{
		Tick:     domain.NewTickService(c, nil, false),
		Position: domain.NewPositionService(c),
		User:     domain.NewUserService(c),
		Order:    domain.NewOrderService(c),
	}
}

// A late joiner gets the cached last message immediately, and two subscribers to
// the same key share one topic (fan-out).
func TestHubFanOutAndReplay(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	hub := NewHub(ctx, testServices(), 50*time.Millisecond, 8, log)

	p := Params{TP: "1", MethodType: "GetQuotes", Symbol: "EURUSD", Source: "tv"}

	sub1, rel1 := hub.subscribe(p)
	defer rel1()

	// First message arrives on the immediate push.
	select {
	case msg := <-sub1.ch:
		if len(msg) == 0 {
			t.Fatal("empty message")
		}
	case <-time.After(time.Second):
		t.Fatal("no initial message")
	}

	// A second subscriber with the same key shares the topic and gets the
	// replayed last message immediately.
	sub2, rel2 := hub.subscribe(p)
	defer rel2()
	select {
	case <-sub2.ch:
	case <-time.After(time.Second):
		t.Fatal("late joiner got no replay")
	}

	hub.mu.Lock()
	n := len(hub.topics)
	hub.mu.Unlock()
	if n != 1 {
		t.Errorf("expected 1 shared topic, got %d", n)
	}
}

// Invalid TP streams the literal "Invalid TP value".
func TestDispatchInvalidTP(t *testing.T) {
	msg := testServices().Dispatch(context.Background(), Params{TP: "9"})
	if string(msg) != "Invalid TP value" {
		t.Errorf("got %q, want Invalid TP value", msg)
	}
}

// Topic is torn down after the last subscriber leaves.
func TestHubTopicCleanup(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	hub := NewHub(ctx, testServices(), 50*time.Millisecond, 8, log)

	_, rel := hub.subscribe(Params{TP: "1", MethodType: "GetQuotes", Symbol: "EURUSD"})
	rel()
	hub.mu.Lock()
	n := len(hub.topics)
	hub.mu.Unlock()
	if n != 0 {
		t.Errorf("topic not cleaned up, %d remain", n)
	}
}

func TestHubBackpressureRetainsNewestSnapshot(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	hub := NewHub(ctx, testServices(), time.Second, 1, log)

	drops := 0
	hub.SetOnDrop(func() { drops++ })
	sub := &subscriber{ch: make(chan []byte, 1)}
	hub.deliver(sub, []byte("old"))
	hub.deliver(sub, []byte("new"))

	if got := string(<-sub.ch); got != "new" {
		t.Fatalf("queued snapshot = %q, want newest snapshot", got)
	}
	if got := sub.drop.Load(); got != 1 {
		t.Fatalf("subscriber drop count = %d, want 1", got)
	}
	if drops != 1 {
		t.Fatalf("global drop hook count = %d, want 1", drops)
	}
}

// Replacing the final subscriber must never leave the replacement attached to
// a canceled/orphaned topic. This repeatedly exercises the handoff while the
// race detector verifies the lock discipline.
func TestHubConcurrentLastLeaveAndJoin(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	hub := NewHub(ctx, testServices(), time.Millisecond, 8, log)
	p := Params{TP: "1", MethodType: "GetQuotes", Symbol: "EURUSD", Source: "tv"}

	_, release := hub.subscribe(p)
	for i := 0; i < 500; i++ {
		joined := make(chan struct{})
		var nextRelease func()
		go func() {
			_, nextRelease = hub.subscribe(p)
			close(joined)
		}()
		release()
		<-joined

		hub.mu.Lock()
		topic := hub.topics[p.Key()]
		hub.mu.Unlock()
		if topic == nil {
			t.Fatalf("iteration %d: replacement subscriber has no live topic", i)
		}
		release = nextRelease
	}
	release()
}
