package realtime

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/nimadorostkar/TradePlatformDemo/backend/internal/auth"
)

func wsURL(s string) string { return "ws" + strings.TrimPrefix(s, "http") }

func newTestHandler(t *testing.T, requireAuth bool, v Validator) (*httptest.Server, context.CancelFunc) {
	return newTestHandlerConfig(t, requireAuth, true, v)
}

func newTestHandlerConfig(t *testing.T, requireAuth, allowQueryToken bool, v Validator) (*httptest.Server, context.CancelFunc) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	hub := NewHub(ctx, testServices(), 50*time.Millisecond, 8, log)
	h := NewHandler(ctx, hub, v, HandlerConfig{
		RequireAuth:     requireAuth,
		AllowQueryToken: allowQueryToken,
		AllowedOrigins:  []string{"*"},
		WriteTimeout:    2 * time.Second,
		MaxMessageSize:  16384,
	}, log)
	return httptest.NewServer(h), cancel
}

func protocolDialOptions(token string) *websocket.DialOptions {
	return &websocket.DialOptions{Subprotocols: []string{wsApplicationProtocol, wsJWTProtocolPrefix + token}}
}

// Anonymous /ws (RequireAuth=false) accepts and streams a tick frame.
func TestWS_StreamsTick(t *testing.T) {
	srv, cancel := newTestHandler(t, false, nil)
	defer cancel()
	defer srv.Close()

	ctx, c := context.WithTimeout(context.Background(), 3*time.Second)
	defer c()
	conn, _, err := websocket.Dial(ctx, wsURL(srv.URL)+"/ws?TP=1&methodtype=GetQuotes&symbol=EURUSD&source=tv", nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "")

	typ, data, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if typ != websocket.MessageText {
		t.Errorf("type = %v, want text", typ)
	}
	if !strings.Contains(string(data), `"symbolname":"EURUSD"`) {
		t.Errorf("unexpected frame: %s", data)
	}
}

// RequireAuth=true rejects a tokenless connection with 401 before upgrade.
func TestWS_RequiresAuth(t *testing.T) {
	srv, cancel := newTestHandler(t, true, nil)
	defer cancel()
	defer srv.Close()

	ctx, c := context.WithTimeout(context.Background(), 3*time.Second)
	defer c()
	_, resp, err := websocket.Dial(ctx, wsURL(srv.URL)+"/ws?TP=1&methodtype=GetQuotes&symbol=EURUSD", nil)
	if err == nil {
		t.Fatal("expected dial to fail without a token")
	}
	if resp == nil || resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %v", resp)
	}
}

