// Package config loads strongly-typed configuration from the environment.
//
// Every tunable in the system — timeouts, pool sizes, realtime cadence, and the
// security-hardening toggles — lives here with a safe default, so behavior can be
// adjusted per-deployment without code changes. Secrets are read from the
// environment (or an injected secret store) and are never logged (see Redacted).
package config

import (
	"fmt"
	"strings"
	"time"

	"github.com/caarlos0/env/v11"
)

// Config is the root configuration tree. Sub-structs map to env-var groups.
type Config struct {
	Server        Server
	Roles         Roles
	MT5           MT5
	CRM           CRM
	JWT           JWT
	Security      Security
	DB            DB
	Redis         Redis
	NATS          NATS
	WS            WS
	RateLimit     RateLimit
	Trade         Trade
	Alerts        Alerts
	Content       Content
	Observability Observability
}

// RateLimit configures the per-IP request limiter. RPS<=0 disables it.
type RateLimit struct {
	RPS   float64 `env:"RATE_LIMIT_RPS" envDefault:"0"`
	Burst int     `env:"RATE_LIMIT_BURST" envDefault:"20"`
	// TrustedProxies lists CIDRs (or bare IPs) of reverse proxies whose
	// X-Forwarded-For is honored when keying the per-IP limit. Empty (default)
	// trusts no proxy: requests are keyed by the TCP peer address, so a client
	// cannot spoof XFF to bypass its limit. Set this when running behind an
	// ingress/LB (e.g. "10.0.0.0/8,172.16.0.0/12").
	TrustedProxies []string `env:"RATE_LIMIT_TRUSTED_PROXIES" envSeparator:"," envDefault:""`

	// Login throttling (HGH-02): after LoginThreshold consecutive FAILED
	// sign-in attempts from one client, further attempts are refused for
	// LoginBaseLockout, doubling per additional failure up to LoginMaxLockout.
	// A successful sign-in clears the count. Unlike RPS above this is ON by
	// default: it keys on outcomes, not volume, so legitimate traffic never
	// notices it. LoginThreshold<=0 disables.
	LoginThreshold   int           `env:"LOGIN_THROTTLE_THRESHOLD" envDefault:"5"`
	LoginBaseLockout time.Duration `env:"LOGIN_THROTTLE_BASE_LOCKOUT" envDefault:"30s"`
	LoginMaxLockout  time.Duration `env:"LOGIN_THROTTLE_MAX_LOCKOUT" envDefault:"15m"`
}

// Server holds HTTP listener and lifecycle settings.
type Server struct {
	// HTTPAddr is the public API/WS listen address. Default mirrors the .NET
	// production port (ASPNETCORE_URLS=http://0.0.0.0:5063).
	HTTPAddr          string        `env:"HTTP_ADDR" envDefault:":5063"`
	ReadHeaderTimeout time.Duration `env:"HTTP_READ_HEADER_TIMEOUT" envDefault:"5s"`
	ReadTimeout       time.Duration `env:"HTTP_READ_TIMEOUT" envDefault:"15s"`
	WriteTimeout      time.Duration `env:"HTTP_WRITE_TIMEOUT" envDefault:"30s"`
	IdleTimeout       time.Duration `env:"HTTP_IDLE_TIMEOUT" envDefault:"120s"`
	ShutdownTimeout   time.Duration `env:"HTTP_SHUTDOWN_TIMEOUT" envDefault:"20s"`
	MaxBodyBytes      int64         `env:"HTTP_MAX_BODY_BYTES" envDefault:"4194304"`
}

// Roles selects which logical components this process runs. The same binary can
// run everything (single-node) or a single role (horizontal scale) with no code
// change. Empty/"all" runs every role.
type Roles struct {
	Enabled []string `env:"ROLES" envSeparator:"," envDefault:"all"`
}

