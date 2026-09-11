package observability

import (
	"net/http"
	"runtime"
	"runtime/debug"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// Metrics holds the Prometheus collectors and registry.
type Metrics struct {
	reg *prometheus.Registry

	HTTPRequests      *prometheus.CounterVec   // by method, route, status
	HTTPDuration      *prometheus.HistogramVec // by method, route
	WSActive          prometheus.Gauge         // active WebSocket connections
	WSDropped         prometheus.Counter       // dropped WS messages (backpressure)
	MT5Requests       *prometheus.CounterVec   // by result (ok|error|open)
	MT5SessionUp      prometheus.Gauge         // 1 when an MT5 connection is authenticated
	MT5ReauthFailures prometheus.Counter       // failed manager re-authentications
	MT5UpstreamErrors *prometheus.CounterVec   // non-2xx by endpoint path + status
	RateLimitFailOpen prometheus.Counter       // requests allowed because the limiter errored
	BuildInfo         *prometheus.GaugeVec     // immutable module/revision/runtime identity
	TradeSubmissions  *prometheus.CounterVec   // by outcome (accepted|rejected|unknown|not_submitted), replayed
}

// NewMetrics builds and registers the collectors.
func NewMetrics() *Metrics {
	reg := prometheus.NewRegistry()
	reg.MustRegister(collectors.NewGoCollector())
	reg.MustRegister(collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}))

	m := &Metrics{
		reg: reg,
		HTTPRequests: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "http_requests_total", Help: "HTTP requests by method, route, status.",
		}, []string{"method", "route", "status"}),
		HTTPDuration: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name: "http_request_duration_seconds", Help: "HTTP request duration.",
			Buckets: prometheus.DefBuckets,
		}, []string{"method", "route"}),
		WSActive: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "ws_active_connections", Help: "Active WebSocket connections.",
		}),
		WSDropped: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "ws_messages_dropped_total", Help: "WebSocket messages dropped due to backpressure.",
		}),
		MT5Requests: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "mt5_requests_total", Help: "MT5 upstream requests by result.",
		}, []string{"result"}),
		// The manager session has been rejected by the broker (403) for hours at
		// a time, and nothing exported that state: /readyz knew, but readiness is
		// deliberately excluded from the watchdog to avoid restart storms, so a
		// multi-hour outage was only discoverable by reading the log. These two
		// make it alertable.
		MT5SessionUp: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "mt5_session_up",
			Help: "1 when at least one MT5 manager connection is authenticated, 0 otherwise. Alert on 0 for more than a few minutes: the gateway cannot reach the broker.",
		}),
		MT5ReauthFailures: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "mt5_reauth_failures_total",
			Help: "Failed MT5 manager re-authentications. A steady climb means the broker is refusing the session (e.g. 403), not that the network is flapping.",
		}),
		// mt5_requests_total carries only a coarse result, which made an
		// elevated 403 rate measurable but not attributable — finding the
		// culprit endpoint meant grepping the log. That attribution is what
		// decides whether an endpoint's 403 means "your session is gone" or
		// "you may not do this" (see mt5.sessionNeutralPath).
		//
		// `endpoint` is the request PATH only. Query strings carry symbols,
		// logins and ticket ids; as a label they would be unbounded cardinality.
		MT5UpstreamErrors: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "mt5_upstream_errors_total",
			Help: "Non-2xx answers from the trade server by endpoint path and status. Use it to attribute a 401/403 to the call that provoked it.",
		}, []string{"endpoint", "status"}),
		RateLimitFailOpen: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "rate_limit_fail_open_total",
			Help: "Requests allowed without a rate-limit decision because the limiter errored (e.g. Redis down). Alert on increase: rate protection is off.",
		}),
		BuildInfo: prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Name: "gateway_build_info",
			Help: "Immutable gateway build identity. The value is always 1.",
		}, []string{"module_version", "revision", "modified", "go_version"}),
		TradeSubmissions: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "trade_submissions_total",
			Help: "Trade submissions by dealer outcome. `unknown` needs reconciliation; alert on its rate — every one is a trader told to go check Positions.",
		}, []string{"outcome", "replayed"}),
	}
	reg.MustRegister(m.HTTPRequests, m.HTTPDuration, m.WSActive, m.WSDropped, m.MT5Requests,
		m.MT5SessionUp, m.MT5ReauthFailures, m.MT5UpstreamErrors, m.RateLimitFailOpen, m.BuildInfo,
		m.TradeSubmissions)
	version, revision, modified := readBuildIdentity()
	m.BuildInfo.WithLabelValues(version, revision, modified, runtime.Version()).Set(1)
	return m
}

// BuildRevision reports the VCS revision this binary was built from, for
// surfaces (the environment block, logs) that identify a deployment.
func BuildRevision() string {
	_, revision, _ := readBuildIdentity()
	return revision
}

func readBuildIdentity() (version, revision, modified string) {
	version, revision, modified = "unknown", "unknown", "unknown"
	info, ok := debug.ReadBuildInfo()
	if !ok {
		return version, revision, modified
	}
	if info.Main.Version != "" {
		version = info.Main.Version
	}
	for _, setting := range info.Settings {
		switch setting.Key {
		case "vcs.revision":
			if setting.Value != "" {
				revision = setting.Value
			}
		case "vcs.modified":
			if setting.Value != "" {
				modified = setting.Value
			}
		}
	}
	return version, revision, modified
}

// Handler serves the Prometheus exposition endpoint.
func (m *Metrics) Handler() http.Handler {
	return promhttp.HandlerFor(m.reg, promhttp.HandlerOpts{})
}
