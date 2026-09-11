package mt5

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/sony/gobreaker"
)

type fakeInner struct {
	err  error
	body []byte
}

func (f *fakeInner) Get(_ context.Context, _ string) ([]byte, error) { return f.body, f.err }
func (f *fakeInner) Post(_ context.Context, _ string, _ []byte) ([]byte, error) {
	return f.body, f.err
}

func newTestBreaker(in inner, count func(string)) *CircuitClient {
	return newCircuitClient(in, gobreaker.Settings{
		Name:        "test",
		Timeout:     50 * time.Millisecond,
		ReadyToTrip: func(c gobreaker.Counts) bool { return c.ConsecutiveFailures >= 3 },
	}, count)
}

// A business error (UpstreamError) propagates but never trips the breaker.
func TestBreaker_BusinessErrorDoesNotTrip(t *testing.T) {
	in := &fakeInner{err: &UpstreamError{Status: 400, Body: []byte("bad")}}
	cc := newTestBreaker(in, nil)
	for i := 0; i < 10; i++ {
		if _, err := cc.Get(context.Background(), "/x"); err == nil {
			t.Fatal("expected upstream error")
		}
	}
	if cc.cb.State() != gobreaker.StateClosed {
		t.Errorf("breaker tripped on business errors: %v", cc.cb.State())
	}
}

// Transport errors trip the breaker after the threshold; once open it fails fast.
func TestBreaker_TransportErrorTrips(t *testing.T) {
	in := &fakeInner{err: errors.New("dial timeout")}
	var openCount int
	cc := newTestBreaker(in, func(r string) {
		if r == "open" {
			openCount++
		}
	})
	for i := 0; i < 3; i++ {
		_, _ = cc.Get(context.Background(), "/x")
	}
	if cc.cb.State() != gobreaker.StateOpen {
		t.Fatalf("expected open breaker, got %v", cc.cb.State())
	}
	// Now requests fail fast without calling the inner client.
	if _, err := cc.Get(context.Background(), "/x"); !errors.Is(err, gobreaker.ErrOpenState) {
		t.Errorf("expected ErrOpenState, got %v", err)
	}
	if openCount == 0 {
		t.Error("open result not counted")
	}
}

// Success is counted and returned.
func TestBreaker_Success(t *testing.T) {
	in := &fakeInner{body: []byte("ok")}
	var okCount int
	cc := newTestBreaker(in, func(r string) {
		if r == "ok" {
			okCount++
		}
	})
	b, err := cc.Get(context.Background(), "/x")
	if err != nil || string(b) != "ok" {
		t.Fatalf("got %q, %v", b, err)
	}
	if okCount != 1 {
		t.Errorf("ok not counted: %d", okCount)
	}
}