// MT5 configures the upstream MetaTrader 5 Manager Web API connection and the
// authenticated session pool. See docs/ANALYSIS.md §7.
type MT5 struct {
	// HostURL has no default on purpose: a compiled-in broker host means a
	// gateway deployed on a new server silently talks to someone else's
	// production MT5 instead of failing. Required by Validate.
	HostURL               string        `env:"MT5_HOST_URL"`
	Port                  int           `env:"MT5_PORT" envDefault:"443"`
	Login                 uint64        `env:"MT5_LOGIN"`
	Password              string        `env:"MT5_PASSWORD"`
	Version               string        `env:"MT5_VERSION" envDefault:"4410"`
	Agent                 string        `env:"MT5_AGENT" envDefault:"WebManager"`
	Type                  string        `env:"MT5_TYPE" envDefault:"Manager"`
	SymbolDefaultCount    int           `env:"MT5_SYMBOL_DEFAULT_COUNT" envDefault:"10"`
	DefaultSymbolList     []string      `env:"MT5_DEFAULT_SYMBOL_LIST" envSeparator:"," envDefault:"EURUSD,USDJPY,XAUUSD,GBPUSD,AUDUSD,USDCAD,USDCHF,DJIUSD,SPXUSD,NDXUSD,DAXEUR,FTSGBP,NZDUSD,EURJPY,EURGBP,EURCHF,GBPJPY,GBPCHF,AUDJPY,AUDCAD"`
	ReadDataFromDB        bool          `env:"MT5_READ_DATA_FROM_DB" envDefault:"false"`
	DefaultChartData      string        `env:"MT5_DEFAULT_CHART_DATA" envDefault:"dhloc"`
	DefaultResolution     string        `env:"MT5_DEFAULT_RESOLUTION" envDefault:"1D"`
	PoolSize              int           `env:"MT5_POOL_SIZE" envDefault:"1"` // N=1 = exact parity with the single pinned socket
	PingInterval          time.Duration `env:"MT5_PING_INTERVAL" envDefault:"20s"`
	MaxConsecutiveFailure int           `env:"MT5_MAX_CONSECUTIVE_FAILURES" envDefault:"3"`
	RequestTimeout        time.Duration `env:"MT5_REQUEST_TIMEOUT" envDefault:"30s"`
	DialTimeout           time.Duration `env:"MT5_DIAL_TIMEOUT" envDefault:"5s"`
	MaxResponseBytes      int64         `env:"MT5_MAX_RESPONSE_BYTES" envDefault:"33554432"`
}

// BaseURL returns the upstream prefix ("host:port") all paths are appended to.
func (m MT5) BaseURL() string { return fmt.Sprintf("%s:%d", m.HostURL, m.Port) }

