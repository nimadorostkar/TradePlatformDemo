package realtime

import (
	"context"
	"io"
	"log/slog"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/nimadorostkar/TradePlatformDemo/backend/internal/domain"
)

// countingMT5 counts upstream calls, standing in for the MT5 Manager API.
type countingMT5 struct {
	calls atomic.Int64
	body  []byte
}

func (c *countingMT5) Get(context.Context, string) ([]byte, error) {
	c.calls.Add(1)
	return c.body, nil
}
func (c *countingMT5) Post(context.Context, string, []byte) ([]byte, error) {
	c.calls.Add(1)
	return c.body, nil
}

// Phase-1 validation, item 3: 100 WebSocket clients subscribed to the same
// tick symbol must cost ONE MT5 poll per push cadence — not one per client
// (the .NET behavior). This runs 100 real connections end-to-end through the
// /ws handler and counts upstream calls over a measured window.
func TestWS_100ClientsOneSymbol_OnePollPerCadence(t *testing.T) {
	upstream := &countingMT5{body: []byte(`{"retcode":"0 Done","answer":[{"Symbol":"EURUSD","Bid":1.1,"Ask":1.2,"Last":0,"Volume":5}]}`)}
	services := Services{
		Tick:     domain.NewTickService(upstream, nil, false),
		Position: domain.NewPositionService(upstream),
		User:     domain.NewUserService(upstream),
		Order:    domain.NewOrderService(upstream),
	}

	const (
		clients = 100
		cadence = 50 * time.Millisecond
		window  = 20 // cadences to measure
	)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	hub := NewHub(ctx, services, cadence, 64, log)
	h := NewHandler(ctx, hub, nil, HandlerConfig{
		RequireAuth:    false,
		AllowedOrigins: []string{"*"},
		WriteTimeout:   5 * time.Second,
		MaxMessageSize: 16384,
	}, log)
	srv := httptest.NewServer(h)
	defer srv.Close()

	// Connect all clients; each keeps draining frames and counts them.
	dialCtx, dcancel := context.WithTimeout(ctx, 30*time.Second)
	defer dcancel()
	frameCounts := make([]atomic.Int64, clients)
	conns := make([]*websocket.Conn, clients)
	var wg sync.WaitGroup
	for i := 0; i < clients; i++ {
		conn, _, err := websocket.Dial(dialCtx, wsURL(srv.URL)+"/ws?TP=1&methodtype=GetQuotes&symbol=EURUSD&source=tv", nil)
		if err != nil {
			t.Fatalf("client %d dial: %v", i, err)
		}
		conns[i] = conn
		wg.Add(1)
		go func(i int, conn *websocket.Conn) {
			defer wg.Done()
			for {
				if _, _, err := conn.Read(ctx); err != nil {
					return
				}
				frameCounts[i].Add(1)
			}
		}(i, conn)
	}
	defer func() {
		for _, c := range conns {
			c.CloseNow()
		}
		cancel()
		wg.Wait()
	}()

	// Wait until every client has received at least one frame (all subscribed).
	deadline := time.Now().Add(10 * time.Second)
	for {
		ready := 0
		for i := range frameCounts {
			if frameCounts[i].Load() > 0 {
				ready++
			}
		}
		if ready == clients {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("only %d/%d clients received an initial frame", ready, clients)
		}
		time.Sleep(10 * time.Millisecond)
	}

	// Measure: over N cadences, upstream polls must track the cadence count,
	// not clients × cadences.
	upstream.calls.Store(0)
	time.Sleep(time.Duration(window) * cadence)
	polls := upstream.calls.Load()

	t.Logf("%d clients, %d cadences: %d upstream MT5 polls (%.2f per cadence)",
		clients, window, polls, float64(polls)/float64(window))

	if polls == 0 {
		t.Fatal("no upstream polls during the window; stream is dead")
	}
	// Allow scheduling jitter (±50%), but 100 clients polling individually
	// would produce ~clients×window = 2000 calls — orders of magnitude above.
	if polls > int64(window*3/2) {
		t.Errorf("upstream polls = %d over %d cadences; want ~1 per cadence (shared topic), looks like per-client polling", polls, window)
	}

	// Sanity: clients keep receiving during the window too.
	stalled := 0
	for i := range frameCounts {
		if frameCounts[i].Load() < 2 {
			stalled++
		}
	}
	if stalled > 0 {
		t.Errorf("%d/%d clients stopped receiving frames during the window", stalled, clients)
	}
}
