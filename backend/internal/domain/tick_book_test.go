package domain

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/nimadorostkar/TradePlatformDemo/backend/internal/mt5"
	"github.com/nimadorostkar/TradePlatformDemo/backend/internal/transform"
)

// recordingClient records every path requested and answers per-path.
type recordingClient struct {
	mu    sync.Mutex
	paths []string
	// answer maps a path SUBSTRING to a response body. The first match wins.
	answer map[string][]byte
	// fail maps a path substring to an error.
	fail map[string]error
}

func (c *recordingClient) Get(_ context.Context, path string) ([]byte, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.paths = append(c.paths, path)
	for frag, err := range c.fail {
		if strings.Contains(path, frag) {
			return nil, err
		}
	}
	for frag, body := range c.answer {
		if strings.Contains(path, frag) {
			return body, nil
		}
	}
	return []byte(`{"retcode":"0 Done","answer":{}}`), nil
}

func (c *recordingClient) Post(_ context.Context, _ string, _ []byte) ([]byte, error) {
	return []byte(`{"retcode":"0 Done"}`), nil
}

func (c *recordingClient) requested(frag string) int {
	c.mu.Lock()
	defer c.mu.Unlock()
	n := 0
	for _, p := range c.paths {
		if strings.Contains(p, frag) {
			n++
		}
	}
	return n
}

const bookAnswer = `{"retcode":"0 Done","answer":{"Symbol":"EURUSD","Items":[` +
	`{"Type":1,"Price":1.1002,"Volume":10000},{"Type":2,"Price":1.1000,"Volume":10000}]}}`

// The whole point of the fix: depth is delivered to SUBSCRIBERS, so book/get
// alone answers empty forever.
func TestGetMarketDepth_SubscribesBeforeReading(t *testing.T) {
	c := &recordingClient{answer: map[string][]byte{"/api/book/get": []byte(bookAnswer)}}
	svc := NewTickService(c, nil, false)

	svc.GetMarketDepth(context.Background(), "EURUSD")

	if got := c.requested("/api/book/subscribe"); got != 1 {
		t.Fatalf("expected exactly one subscribe, got %d (paths: %v)", got, c.paths)
	}
	if got := c.requested("/api/book/get"); got != 1 {
		t.Fatalf("expected exactly one book read, got %d", got)
	}
	// Order matters: subscribing after the read would still answer empty.
	if !strings.Contains(c.paths[0], "/api/book/subscribe") {
		t.Fatalf("subscribe must precede the read, got %v", c.paths)
	}
}

// Re-subscribing on every poll would triple the request rate against a symbol
// the DOM polls continuously.
func TestGetMarketDepth_SubscribesOncePerSymbolWithinTTL(t *testing.T) {
	c := &recordingClient{answer: map[string][]byte{"/api/book/get": []byte(bookAnswer)}}
	svc := NewTickService(c, nil, false)

	for i := 0; i < 5; i++ {
		svc.GetMarketDepth(context.Background(), "EURUSD")
	}
	svc.GetMarketDepth(context.Background(), "XAUUSD")

	if got := c.requested("/api/book/subscribe"); got != 2 {
		t.Fatalf("expected one subscribe per symbol, got %d", got)
	}
	if got := c.requested("/api/book/get"); got != 6 {
		t.Fatalf("every call must still read the book, got %d", got)
	}
}

// Not every MT5 deployment exposes the command. Refusing to serve depth
// because we could not subscribe would be strictly worse than the old
// behavior, which at least returned the (empty) book.
func TestGetMarketDepth_SurvivesAFailingSubscribe(t *testing.T) {
	c := &recordingClient{
		answer: map[string][]byte{"/api/book/get": []byte(bookAnswer)},
		fail:   map[string]error{"/api/book/subscribe": &mt5.UpstreamError{Body: []byte("not found")}},
	}
	svc := NewTickService(c, nil, false)

	env := svc.GetMarketDepth(context.Background(), "EURUSD")

	if !env.Success {
		t.Fatalf("a failed subscribe must not fail the depth read: %+v", env)
	}
	if c.requested("/api/book/get") != 1 {
		t.Fatalf("the book must still be read")
	}
}