// CRM configures the TradePlatform CRM used for client login / account discovery.
//
// AllowedAccountTypes and AccountTypeSuffixes together are the account-type
// policy: an account type may only trade through this terminal when its symbol
// suffix is known, because a wrong suffix sends a wrong symbol name to MT5.
// Types 11 and 26 are admitted by the CRM but have no confirmed suffix, so they
// are absent from the default allowlist; add them here (with their suffix) once
// it is confirmed — no code change needed.
type CRM struct {
	// URL has no default, for the same reason as MT5_HOST_URL: the CRM that
	// authenticates traders is per-deployment. Required by Validate.
	URL string `env:"CRM_URL"`
	// AllowedAccountTypes are the CRM typeIds admitted to the account selector.
	AllowedAccountTypes []int `env:"CRM_ALLOWED_ACCOUNT_TYPES" envSeparator:"," envDefault:"57,58,59,60,61,62,63,64,65,66,67"`
	// AccountTypeSuffixes maps typeId → symbol suffix, e.g.
	// "57:.,58:!,59:#,60:" ("." ECN, "!" Standard, "#" Social, empty ECNPRO).
	// A type absent from this map reports suffixKnown=false to the client.
	AccountTypeSuffixes map[int]string `env:"CRM_ACCOUNT_TYPE_SUFFIXES" envSeparator:"," envKeyValSeparator:":"`

	// Which CRM account types hold DEMO funds and which hold REAL money, so the
	// terminal can badge each account for what it is.
	//
	// Both lists are empty by default and a type in NEITHER is reported as
	// unknown, which the client renders as no badge at all. That is deliberate:
	// the terminal used to badge every account "LIVE" from a single
	// deployment-wide variable, and a demo account labelled LIVE — or a real one
	// labelled DEMO — is a misrepresentation on the screen where orders are
	// placed. Silence is the only safe thing to say about an account nobody has
	// classified.
	//
	// It is stated here rather than derived because it cannot be derived:
	// /api/group/get returns IDENTICAL configuration for this broker's
	// demo-signature groups and its live ones (verified 2026-08-26 — same
	// PermissionsFlags, same Company, same symbols, same swaps; only the group
	// NAME differs), and an MT5 user's Rights carry no demo bit. Matching the
	// name is what must not happen: "-SF-" is a convention whose meaning lives
	// in the broker's product catalogue, it reads equally as "swap-free", and it
	// would mislabel silently the day a group is renamed.
	DemoAccountTypes []int `env:"CRM_DEMO_ACCOUNT_TYPES" envSeparator:","`
	LiveAccountTypes []int `env:"CRM_LIVE_ACCOUNT_TYPES" envSeparator:","`

	// MT5 groups whose funds are SIMULATED, by EXACT full name.
	//
	// This is the key that works for this broker: its CRM account types cannot
	// express demo vs live, because "ECN Pro" contains both
	// Opoforex\ECNPRO-USD-B (real) and Opoforex\ECNPRO-SF-USD-B (simulated).
	// Classifying by type would badge five real accounts as demo.
	//
	// Exact names, never a substring rule: a renamed or new group drops out of
	// the list and shows NO badge, which somebody notices and asks about. A
	// pattern keeps matching whatever it hits and mislabels in silence.
	//
	// Setting this makes the gateway read each account's group (cached 30
	// minutes); leaving it empty costs nothing at all.
	DemoMT5Groups []string `env:"CRM_DEMO_MT5_GROUPS" envSeparator:","`
}

// JWT configures the gateway's own client tokens. Matches the .NET signing
// (HS256, ASCII key bytes). Issuer/Audience validation defaults ON (hardened);
// set the Validate* flags false to reproduce the legacy unvalidated behavior.
type JWT struct {
	SecretKey string `env:"JWT_SECRET_KEY"`
	// Issuer and Audience carry no default: they are part of the token contract
	// this deployment shares with its clients, and a compiled-in value would
	// mint tokens claiming to come from another firm. Required by Validate
	// whenever the matching Validate* flag is on.
	Issuer           string `env:"JWT_ISSUER"`
	Audience         string `env:"JWT_AUDIENCE"`
	ValidateIssuer   bool   `env:"JWT_VALIDATE_ISSUER" envDefault:"true"`
	ValidateAudience bool   `env:"JWT_VALIDATE_AUDIENCE" envDefault:"true"`
	// Expiry is the bearer-token lifetime. Deliberately short: this JWT
	// authorizes live trading and has no server-side revocation, so its
	// lifetime IS the blast radius of a stolen token. Validate rejects
	// anything over an hour. Long-running sessions come from renewal (the
	// client re-exchanges its CRM token before expiry) and from the cookie
	// restore window below — not from a long-lived bearer token.
	Expiry time.Duration `env:"JWT_EXPIRY" envDefault:"30m"`
	// RestoreTTL is how long the HttpOnly session cookies survive — the
	// window in which a returning browser can restore its session without
	// re-entering a password. GET /session re-mints a fresh JWT from the
	// cookie-held CRM token when the stored one has expired, so this window
	// is decoupled from (and much longer than) the bearer lifetime.
	RestoreTTL time.Duration `env:"SESSION_RESTORE_TTL" envDefault:"720h"`
}