// A valid token for account A must NOT open a stream scoped to account B
// (positions/orders/user data) — that would leak data between clients.
func TestWS_RejectsForeignAccountLogin(t *testing.T) {
	j, err := auth.NewJWT(auth.JWTConfig{Secret: "s", Expiry: time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	tok, _ := j.GenerateForAccounts([]string{"1001", "1002"})

	srv, cancel := newTestHandler(t, true, j)
	defer cancel()
	defer srv.Close()

	ctx, c := context.WithTimeout(context.Background(), 3*time.Second)
	defer c()
	_, resp, err := websocket.Dial(ctx, wsURL(srv.URL)+"/ws?TP=2&methodtype=GetPositions&login=2002&access_token="+tok, nil)
	if err == nil {
		t.Fatal("expected dial to fail for a login outside the token's accounts")
	}
	if resp == nil || resp.StatusCode != http.StatusForbidden {
		t.Fatalf("expected 403, got %v", resp)
	}
}

// A token whose accounts claim contains the requested login is accepted.
func TestWS_AllowsOwnAccountLogin(t *testing.T) {
	j, err := auth.NewJWT(auth.JWTConfig{Secret: "s", Expiry: time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	tok, _ := j.GenerateForAccounts([]string{"1001", "1002"})

	srv, cancel := newTestHandler(t, true, j)
	defer cancel()
	defer srv.Close()

	ctx, c := context.WithTimeout(context.Background(), 3*time.Second)
	defer c()
	conn, _, err := websocket.Dial(ctx, wsURL(srv.URL)+"/ws?TP=1&methodtype=GetQuotes&symbol=EURUSD&source=tv&login=1002&access_token="+tok, nil)
	if err != nil {
		t.Fatalf("dial with owned login: %v", err)
	}
	conn.Close(websocket.StatusNormalClosure, "")
}

// A token with no accounts claim owns no accounts: any login-scoped
// subscription is rejected.
func TestWS_RejectsLoginWithoutAccountsClaim(t *testing.T) {
	j, err := auth.NewJWT(auth.JWTConfig{Secret: "s", Expiry: time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	tok, _ := j.GenerateForUser("alice") // name-only token, no accounts

	srv, cancel := newTestHandler(t, true, j)
	defer cancel()
	defer srv.Close()

	ctx, c := context.WithTimeout(context.Background(), 3*time.Second)
	defer c()
	_, resp, err := websocket.Dial(ctx, wsURL(srv.URL)+"/ws?TP=4&methodtype=GetOrders&login=1001&access_token="+tok, nil)
	if err == nil {
		t.Fatal("expected dial to fail: token has no accounts claim")
	}
	if resp == nil || resp.StatusCode != http.StatusForbidden {
		t.Fatalf("expected 403, got %v", resp)
	}
}

// Migration mode accepts a connection bearing a valid legacy query token.
func TestWS_AuthorizedWithToken(t *testing.T) {
	j, err := auth.NewJWT(auth.JWTConfig{Secret: "s", Expiry: time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	tok, _ := j.GenerateForUser("alice")

	srv, cancel := newTestHandler(t, true, j)
	defer cancel()
	defer srv.Close()

	ctx, c := context.WithTimeout(context.Background(), 3*time.Second)
	defer c()
	conn, _, err := websocket.Dial(ctx, wsURL(srv.URL)+"/ws?TP=1&methodtype=GetQuotes&symbol=EURUSD&source=tv&access_token="+tok, nil)
	if err != nil {
		t.Fatalf("dial with token: %v", err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "")
	if _, _, err := conn.Read(ctx); err != nil {
		t.Fatalf("read: %v", err)
	}
}

func TestWS_AuthorizedWithCredentialSubprotocolWithoutQueryToken(t *testing.T) {
	j, err := auth.NewJWT(auth.JWTConfig{Secret: "s", Expiry: time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	tok, _ := j.GenerateForUser("alice")

	srv, cancel := newTestHandlerConfig(t, true, false, j)
	defer cancel()
	defer srv.Close()

	ctx, c := context.WithTimeout(context.Background(), 3*time.Second)
	defer c()
	conn, _, err := websocket.Dial(ctx, wsURL(srv.URL)+"/ws?TP=1&methodtype=GetQuotes&symbol=EURUSD&source=tv", protocolDialOptions(tok))
	if err != nil {
		t.Fatalf("dial with credential protocol: %v", err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "")
	if got := conn.Subprotocol(); got != wsApplicationProtocol {
		t.Fatalf("negotiated subprotocol = %q, want %q", got, wsApplicationProtocol)
	}
	if _, _, err := conn.Read(ctx); err != nil {
		t.Fatalf("read: %v", err)
	}
}

func TestWS_QueryTokenCanBeDisabled(t *testing.T) {
	j, err := auth.NewJWT(auth.JWTConfig{Secret: "s", Expiry: time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	tok, _ := j.GenerateForUser("alice")

	srv, cancel := newTestHandlerConfig(t, true, false, j)
	defer cancel()
	defer srv.Close()

	ctx, c := context.WithTimeout(context.Background(), 3*time.Second)
	defer c()
	_, resp, err := websocket.Dial(ctx, wsURL(srv.URL)+"/ws?TP=1&methodtype=GetQuotes&symbol=EURUSD&access_token="+tok, nil)
	if err == nil {
		t.Fatal("expected query token to be rejected")
	}
	if resp == nil || resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %v", resp)
	}
}

func TestWebsocketProtocolTokenRejectsAmbiguousCredentials(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "/ws", nil)
	r.Header.Add("Sec-WebSocket-Protocol", wsApplicationProtocol+", "+wsJWTProtocolPrefix+"first")
	r.Header.Add("Sec-WebSocket-Protocol", wsJWTProtocolPrefix+"second")
	if got, present := websocketProtocolToken(r); got != "" || !present {
		t.Fatalf("ambiguous credential token = %q, want empty", got)
	}
}

func TestWS_AmbiguousCredentialProtocolsDoNotFallBackToQuery(t *testing.T) {
	j, err := auth.NewJWT(auth.JWTConfig{Secret: "s", Expiry: time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	tok, _ := j.GenerateForUser("alice")

	srv, cancel := newTestHandlerConfig(t, true, true, j)
	defer cancel()
	defer srv.Close()

	ctx, c := context.WithTimeout(context.Background(), 3*time.Second)
	defer c()
	opts := &websocket.DialOptions{Subprotocols: []string{
		wsApplicationProtocol,
		wsJWTProtocolPrefix + "invalid-first",
		wsJWTProtocolPrefix + "invalid-second",
	}}
	_, resp, err := websocket.Dial(ctx, wsURL(srv.URL)+"/ws?TP=1&methodtype=GetQuotes&symbol=EURUSD&access_token="+tok, opts)
	if err == nil {
		t.Fatal("expected ambiguous credential protocols to fail closed")
	}
	if resp == nil || resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %v", resp)
	}
}
