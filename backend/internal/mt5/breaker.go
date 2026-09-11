package mt5

import (
	"context"
	"errors"
	"time"

	"github.com/sony/gobreaker"
	"golang.org/x/sync/singleflight"
)

// inner is the upstream client the breaker wraps (satisfied by *Manager).
type inner interface {
	Get(ctx context.Context, path string) ([]byte, error)
	Post(ctx context.Context, path string, body []byte) ([]byte, error)
}

// CircuitClient wraps an upstream client with a circuit breaker. Transport
// failures trip the breaker (fail fast instead of hanging); upstream business
// errors (non-2xx with a body) are NOT counted as failures, so a 4xx from MT5
// doesn't open the circuit. It satisfies the same Get/Post contract as Manager.
type CircuitClient struct {
	m     inner
	cb    *gobreaker.CircuitBreaker
	count func(result string) // metrics hook: "ok" | "error" | "open"
	// Identical concurrent GETs share one upstream round trip. The gateway
	// talks to MT5 over a single pinned connection, so every duplicate read
	// (several clients charting the same symbol, a bootstrap burst asking the
	// same question twice) queued behind the serialized socket and stretched
	// tail latency — history TTFBs of 18–21 s were measured while the actual
	// download took 4 ms. Reads only: mutations are never coalesced.
	flights singleflight.Group
}

// NewCircuitClient wraps m. count may be nil.
func NewCircuitClient(m *Manager, count func(string)) *CircuitClient {
	return newCircuitClient(m, gobreaker.Settings{
		Name:        "mt5",
		MaxRequests: 1,
		Interval:    60 * time.Second,
		Timeout:     30 * time.Second,
		ReadyToTrip: func(c gobreaker.Counts) bool { return c.ConsecutiveFailures > 5 },
	}, count)
}

func newCircuitClient(m inner, settings gobreaker.Settings, count func(string)) *CircuitClient {
	if count == nil {
		count = func(string) {}
	}
	return &CircuitClient{m: m, cb: gobreaker.NewCircuitBreaker(settings), count: count}
}

type result struct {
	body []byte
	err  error
}

func (c *CircuitClient) exec(fn func() ([]byte, error)) ([]byte, error) {
	out, brErr := c.cb.Execute(func() (any, error) {
		b, e := fn()
		if e != nil {
			var ue *UpstreamError
			if errors.As(e, &ue) {
				// Business error: propagate but don't trip the breaker.
				return result{body: b, err: e}, nil
			}
			return nil, e // transport error: counts as a failure
		}
		return result{body: b}, nil
	})
	if brErr != nil {
		// Breaker open or a transport failure.
		if errors.Is(brErr, gobreaker.ErrOpenState) || errors.Is(brErr, gobreaker.ErrTooManyRequests) {
			c.count("open")
		} else {
			c.count("error")
		}
		return nil, brErr
	}
	r := out.(result)
	if r.err != nil {
		c.count("error")
	} else {
		c.count("ok")
	}
	return r.body, r.err
}

// Get executes a GET through the breaker. Concurrent calls for the same path
// (the path carries the full query: symbol, window, resolution) share one
// upstream round trip and each receive their own copy of the body.
func (c *CircuitClient) Get(ctx context.Context, path string) ([]byte, error) {
	// The shared flight is detached from any single caller's cancellation —
	// one impatient client hanging up must not fail the read for the others.
	// The manager's own RequestTimeout still bounds the flight.
	flightCtx := context.WithoutCancel(ctx)
	v, err, shared := c.flights.Do(path, func() (any, error) {
		b, e := c.exec(func() ([]byte, error) { return c.m.Get(flightCtx, path) })
		return b, e
	})
	// The body is returned ALONGSIDE the error, exactly as exec does: an MT5
	// business error (UpstreamError) still carries a body, and toEnvelope
	// forwards it as the envelope's data. An earlier version of this wrapper
	// returned nil on any error — which turned a flapping broker's answered-
	// with-error head window into an EMPTY envelope, and the chart library
	// reads an empty first page followed by an empty lookback as "this symbol
	// has no data, stop asking": the 2026-08-24 permanently-blank-chart
	// regression (~2 of 8 cold loads, tracking the flap rate).
	body, _ := v.([]byte)
	if shared && body != nil {
		// Callers unmarshal in place; duplicates get a copy so no consumer
		// can observe another's buffer.
		dup := make([]byte, len(body))
		copy(dup, body)
		return dup, err
	}
	return body, err
}

// Post executes a POST through the breaker.
func (c *CircuitClient) Post(ctx context.Context, path string, body []byte) ([]byte, error) {
	return c.exec(func() ([]byte, error) { return c.m.Post(ctx, path, body) })
}

// IsBreakerOpen reports whether err is the breaker refusing to forward a call
// — either fully open or over the half-open request budget. Callers use it to
// treat "the gateway is protecting a sick upstream" differently from a fresh
// transport failure: the former repeats hundreds of times a minute and says
// the same thing every time.
func IsBreakerOpen(err error) bool {
	return errors.Is(err, gobreaker.ErrOpenState) || errors.Is(err, gobreaker.ErrTooManyRequests)
}