// Security holds the hardened-default toggles. Defaults are the secure choice;
// flipping them to the legacy value restores byte-for-byte old behavior for
// clients that depend on it (see docs/ARCHITECTURE.md §9 #6).
type Security struct {
	// WSRequireAuth requires a valid JWT before accepting a /ws connection.
	// Legacy behavior (unauthenticated /ws) = false.
	WSRequireAuth bool `env:"WS_REQUIRE_AUTH" envDefault:"true"`
	// WSAllowQueryToken temporarily accepts access_token in a WebSocket URL for
	// legacy clients. Prefer the tradeplatform.jwt.<JWT> subprotocol and disable this
	// after clients migrate because URL query strings are commonly logged.
	WSAllowQueryToken bool `env:"WS_ALLOW_QUERY_TOKEN" envDefault:"false"`
	// CORSAllowedOrigins is the allowlist. Empty default = fail closed (no
	// cross-origin allowed until configured). Set to "*" for the legacy
	// any-origin behavior.
	CORSAllowedOrigins []string `env:"CORS_ALLOWED_ORIGINS" envSeparator:"," envDefault:""`
	// ManagerAPIKey is a second credential for legacy MT5 Manager maintenance
	// routes whose ticket-only contracts cannot enforce retail ownership. Empty
	// disables those routes (404). This key must never be sent to a browser.
	ManagerAPIKey string `env:"MANAGER_API_KEY" envDefault:""`
}

// DB configures PostgreSQL (trading_ops/audit) and TimescaleDB (OHLC). A single
// DSN may serve both in small deployments. Defaults are intentionally empty —
// no credentials are compiled into the binary; an unset TIMESCALE_DSN disables
// the price store (API-only mode) and is logged loudly at startup.
type DB struct {
	PostgresDSN  string `env:"POSTGRES_DSN" envDefault:""`
	TimescaleDSN string `env:"TIMESCALE_DSN" envDefault:""`
	MaxConns     int32  `env:"DB_MAX_CONNS" envDefault:"20"`
}

// AppDataDSN is the connection for the gateway's own tables (price alerts,
// workspaces). It prefers POSTGRES_DSN and falls back to TIMESCALE_DSN, since a
// small deployment usually runs both on one server. Empty leaves alerts and
// workspace persistence switched off, and those endpoints say so.
func (d DB) AppDataDSN() string {
	if d.PostgresDSN != "" {
		return d.PostgresDSN
	}
	return d.TimescaleDSN
}

// Redis configures the shared-state cluster (WS sessions, tick cache, JWT
// revocation, distributed rate-limit and locks).
type Redis struct {
	Addrs    []string `env:"REDIS_ADDRS" envSeparator:"," envDefault:""`
	Password string   `env:"REDIS_PASSWORD"`
}

// NATS configures the realtime fan-out bus. Empty URL falls back to the in-proc
// bus (single-node mode).
type NATS struct {
	URL string `env:"NATS_URL" envDefault:""`
}

// WS configures the realtime push behavior. PushCadence defaults to 3s to match
// the .NET service's fixed polling cadence.
type WS struct {
	PushCadence    time.Duration `env:"WS_PUSH_CADENCE" envDefault:"3s"`
	MaxMessageSize int64         `env:"WS_MAX_MESSAGE_SIZE" envDefault:"16384"`
	WriteTimeout   time.Duration `env:"WS_WRITE_TIMEOUT" envDefault:"10s"`
	SendBuffer     int           `env:"WS_SEND_BUFFER" envDefault:"32"`
}

// Trade configures trade submission behavior.
type Trade struct {
	// IdempotencyTTL is how long a submission carrying an Idempotency-Key (or
	// clientRequestId) is replayable. Long enough to cover a client retrying a
	// timed-out request; short enough that a key reused much later for a
	// different order is not answered from cache.
	IdempotencyTTL time.Duration `env:"TRADE_IDEMPOTENCY_TTL" envDefault:"10m"`
	// BookSideConvention selects how the upstream market-depth side codes are
	// numbered: "mql5" (SELL=1,BUY=2,…) or "manager" (SELL=0,BUY=1,…). A wrong
	// value shows up as `crossed:true` on every two-sided book.
	BookSideConvention string `env:"MT5_BOOK_SIDE_CONVENTION" envDefault:"mql5"`
	// BookSubscribe makes market-depth reads subscribe to a symbol's book
	// before requesting it. MT5 pushes depth to subscribers only, so without
	// this every book comes back empty. Turn it off only for a trade server
	// that has no subscribe command and logs noisily because of it.
	BookSubscribe bool `env:"MT5_BOOK_SUBSCRIBE" envDefault:"true"`
}

