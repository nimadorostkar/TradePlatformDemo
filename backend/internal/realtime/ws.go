package realtime

import (
	"context"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/coder/websocket"

	"github.com/nimadorostkar/TradePlatformDemo/backend/internal/auth"
)

// Validator validates a client JWT (satisfied by *auth.JWT).
type Validator interface {
	Validate(token string) (*auth.Claims, error)
}

// HandlerConfig configures the /ws endpoint.
type HandlerConfig struct {
	RequireAuth     bool
	AllowQueryToken bool
	WriteTimeout    time.Duration
	MaxMessageSize  int64
	AllowedOrigins  []string
	// OnConnect/OnDisconnect are optional metric hooks for the active-connection
	// gauge.
	OnConnect    func()
	OnDisconnect func()
}

const (
	wsApplicationProtocol = "tradeplatform.v1"
	wsJWTProtocolPrefix   = "tradeplatform.jwt."
)

// Handler is the /ws HTTP handler.
type Handler struct {
	hub       *Hub
	validator Validator
	cfg       HandlerConfig
	allowAll  bool
	appCtx    context.Context
	log       *slog.Logger
}

// NewHandler constructs the /ws handler. appCtx is the application context;
// when it is cancelled (graceful shutdown) open connections unwind.
func NewHandler(appCtx context.Context, hub *Hub, validator Validator, cfg HandlerConfig, log *slog.Logger) *Handler {
	allowAll := false
	for _, o := range cfg.AllowedOrigins {
		if strings.TrimSpace(o) == "*" {
			allowAll = true
		}
	}
	if cfg.WriteTimeout <= 0 {
		cfg.WriteTimeout = 10 * time.Second
	}
	if cfg.MaxMessageSize <= 0 {
		cfg.MaxMessageSize = 16384
	}
	return &Handler{hub: hub, validator: validator, cfg: cfg, allowAll: allowAll, appCtx: appCtx, log: log}
}

// ServeHTTP upgrades the connection and streams the subscribed data. JWT is
// required before Accept when RequireAuth is on (hardened default); the legacy
// behavior (anonymous /ws) is RequireAuth=false.
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if h.cfg.RequireAuth {
		claims, ok := h.authenticate(r)
		if !ok {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		// Account ownership (mirrors the REST AccountsAuthorize middleware): a
		// token for account A must not stream account B's positions/orders/user
		// data. Tokens without an accounts claim own no accounts.
		if login := r.URL.Query().Get("login"); login != "" && !claims.HasAccount(login) {
			http.Error(w, "Forbidden: Unauthorized account access.", http.StatusForbidden)
			return
		}
	}

	opts := &websocket.AcceptOptions{Subprotocols: []string{wsApplicationProtocol}}
	if h.allowAll {
		opts.InsecureSkipVerify = true
	} else {
		opts.OriginPatterns = h.cfg.AllowedOrigins
	}

	c, err := websocket.Accept(w, r, opts)
	if err != nil {
		// Accept writes its own response (e.g. 400 for a non-WebSocket request).
		return
	}
	defer c.CloseNow()
	c.SetReadLimit(h.cfg.MaxMessageSize)

	if h.cfg.OnConnect != nil {
		h.cfg.OnConnect()
	}
	if h.cfg.OnDisconnect != nil {
		defer h.cfg.OnDisconnect()
	}

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	// Unwind this connection on app shutdown too (hijacked conns aren't tracked
	// by http.Server.Shutdown).
	go func() {
		select {
		case <-h.appCtx.Done():
			cancel()
		case <-ctx.Done():
		}
	}()

	p := ParseParams(r)
	sub, release := h.hub.subscribe(p)
	defer release()

	// Reader: detect client close / control frames.
	go func() {
		for {
			if _, _, err := c.Read(ctx); err != nil {
				cancel()
				return
			}
		}
	}()

	// Writer: drain the subscriber queue with a per-write timeout (backpressure).
	for {
		select {
		case <-ctx.Done():
			return
		case msg, ok := <-sub.ch:
			if !ok {
				return
			}
			writeCtx, wcancel := context.WithTimeout(ctx, h.cfg.WriteTimeout)
			err := c.Write(writeCtx, websocket.MessageText, msg)
			wcancel()
			if err != nil {
				return
			}
		}
	}
}

// authenticate checks the JWT from the Authorization header, the browser-safe
// WebSocket subprotocol transport, or (when explicitly enabled for migration)
// an access_token query parameter. The server negotiates only tradeplatform.v1 and
// never echoes the credential-bearing protocol.
func (h *Handler) authenticate(r *http.Request) (*auth.Claims, bool) {
	if h.validator == nil {
		return nil, false
	}
	token := bearerToken(r)
	if token == "" {
		var protocolPresent bool
		token, protocolPresent = websocketProtocolToken(r)
		if protocolPresent && token == "" {
			return nil, false
		}
	}
	if token == "" && h.cfg.AllowQueryToken {
		token = r.URL.Query().Get("access_token")
	}
	if token == "" {
		return nil, false
	}
	claims, err := h.validator.Validate(token)
	if err != nil {
		return nil, false
	}
	return claims, true
}

// websocketProtocolToken reads a single credential protocol of the form
// tradeplatform.jwt.<JWT>. JWT compact serialization uses only RFC token-safe
// characters, so it is valid in Sec-WebSocket-Protocol. Ambiguous duplicate
// credentials fail closed.
func websocketProtocolToken(r *http.Request) (token string, present bool) {
	for _, line := range r.Header.Values("Sec-WebSocket-Protocol") {
		for _, protocol := range strings.Split(line, ",") {
			protocol = strings.TrimSpace(protocol)
			if !strings.HasPrefix(protocol, wsJWTProtocolPrefix) {
				continue
			}
			present = true
			candidate := strings.TrimPrefix(protocol, wsJWTProtocolPrefix)
			if candidate == "" || token != "" {
				return "", true
			}
			token = candidate
		}
	}
	return token, present
}

func bearerToken(r *http.Request) string {
	h := r.Header.Get("Authorization")
	const prefix = "Bearer "
	if len(h) > len(prefix) && strings.EqualFold(h[:len(prefix)], prefix) {
		return strings.TrimSpace(h[len(prefix):])
	}
	return ""
}