// A REFUSED symbol is left alone, not retried on the success cadence.
//
// Regression test for a live incident. Retrying a refused subscribe every poll
// meant a request a minute per symbol forever, to be told the same thing — and
// because the upstream answered 403, each attempt also invalidated the shared
// Manager session (see mt5.sessionNeutralPath). Depth still degrades to an
// empty ladder, so nothing is lost by asking far less often.
func TestGetMarketDepth_DoesNotHammerARefusedSubscribe(t *testing.T) {
	c := &recordingClient{
		answer: map[string][]byte{"/api/book/get": []byte(bookAnswer)},
		fail:   map[string]error{"/api/book/subscribe": &mt5.UpstreamError{Body: []byte("boom")}},
	}
	svc := NewTickService(c, nil, false)

	for i := 0; i < 5; i++ {
		svc.GetMarketDepth(context.Background(), "EURUSD")
	}

	if got := c.requested("/api/book/subscribe"); got != 1 {
		t.Fatalf("a refused symbol must be asked once per retry window, got %d attempts", got)
	}
	// The book is still read every time — depth must not become less available
	// than it was before subscription existed.
	if got := c.requested("/api/book/get"); got != 5 {
		t.Fatalf("expected every call to still read the book, got %d", got)
	}
}

// The refusal window is finite, so a transient refusal (a session still warming
// up right after a restart) heals without an operator.
func TestGetMarketDepth_RetriesARefusedSubscribeAfterTheWindow(t *testing.T) {
	c := &recordingClient{
		answer: map[string][]byte{"/api/book/get": []byte(bookAnswer)},
		fail:   map[string]error{"/api/book/subscribe": &mt5.UpstreamError{Body: []byte("boom")}},
	}
	svc := NewTickService(c, nil, false)

	svc.GetMarketDepth(context.Background(), "EURUSD")

	// Age the refusal past its window rather than sleeping for it.
	svc.bookMu.Lock()
	svc.bookRefusedAt["EURUSD"] = time.Now().Unix() - bookSubscribeRetry - 1
	svc.bookMu.Unlock()

	svc.GetMarketDepth(context.Background(), "EURUSD")

	if got := c.requested("/api/book/subscribe"); got != 2 {
		t.Fatalf("expected a retry once the window elapsed, got %d", got)
	}
}

// A recovered subscription clears the refusal, so the symbol returns to the
// normal success cadence instead of staying in the slow lane.
func TestGetMarketDepth_RecoveryClearsTheRefusal(t *testing.T) {
	c := &recordingClient{
		answer: map[string][]byte{"/api/book/get": []byte(bookAnswer)},
		fail:   map[string]error{"/api/book/subscribe": &mt5.UpstreamError{Body: []byte("boom")}},
	}
	svc := NewTickService(c, nil, false)

	svc.GetMarketDepth(context.Background(), "EURUSD")
	if _, refused := svc.bookRefusedAt["EURUSD"]; !refused {
		t.Fatal("a refusal was not recorded")
	}

	// The server starts accepting; age the window so the retry happens.
	c.fail = map[string]error{}
	svc.bookMu.Lock()
	svc.bookRefusedAt["EURUSD"] = time.Now().Unix() - bookSubscribeRetry - 1
	svc.bookMu.Unlock()

	svc.GetMarketDepth(context.Background(), "EURUSD")

	svc.bookMu.Lock()
	defer svc.bookMu.Unlock()
	if _, refused := svc.bookRefusedAt["EURUSD"]; refused {
		t.Fatal("a successful subscribe left the refusal in place")
	}
	if _, ok := svc.bookSubAt["EURUSD"]; !ok {
		t.Fatal("a successful subscribe was not recorded")
	}
}

