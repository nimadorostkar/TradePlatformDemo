package cache

import (
	"context"
	"testing"

	"github.com/alicebob/miniredis/v2"
)

// The distributed token bucket allows up to `burst` then denies, and a separate
// key (IP) has its own bucket.
func TestRedisLimiter_TokenBucket(t *testing.T) {
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatal(err)
	}
	defer mr.Close()

	r := NewRedis([]string{mr.Addr()}, "")
	defer r.Close()
	if err := r.Ping(context.Background()); err != nil {
		t.Fatal(err)
	}

	lim := NewRedisLimiter(r, 1, 2) // 1 rps, burst 2
	ctx := context.Background()

	// First two requests for an IP are allowed (burst), the third denied.
	for i, want := range []bool{true, true, false} {
		got, err := lim.Allow(ctx, "1.2.3.4")
		if err != nil {
			t.Fatalf("allow %d: %v", i, err)
		}
		if got != want {
			t.Errorf("request %d: allowed=%v, want %v", i, got, want)
		}
	}

	// A different IP has an independent bucket.
	if ok, _ := lim.Allow(ctx, "9.9.9.9"); !ok {
		t.Error("second IP should start with a full bucket")
	}
}

// On a Redis failure the limiter fails open (allows the request).
func TestRedisLimiter_FailOpen(t *testing.T) {
	mr, _ := miniredis.Run()
	r := NewRedis([]string{mr.Addr()}, "")
	mr.Close() // make subsequent calls error

	lim := NewRedisLimiter(r, 1, 1)
	ok, err := lim.Allow(context.Background(), "x")
	if err == nil {
		t.Skip("expected a redis error after close")
	}
	if !ok {
		t.Error("limiter should fail open on redis error")
	}
}
