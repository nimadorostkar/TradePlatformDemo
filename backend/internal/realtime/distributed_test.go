package realtime

import (
	"context"
	"io"
	"log/slog"
	"testing"
	"time"
)

func discardLog() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

// InProcBus delivers published messages to subscribers of the same subject.
func TestInProcBus_PubSub(t *testing.T) {
	b := NewInProcBus()
	got := make(chan []byte, 1)
	unsub, err := b.Subscribe("s.1", func(d []byte) { got <- d })
	if err != nil {
		t.Fatal(err)
	}
	defer unsub()
	_ = b.Publish(context.Background(), "s.1", []byte("hello"))
	select {
	case d := <-got:
		if string(d) != "hello" {
			t.Errorf("got %q", d)
		}
	case <-time.After(time.Second):
		t.Fatal("no delivery")
	}
}

// Full distributed flow over the in-proc bus: a hub subscriber receives data
// produced by the poller (hub publishes demand → poller polls → publishes →
// hub fans out). This is the cross-pod path exercised in a single process.
func TestDistributed_HubPollerEndToEnd(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	bus := NewInProcBus()

	hub := NewHub(ctx, testServices(), 30*time.Millisecond, 8, discardLog())
	hub.SetBus(bus)

	poller := NewPoller(bus, testServices(), 30*time.Millisecond, 0, nil, discardLog())
	if err := poller.Start(ctx); err != nil {
		t.Fatal(err)
	}
	if !poller.active.Load() {
		t.Fatal("poller should be active with no locker")
	}

	sub, release := hub.subscribe(Params{TP: "1", MethodType: "GetQuotes", Symbol: "EURUSD", Source: "tv"})
	defer release()

	select {
	case msg := <-sub.ch:
		if len(msg) == 0 {
			t.Fatal("empty message")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no data flowed hub<-bus<-poller")
	}
}

type denyLocker struct{}

func (denyLocker) TryLock(_ context.Context, _ int64) (bool, func(), error) {
	return false, func() {}, nil
}

// A poller that can't win leadership stays inactive (standby).
func TestPoller_LeaderGate(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	p := NewPoller(NewInProcBus(), testServices(), 30*time.Millisecond, 0, denyLocker{}, discardLog())
	if err := p.Start(ctx); err != nil {
		t.Fatal(err)
	}
	time.Sleep(100 * time.Millisecond)
	if p.active.Load() {
		t.Error("poller should be inactive without leadership")
	}
}