// Alerts configures the server-side price-alert evaluator.
type Alerts struct {
	// Enabled turns the evaluator on. Alerts are stored and served whenever a
	// store is configured; this only controls whether this process evaluates.
	Enabled bool `env:"ALERTS_ENABLED" envDefault:"true"`
	// EvalInterval is how often active alerts are checked against quotes.
	EvalInterval time.Duration `env:"ALERTS_EVAL_INTERVAL" envDefault:"3s"`
}

// Content configures the news and economic-calendar proxies. Both are pure
// pass-throughs to whichever provider the firm licenses; an unset URL leaves
// the feature off and the endpoint says so.
type Content struct {
	NewsURL          string `env:"NEWS_PROVIDER_URL" envDefault:""`
	NewsAPIKey       string `env:"NEWS_PROVIDER_API_KEY" envDefault:""`
	NewsAPIKeyHeader string `env:"NEWS_PROVIDER_API_KEY_HEADER" envDefault:"X-API-Key"`
	CalendarURL      string `env:"CALENDAR_PROVIDER_URL" envDefault:""`
	CalendarAPIKey   string `env:"CALENDAR_PROVIDER_API_KEY" envDefault:""`
	CalendarKeyHdr   string `env:"CALENDAR_PROVIDER_API_KEY_HEADER" envDefault:"X-API-Key"`

	// LeverageChoices are the leverage values a trader may select, e.g.
	// "25,50,100,200,500". EMPTY DISABLES THE FEATURE, and that is the default.
	//
	// Leverage is a broker-controlled property of the MT5 user record, not a
	// per-symbol setting and not something MT5 will enumerate for us — so the
	// permitted values can only come from the broker, and until they do, the
	// terminal must not offer a control that writes to a live account. Set
	// this only once TradePlatform confirms traders may change their own.
	LeverageChoices string        `env:"LEVERAGE_CHOICES" envDefault:""`
	CacheTTL        time.Duration `env:"CONTENT_CACHE_TTL" envDefault:"60s"`
	Timeout         time.Duration `env:"CONTENT_TIMEOUT" envDefault:"10s"`
}

// Observability configures logging, metrics, and tracing.
type Observability struct {
	LogLevel     string `env:"LOG_LEVEL" envDefault:"info"`
	LogFormat    string `env:"LOG_FORMAT" envDefault:"json"` // json|text
	LogFile      string `env:"LOG_FILE" envDefault:""`       // empty=stdout; else rotating file
	LogMaxSize   int    `env:"LOG_MAX_SIZE_MB" envDefault:"50"`
	LogMaxBackup int    `env:"LOG_MAX_BACKUPS" envDefault:"5"`
	LogMaxAge    int    `env:"LOG_MAX_AGE_DAYS" envDefault:"14"`
	// MetricsAddr is a separate listener so operational telemetry is never
	// exposed through the public API/reverse proxy. Use :9090 explicitly in a
	// pod network; the single-host default is loopback-only.
	MetricsAddr string `env:"METRICS_ADDR" envDefault:"127.0.0.1:9090"`
	OTLPEndoint string `env:"OTLP_ENDPOINT" envDefault:""`
	Environment string `env:"ENVIRONMENT" envDefault:"development"`
	// TradingMode states what money this gateway moves: "live" or "demo". It is
	// surfaced to clients through /api/Capabilities so the terminal can show an
	// honest live-money banner sourced from the backend rather than from a
	// build-time flag (ENV-001). The default is the dangerous case on purpose —
	// a deployment that forgets to set it is warned about real money, never
	// falsely reassured with "demo".
	TradingMode string `env:"TRADING_MODE" envDefault:"live"`
}

// Load parses configuration from the process environment, applying defaults.
func Load() (*Config, error) {
	cfg := &Config{}
	if err := env.Parse(cfg); err != nil {
		return nil, fmt.Errorf("parse config: %w", err)
	}
	return cfg, nil
}

