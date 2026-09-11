// Package httpapi builds the HTTP surface: middleware chain, health endpoints,
// and (in later stages) the full REST + WebSocket routes that mirror the .NET
// service exactly (see docs/ANALYSIS.md §3).
package httpapi

import (
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/nimadorostkar/TradePlatformDemo/backend/internal/auth"
	"github.com/nimadorostkar/TradePlatformDemo/backend/internal/mt5"
)

// Middleware is a standard net/http middleware constructor.
type Middleware = func(http.Handler) http.Handler

// healthHandlers is the slice of health endpoints the router mounts.
type healthHandlers interface {
	LivenessHandler() http.HandlerFunc
	ReadinessHandler() http.HandlerFunc
}

// Deps carries the dependencies the router needs. It grows as stages land.
type Deps struct {
	Log           *slog.Logger
	Health        healthHandlers
	Recoverer     Middleware
	RequestLogger Middleware
	CORS          Middleware
	Metrics       Middleware
	RateLimit     Middleware
	BodyLimit     Middleware

	// MetricsHandler serves /metrics (Prometheus). Optional.
	MetricsHandler http.Handler

	// Reserved for the REST/WS stages (constructed now, applied when handlers land).
	JWT *auth.JWT
	CRM *auth.CRMClient
	MT5 *mt5.Manager

	// MountAPI, when set, registers the REST handlers under /api. When nil the
	// /api placeholder (501) is served instead.
	MountAPI func(api chi.Router)

	// WS, when set, handles the /ws streaming endpoint. When nil the /ws
	// placeholder (501) is served instead.
	WS http.Handler
}

// NewRouter assembles the chi router. Stages add route groups here; the core
// stage mounts health, CORS, the root→/swagger redirect, and the
// not-yet-implemented /api and /ws placeholders.
func NewRouter(d Deps) http.Handler {
	r := chi.NewRouter()

	r.Use(d.Recoverer)
	r.Use(d.RequestLogger)
	if d.Metrics != nil {
		r.Use(d.Metrics)
	}
	if d.CORS != nil {
		r.Use(d.CORS)
	}
	if d.RateLimit != nil {
		r.Use(d.RateLimit)
	}
	if d.BodyLimit != nil {
		r.Use(d.BodyLimit)
	}

	// Operational endpoints (additive — no collision with the .NET surface).
	r.Get("/healthz", d.Health.LivenessHandler())
	r.Get("/readyz", d.Health.ReadinessHandler())
	if d.MetricsHandler != nil {
		r.Handle("/metrics", d.MetricsHandler)
	}

	// Browser-friendly landing + API console (anonymous).
	r.Get("/", landingHandler)
	r.Get("/swagger", swaggerHandler)
	r.Get("/openapi.json", openapiHandler)

	// REST surface. When handlers are wired, mount them; otherwise serve the
	// scaffold placeholder.
	if d.MountAPI != nil {
		r.Route("/api", d.MountAPI)
	} else {
		r.Route("/api", func(api chi.Router) {
			api.HandleFunc("/*", notImplemented)
		})
	}

	// Realtime endpoint.
	if d.WS != nil {
		r.Handle("/ws", d.WS)
	} else {
		r.HandleFunc("/ws", notImplemented)
	}

	return r
}

func notImplemented(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusNotImplemented)
	_, _ = w.Write([]byte(`{"data":null,"errorMessage":"not implemented yet (scaffold stage)","message":null,"success":false}`))
}
