// Package handlers binds HTTP requests to the domain services, reproducing the
// .NET controllers' routes, parameter binding, and status-code conventions
// (success→200 / failure→400; auth→200/401; test→200/500). See ANALYSIS §3.
package handlers

import (
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/nimadorostkar/TradePlatformDemo/backend/internal/auth"
	"github.com/nimadorostkar/TradePlatformDemo/backend/internal/domain"
)

// Deps holds the services and config the handlers need.
type Deps struct {
	Order    *domain.OrderService
	Position *domain.PositionService
	Deal     *domain.DealService
	History  *domain.HistoryService
	Symbol   *domain.SymbolService
	Tick     *domain.TickService
	Trade    *domain.TradeService
	User     *domain.UserService
	Login    *domain.LoginService

	// Alert, Workspace, and Content back the features that need server-side
	// state or an external provider. Each may be nil-backed; the endpoints then
	// report the feature as unavailable with the reason, rather than returning
	// an empty result that a client cannot distinguish from "nothing to show".
	Alert     *domain.AlertService
	Workspace *domain.WorkspaceService
	Content   *domain.ContentService
	// Leverage writes to the MT5 user record, so it stays disabled unless the
	// deployment states which values a trader may pick (LEVERAGE_CHOICES).
	Leverage *domain.LeverageService

	JWT       *auth.JWT
	JWTSecret string

	// SessionTTL is the lifetime of the session cookies set at login — the
	// RESTORE window (cfg.JWT.RestoreTTL), deliberately longer than the JWT
	// they carry: GET /session re-mints an expired JWT from the cookie-held
	// CRM token, so short bearer lifetimes do not shorten the window in which
	// a returning browser skips the password.
	SessionTTL time.Duration

	// Environment is the trusted runtime metadata served by /api/Capabilities.
	Environment EnvironmentInfo

	// OnTradeOutcome records a trade submission's dealer outcome (metrics).
	// Optional; nil means no metric is recorded.
	OnTradeOutcome func(outcome string, replayed bool)

	// LoginGuard wraps the anonymous credential routes with failed-attempt
	// throttling (HGH-02). Optional; nil mounts them unguarded.
	LoginGuard func(http.Handler) http.Handler
}

// API is the handler set.
type API struct{ d Deps }

// New constructs the handler set.
func New(d Deps) *API { return &API{d: d} }

// ── request helpers ──────────────────────────────────────────────────────────

func qstr(r *http.Request, key string) string { return r.URL.Query().Get(key) }

func qstrDef(r *http.Request, key, def string) string {
	if v := r.URL.Query().Get(key); v != "" {
		return v
	}
	return def
}

func qsource(r *http.Request) string { return qstrDef(r, "source", domain.SourceMT5) }

func qint(r *http.Request, key string) int {
	n, _ := strconv.Atoi(r.URL.Query().Get(key))
	return n
}

func qint64(r *http.Request, key string) int64 {
	n, _ := strconv.ParseInt(r.URL.Query().Get(key), 10, 64)
	return n
}

func quint64(r *http.Request, key string) uint64 {
	n, _ := strconv.ParseUint(r.URL.Query().Get(key), 10, 64)
	return n
}

func bodyBytes(r *http.Request) []byte {
	if r.Body == nil {
		return nil
	}
	b, _ := io.ReadAll(io.LimitReader(r.Body, 4<<20))
	_ = r.Body.Close()
	return b
}
