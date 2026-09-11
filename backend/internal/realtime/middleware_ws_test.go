package realtime

import (
	"context"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/go-chi/chi/v5"

	"github.com/nimadorostkar/TradePlatformDemo/backend/internal/httpapi/middleware"
	"github.com/nimadorostkar/TradePlatformDemo/backend/internal/observability"
)

// Regression for the 501 bug: the WS endpoint must upgrade when wrapped by the
// RequestLogger + Metrics middleware (whose response wrapper must forward
// http.Hijacker). Before the fix this returned 501 Not Implemented.
func TestWS_UpgradesThroughMiddleware(t *testing.T) {
	ctx, c := context.WithCancel(context.Background())
	defer c()
	h := NewHandler(ctx, NewHub(ctx, testServices(), 50*time.Millisecond, 8, discardLog()),
		nil, HandlerConfig{AllowedOrigins: []string{"*"}, WriteTimeout: 2 * time.Second, MaxMessageSize: 16384},
		discardLog())

	r := chi.NewRouter()
	r.Use(middleware.RequestLogger(discardLog()))
	r.Use(middleware.Metrics(observability.NewMetrics()))
	r.Handle("/ws", h)

	ts := httptest.NewServer(r)
	defer ts.Close()

	dctx, dcancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer dcancel()
	conn, _, err := websocket.Dial(dctx, wsURL(ts.URL)+"/ws?TP=1&methodtype=GetQuotes&symbol=EURUSD&source=tv", nil)
	if err != nil {
		t.Fatalf("ws dial through middleware failed (the 501 regression): %v", err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "")
	if _, data, err := conn.Read(dctx); err != nil || !strings.Contains(string(data), "symbolname") {
		t.Fatalf("read: %v data=%s", err, data)
	}
}