// DevelopmentEnvironment is the one ENVIRONMENT value that downgrades
// configuration errors to warnings, so the service can be started locally
// before secrets exist.
const DevelopmentEnvironment = "development"

// Strict reports whether configuration errors must abort startup.
//
// Everything except an explicit ENVIRONMENT=development is strict. The previous
// rule — fail only when ENVIRONMENT equals "production" — meant that
// "staging", "prod", or an unset value silently started a misconfigured
// gateway, which is precisely where the mistake is least likely to be noticed.
// Degraded startup is now something you opt into by name.
func (c *Config) Strict() bool {
	return !strings.EqualFold(c.Observability.Environment, DevelopmentEnvironment)
}

// Validate checks invariants that must hold before the server starts. The
// caller decides whether a failure is fatal; see Strict.
func (c *Config) Validate() error {
	if c.JWT.SecretKey == "" {
		return fmt.Errorf("JWT_SECRET_KEY is required")
	}
	if c.MT5.HostURL == "" {
		return fmt.Errorf("MT5_HOST_URL is required (no default: it is per-deployment)")
	}
	if c.CRM.URL == "" {
		return fmt.Errorf("CRM_URL is required (no default: it is per-deployment)")
	}
	if c.JWT.ValidateIssuer && c.JWT.Issuer == "" {
		return fmt.Errorf("JWT_ISSUER is required when JWT_VALIDATE_ISSUER=true")
	}
	if c.JWT.ValidateAudience && c.JWT.Audience == "" {
		return fmt.Errorf("JWT_AUDIENCE is required when JWT_VALIDATE_AUDIENCE=true")
	}
	if c.JWT.Expiry <= 0 {
		return fmt.Errorf("JWT_EXPIRY must be > 0")
	}
	if c.JWT.Expiry > time.Hour {
		return fmt.Errorf("JWT_EXPIRY must not exceed 1h: this bearer token authorizes live trading and has no revocation — long sessions come from renewal and SESSION_RESTORE_TTL, not a long-lived token (got %s)", c.JWT.Expiry)
	}
	if c.JWT.RestoreTTL < c.JWT.Expiry {
		return fmt.Errorf("SESSION_RESTORE_TTL (%s) must be at least JWT_EXPIRY (%s): a restore window shorter than one token would sign traders out mid-session", c.JWT.RestoreTTL, c.JWT.Expiry)
	}
	if c.MT5.PoolSize < 1 {
		return fmt.Errorf("MT5_POOL_SIZE must be >= 1")
	}
	if c.Server.ReadHeaderTimeout <= 0 {
		return fmt.Errorf("HTTP_READ_HEADER_TIMEOUT must be > 0")
	}
	if c.Server.MaxBodyBytes <= 0 {
		return fmt.Errorf("HTTP_MAX_BODY_BYTES must be > 0")
	}
	if c.MT5.MaxResponseBytes <= 0 {
		return fmt.Errorf("MT5_MAX_RESPONSE_BYTES must be > 0")
	}
	// Keyed off the role rather than the environment name: a process that runs
	// the mt5 role cannot authenticate its manager session without a password,
	// and a ws/api-only process legitimately has none.
	if c.HasRole("mt5") && c.MT5.Password == "" {
		return fmt.Errorf("MT5_PASSWORD is required to authenticate the MT5 manager session")
	}
	if c.MT5.ReadDataFromDB && c.DB.TimescaleDSN == "" {
		return fmt.Errorf("MT5_READ_DATA_FROM_DB=true requires TIMESCALE_DSN to be set")
	}
	if c.Security.ManagerAPIKey != "" && len(c.Security.ManagerAPIKey) < 32 {
		return fmt.Errorf("MANAGER_API_KEY must be at least 32 characters when enabled")
	}
	return nil
}

// HasRole reports whether the given logical role should run in this process.
func (c *Config) HasRole(role string) bool {
	for _, r := range c.Roles.Enabled {
		if r == "all" || r == role {
			return true
		}
	}
	return false
}