// The toggle exists for a trade server with no subscribe command; with it off
// the gateway behaves exactly as it did before.
func TestGetMarketDepth_SubscribeCanBeDisabled(t *testing.T) {
	c := &recordingClient{answer: map[string][]byte{"/api/book/get": []byte(bookAnswer)}}
	svc := NewTickService(c, nil, false, WithBookSubscribe(false))

	svc.GetMarketDepth(context.Background(), "EURUSD")

	if got := c.requested("/api/book/subscribe"); got != 0 {
		t.Fatalf("subscribe must be skipped when disabled, got %d", got)
	}
	if got := c.requested("/api/book/get"); got != 1 {
		t.Fatalf("the book must still be read, got %d", got)
	}
}

// An empty symbol reaches MT5 as a malformed request; it is not worth a
// subscribe either.
func TestGetMarketDepth_IgnoresAnEmptySymbol(t *testing.T) {
	c := &recordingClient{}
	svc := NewTickService(c, nil, false)

	svc.GetMarketDepth(context.Background(), "")

	if got := c.requested("/api/book/subscribe"); got != 0 {
		t.Fatalf("expected no subscribe for an empty symbol, got %d", got)
	}
}

// An empty ladder has two very different causes, and a client must be able to
// tell them apart: an instrument that publishes no depth, and a gateway that
// was never able to ask for any.
//
// Observed live on 2026-08-21 — every symbol's book/subscribe answered 504 and
// every ladder came back empty AND successful, so the terminal told traders
// "not every instrument publishes depth" about instruments whose depth it had
// simply failed to subscribe to.
func TestGetMarketDepth_SaysWhyTheBookIsEmpty(t *testing.T) {
	t.Run("reports a refused subscription", func(t *testing.T) {
		c := &recordingClient{
			answer: map[string][]byte{"/api/book/get": []byte(emptyBookAnswer)},
			fail:   map[string]error{"/api/book/subscribe": errUpstream},
		}
		svc := NewTickService(c, nil, false)

		depth := marketDepthOf(t, svc)
		if depth.Subscribed {
			t.Error("a refused subscription must not report itself as subscribed")
		}
		if depth.SubscribeError == "" {
			t.Fatal("an empty book with no subscription must say why")
		}
		// The reason is about the LINK, not the instrument: this gateway does
		// not know whether the symbol has depth, only that it could not ask.
		if strings.Contains(strings.ToLower(depth.SubscribeError), "publish") {
			t.Errorf("must not claim anything about the instrument: %q", depth.SubscribeError)
		}
	})

	t.Run("claims nothing when the book is genuinely empty", func(t *testing.T) {
		c := &recordingClient{answer: map[string][]byte{"/api/book/get": []byte(emptyBookAnswer)}}
		svc := NewTickService(c, nil, false)

		depth := marketDepthOf(t, svc)
		if !depth.Subscribed {
			t.Error("a successful subscribe must report itself as subscribed")
		}
		if depth.SubscribeError != "" {
			t.Errorf("a subscribed symbol needs no excuse: %q", depth.SubscribeError)
		}
	})

	t.Run("keeps saying so inside the refusal window", func(t *testing.T) {
		// The second read does not re-ask upstream, but the client still has to
		// be told the ladder is empty for a reason it cannot see.
		c := &recordingClient{
			answer: map[string][]byte{"/api/book/get": []byte(emptyBookAnswer)},
			fail:   map[string]error{"/api/book/subscribe": errUpstream},
		}
		svc := NewTickService(c, nil, false)

		marketDepthOf(t, svc)
		second := marketDepthOf(t, svc)

		if c.requested("/api/book/subscribe") != 1 {
			t.Fatalf("refusal window should suppress the retry, got %d", c.requested("/api/book/subscribe"))
		}
		if second.Subscribed || second.SubscribeError == "" {
			t.Error("a suppressed retry must still report the book as unsubscribed, with a reason")
		}
	})
}

const emptyBookAnswer = `{"retcode":"0 Done","answer":{"Symbol":"EURUSD","Items":[]}}`

var errUpstream = errors.New("upstream 504")

func marketDepthOf(t *testing.T, svc *TickService) transform.MarketDepth {
	t.Helper()
	env := svc.GetMarketDepth(context.Background(), "EURUSD")
	depth, ok := env.Data.(transform.MarketDepth)
	if !ok {
		t.Fatalf("unexpected payload %T", env.Data)
	}
	return depth
}
