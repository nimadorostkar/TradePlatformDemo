// Command gateway is the OpoMTSocket-Go entrypoint.
//
// It loads configuration, builds the logger, MT5 session manager, auth, and HTTP
// surface, starts the server, and shuts down gracefully on SIGINT/SIGTERM. The
// REST handlers, WebSocket hub, store, and jobs are wired in later stages
// (see docs/ARCHITECTURE.md §11).
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/nimadorostkar/TradePlatformDemo/backend/internal/auth"
	"github.com/nimadorostkar/TradePlatformDemo/backend/internal/cache"
	"github.com/nimadorostkar/TradePlatformDemo/backend/internal/config"
	"github.com/nimadorostkar/TradePlatformDemo/backend/internal/domain"
	"github.com/nimadorostkar/TradePlatformDemo/backend/internal/httpapi"
	"github.com/nimadorostkar/TradePlatformDemo/backend/internal/httpapi/handlers"
	"github.com/nimadorostkar/TradePlatformDemo/backend/internal/httpapi/middleware"
	"github.com/nimadorostkar/TradePlatformDemo/backend/internal/jobs"
	"github.com/nimadorostkar/TradePlatformDemo/backend/internal/mt5"
	"github.com/nimadorostkar/TradePlatformDemo/backend/internal/observability"
	"github.com/nimadorostkar/TradePlatformDemo/backend/internal/realtime"
	"github.com/nimadorostkar/TradePlatformDemo/backend/internal/store/appdata"
	"github.com/nimadorostkar/TradePlatformDemo/backend/internal/store/timescale"
	"github.com/nimadorostkar/TradePlatformDemo/backend/internal/transform"
)

// apiVersion identifies the REST/WS contract generation served by this binary,
// reported through /api/Capabilities' environment block.
const apiVersion = "2"

func main() {
	if err := run(); err != nil {
		slog.Error("fatal", slog.Any("error", err))
		os.Exit(1)
	}
}

// firstOrEmpty returns the first element of a list, or "" for an empty list.
func firstOrEmpty(list []string) string {
	if len(list) == 0 {
		return ""
	}
	return list[0]
}

func run() error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}

	log := observability.NewLoggerFor(observability.LogConfig{
		Level:      cfg.Observability.LogLevel,
		Format:     cfg.Observability.LogFormat,
		File:       cfg.Observability.LogFile,
		MaxSizeMB:  cfg.Observability.LogMaxSize,
		MaxBackups: cfg.Observability.LogMaxBackup,
		MaxAgeDays: cfg.Observability.LogMaxAge,
	})
	slog.SetDefault(log)
	// Keep stderr empty: some service launchers treat any native stderr write
	// as a fatal error, and Redis is an optional dependency whose retry notices
	// must never be able to take the gateway down.
	cache.SetLogger(log)

	if err := cfg.Validate(); err != nil {
		// Fail closed everywhere except an explicit ENVIRONMENT=development, so
		// a staging or unnamed environment cannot start misconfigured.
		if cfg.Strict() {
			return fmt.Errorf("configuration invalid: %w", err)
		}
		log.Warn("configuration validation failed (continuing: ENVIRONMENT=development)", slog.Any("error", err))
	}

	// Root context cancelled on SIGINT/SIGTERM; drives background workers.
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	log.Info("starting tradeplatform-gateway",
		slog.String("addr", cfg.Server.HTTPAddr),
		slog.String("environment", cfg.Observability.Environment),
		slog.Any("roles", cfg.Roles.Enabled),
	)

	// ── Auth (JWT + CRM) ────────────────────────────────────────────────────
	var jwtAuth *auth.JWT
	if cfg.JWT.SecretKey != "" {
		jwtAuth, err = auth.NewJWT(auth.JWTConfig{
			Secret:           cfg.JWT.SecretKey,
			Issuer:           cfg.JWT.Issuer,
			Audience:         cfg.JWT.Audience,
			Expiry:           cfg.JWT.Expiry,
			ValidateIssuer:   cfg.JWT.ValidateIssuer,
			ValidateAudience: cfg.JWT.ValidateAudience,
		})
		if err != nil {
			return err
		}
	} else {
		log.Warn("JWT_SECRET_KEY not set; auth is disabled until configured")
	}
	// The account policy decides which CRM account types may trade here. Types
	// whose symbol suffix is unknown stay out of the account selector: sending
	// a wrong symbol name to MT5 is worse than an account not appearing.
	crm := auth.NewCRMClientWithPolicy(cfg.CRM.URL,
		auth.NewAccountPolicy(cfg.CRM.AllowedAccountTypes, cfg.CRM.AccountTypeSuffixes).
			WithAccountKinds(cfg.CRM.DemoAccountTypes, cfg.CRM.LiveAccountTypes).
			WithDemoGroups(cfg.CRM.DemoMT5Groups))

	// Built before the manager so the session can report re-auth failures into
	// it: a broker rejection that lasts hours needs to be alertable, not just
	// visible to whoever reads the log.
	metrics := observability.NewMetrics()

	// ── MT5 session manager ─────────────────────────────────────────────────
	manager, err := mt5.NewManager(mt5.Config{
		BaseURL:                cfg.MT5.BaseURL(),
		Login:                  cfg.MT5.Login,
		Password:               cfg.MT5.Password,
		Version:                cfg.MT5.Version,
		Agent:                  cfg.MT5.Agent,
		Type:                   cfg.MT5.Type,
		PoolSize:               cfg.MT5.PoolSize,
		PingInterval:           cfg.MT5.PingInterval,
		MaxConsecutiveFailures: cfg.MT5.MaxConsecutiveFailure,
		RequestTimeout:         cfg.MT5.RequestTimeout,
		DialTimeout:            cfg.MT5.DialTimeout,
		MaxResponseBytes:       cfg.MT5.MaxResponseBytes,
		OnReauthFailure:        func() { metrics.MT5ReauthFailures.Inc() },
		OnUpstreamError: func(endpoint string, status int) {
			metrics.MT5UpstreamErrors.WithLabelValues(endpoint, strconv.Itoa(status)).Inc()
		},
	}, log)
	if err != nil {
		return err
	}

	// Wrap the MT5 manager with a circuit breaker; services and jobs use this
	// client (manager retains lifecycle/readiness).
	mt5Client := mt5.NewCircuitClient(manager, func(result string) {
		metrics.MT5Requests.WithLabelValues(result).Inc()
	})

	health := observability.NewHealth()
	// The REST surface is mounted only when JWT is configured (see below). A
	// process without it answers 501 on every /api route, so readiness must
	// report NOT ready: a probe that passes while the entire API is unmounted
	// has an orchestrator route live traffic to a gateway that cannot serve a
	// single call. Liveness stays true — the process itself is healthy, it is
	// just misconfigured, and restarting it would not help.
	apiMounted := jwtAuth != nil
	if !apiMounted {
		log.Error("REST API cannot be mounted (JWT_SECRET_KEY is unset); readiness will report not_ready")
	}
	mt5Enabled := cfg.HasRole("mt5") && cfg.MT5.Password != ""
	if mt5Enabled {
		if err := manager.Start(ctx); err != nil {
			log.Error("mt5 manager start failed", slog.Any("error", err))
		}
		defer manager.Stop()
		health.SetReady(apiMounted && manager.Ready())
		setSessionUp(metrics, manager.Ready())
		go watchReadiness(ctx, health, manager, metrics, apiMounted, log)
	} else {
		// No MT5 egress in this process (or no creds): readiness depends only
		// on whether this process can actually serve its API.
		log.Info("mt5 session not started in this process",
			slog.Bool("role_enabled", cfg.HasRole("mt5")),
			slog.Bool("password_set", cfg.MT5.Password != ""))
		health.SetReady(apiMounted)
	}

	// ── Price store (PostgreSQL/TimescaleDB) — best-effort ──────────────────
	var priceStore domain.PriceStore
	var locker jobs.Locker
	if cfg.DB.TimescaleDSN == "" {
		log.Warn("TIMESCALE_DSN not set; price store and history jobs disabled (API-only mode)")
	} else {
		connCtx, cancelC := context.WithTimeout(ctx, 5*time.Second)
		st, err := timescale.New(connCtx, cfg.DB.TimescaleDSN, cfg.DB.MaxConns)
		cancelC()
		if err != nil {
			log.Warn("timescale unavailable; running API-only (no DB-backed history)", slog.Any("error", err))
		} else {
			if err := st.Migrate(ctx); err != nil {
				log.Warn("timescale migrate failed", slog.Any("error", err))
			}
			priceStore = st
			locker = st
			defer st.Close()
			log.Info("timescale connected")
		}
	}

	// ── App-data store (price alerts, workspaces) — best-effort ─────────────
	// Separate from the price store: small per-trader rows, and it can point at
	// an ordinary Postgres. Without it, alerts and workspace persistence report
	// themselves unavailable rather than accepting data they cannot keep.
	var alertStore domain.AlertStore
	var workspaceStore domain.WorkspaceStore
	var appLocker jobs.Locker
	if dsn := cfg.DB.AppDataDSN(); dsn == "" {
		log.Warn("no POSTGRES_DSN/TIMESCALE_DSN; price alerts and workspace persistence disabled")
	} else {
		connCtx, cancelA := context.WithTimeout(ctx, 5*time.Second)
		ast, err := appdata.New(connCtx, dsn, cfg.DB.MaxConns)
		cancelA()
		if err != nil {
			log.Warn("app-data store unavailable; alerts and workspaces disabled", slog.Any("error", err))
		} else if err := ast.Migrate(ctx); err != nil {
			log.Warn("app-data migrate failed; alerts and workspaces disabled", slog.Any("error", err))
			ast.Close()
		} else {
			alertStore = ast
			workspaceStore = ast
			appLocker = ast
			defer ast.Close()
			log.Info("app-data store connected")
		}
	}

	// ── Idempotency store for trade submission ──────────────────────────────
	// Redis makes the no-double-submit guarantee hold across replicas; the
	// in-process store still absorbs the common case of a client retrying
	// against the same pod.
	var idemStore domain.IdempotencyStore = domain.NewMemoryIdempotencyStore()
	if len(cfg.Redis.Addrs) > 0 && cfg.Redis.Addrs[0] != "" {
		rc := cache.NewRedis(cfg.Redis.Addrs, cfg.Redis.Password)
		pingCtx, cancelI := context.WithTimeout(ctx, 3*time.Second)
		err := rc.Ping(pingCtx)
		cancelI()
		if err != nil {
			log.Warn("redis unavailable; trade idempotency is per-process only", slog.Any("error", err))
			_ = rc.Close()
		} else {
			idemStore = cache.NewRedisIdempotencyStore(rc)
			defer rc.Close()
			log.Info("redis connected; distributed trade idempotency enabled")
		}
	}

	// ── Domain services (shared by REST + WS) ───────────────────────────────
	tickSvc := domain.NewTickService(mt5Client, priceStore, cfg.MT5.ReadDataFromDB,
		domain.WithBookConvention(transform.ParseBookConvention(cfg.Trade.BookSideConvention)),
		domain.WithBookSubscribe(cfg.Trade.BookSubscribe),
		domain.WithClockSymbol(firstOrEmpty(cfg.MT5.DefaultSymbolList)))
	// One broker clock for every service that converts between MT5's broker-
	// stamped times and the UTC this API speaks (TIME-001). The resolver lives
	// on the tick service because quotes are what keep its cache warm.
	brokerClock := domain.BrokerClock(tickSvc.BrokerOffset)
	orderSvc := domain.NewOrderService(mt5Client, domain.WithOrderBrokerClock(brokerClock))
	positionSvc := domain.NewPositionService(mt5Client, domain.WithPositionBrokerClock(brokerClock))
	userSvc := domain.NewUserService(mt5Client)
	dealSvc := domain.NewDealService(mt5Client, domain.WithDealBrokerClock(brokerClock))
	alertSvc := domain.NewAlertService(alertStore)
	tradeSvc := domain.NewTradeService(mt5Client,
		domain.WithIdempotency(idemStore, cfg.Trade.IdempotencyTTL),
		domain.WithTradeBrokerClock(brokerClock))

	// ── Price-alert evaluator ───────────────────────────────────────────────
	// This is what makes an alert a server feature: it keeps watching after the
	// trader closes the tab.
	if cfg.Alerts.Enabled && cfg.HasRole("jobs") && alertStore != nil {
		jobs.NewAlertEvaluator(alertStore, tickSvc, appLocker, cfg.Alerts.EvalInterval, log).Start(ctx)
		log.Info("price-alert evaluator started", slog.Duration("interval", cfg.Alerts.EvalInterval))
	}

	// ── Background jobs (price history) ─────────────────────────────────────
	if cfg.HasRole("jobs") && priceStore != nil {
		job := jobs.NewPriceHistoryJob(mt5Client, tickSvc, cfg.MT5.DefaultSymbolList, cfg.MT5.DefaultChartData, log)
		if sched, err := jobs.StartScheduler(ctx, job, locker, log); err != nil {
			log.Warn("price-history scheduler failed to start", slog.Any("error", err))
		} else {
			defer sched.Stop()
			log.Info("price-history scheduler started")
		}
	}

	// ── REST handlers ───────────────────────────────────────────────────────
	// Client-IP keyer, shared by the volume limiter below and the login
	// throttle: X-Forwarded-For is only honored from configured trusted
	// proxies; anyone else is keyed by their TCP peer address. A forwarded
	// chain that never yields an untrusted hop keys to "" (exempt + warned)
	// rather than collapsing every user onto the proxy's own address.
	clientIPKeyer, err := middleware.ClientIPKeyer(cfg.RateLimit.TrustedProxies, log)
	if err != nil {
		return fmt.Errorf("RATE_LIMIT_TRUSTED_PROXIES: %w", err)
	}
	// With no trusted proxies the keyer falls back to the TCP peer address.
	// Behind a same-host reverse proxy (Caddy → gateway) that peer is the
	// proxy itself, so EVERY client collapses into one bucket: the login
	// throttle becomes a site-wide lockout any five failed sign-ins can arm
	// (HGH-02 retest, 2026-08-28). The keyer can't see the topology, so warn
	// once at boot whenever a limiter is armed but nothing is trusted — the
	// misconfiguration is otherwise silent until a shared lockout is observed.
	if len(cfg.RateLimit.TrustedProxies) == 0 &&
		(cfg.RateLimit.LoginThreshold > 0 || cfg.RateLimit.RPS > 0) {
		log.Warn("RATE_LIMIT_TRUSTED_PROXIES is empty while a limiter/login throttle is enabled: requests are keyed by TCP peer, so behind a reverse proxy ALL clients share one bucket (site-wide lockout). Set it to loopback plus the proxy's ranges — see deploy/windows/apply-cloudflare-trusted-proxies.ps1",
			slog.Int("login_threshold", cfg.RateLimit.LoginThreshold),
			slog.Float64("rate_limit_rps", cfg.RateLimit.RPS))
	}

	// Mount the API only when JWT is configured (protected routes need it).
	var mountAPI func(chi.Router)
	if jwtAuth != nil {
		apiH := handlers.New(handlers.Deps{
			Order:    orderSvc,
			Position: positionSvc,
			Deal:     dealSvc,
			History:  domain.NewHistoryService(mt5Client, domain.WithHistoryBrokerClock(brokerClock)),
			Symbol:   domain.NewSymbolService(mt5Client, strings.Join(cfg.MT5.DefaultSymbolList, ",")),
			Tick:     tickSvc,
			Trade:    tradeSvc,
			User:     userSvc,
			// The group lookup is what lets an account be classified demo or
			// live; it is inert unless CRM_DEMO_MT5_GROUPS names some groups.
			Login:     domain.NewLoginService(jwtAuth, crm).WithGroupLookup(userSvc),
			Alert:     alertSvc,
			Leverage:  domain.NewLeverageService(mt5Client, cfg.Content.LeverageChoices),
			Workspace: domain.NewWorkspaceService(workspaceStore),
			Content: domain.NewContentService(domain.ContentConfig{
				News: domain.ContentProvider{
					URL:          cfg.Content.NewsURL,
					APIKey:       cfg.Content.NewsAPIKey,
					APIKeyHeader: cfg.Content.NewsAPIKeyHeader,
				},
				Calendar: domain.ContentProvider{
					URL:          cfg.Content.CalendarURL,
					APIKey:       cfg.Content.CalendarAPIKey,
					APIKeyHeader: cfg.Content.CalendarKeyHdr,
				},
				CacheTTL: cfg.Content.CacheTTL,
				Timeout:  cfg.Content.Timeout,
			}),
			JWT:        jwtAuth,
			JWTSecret:  cfg.JWT.SecretKey,
			SessionTTL: cfg.JWT.RestoreTTL,
			Environment: handlers.EnvironmentInfo{
				Name:        cfg.Observability.Environment,
				TradingMode: cfg.Observability.TradingMode,
				MT5Server:   cfg.MT5.HostURL,
				BuildSHA:    observability.BuildRevision(),
				APIVersion:  apiVersion,
			},
			OnTradeOutcome: func(outcome string, replayed bool) {
				metrics.TradeSubmissions.WithLabelValues(outcome, strconv.FormatBool(replayed)).Inc()
			},
			// Failed-attempt throttling on the credential routes (HGH-02),
			// keyed by the same trusted-proxy-aware client IP as the volume
			// limiter. On by default; LOGIN_THROTTLE_THRESHOLD=0 disables.
			LoginGuard: middleware.LoginThrottle(ctx,
				cfg.RateLimit.LoginThreshold,
				cfg.RateLimit.LoginBaseLockout,
				cfg.RateLimit.LoginMaxLockout,
				clientIPKeyer),
		})
		jwtMW := middleware.JWTAuth(jwtAuth)
		accMW := middleware.AccountsAuthorize()
		managerMW := middleware.ManagerAuthorize(cfg.Security.ManagerAPIKey)
		mountAPI = func(api chi.Router) { apiH.Mount(api, jwtMW, accMW, managerMW) }
	} else {
		log.Warn("REST API not mounted: JWT_SECRET_KEY is required")
	}

	// ── WebSocket (/ws) ─────────────────────────────────────────────────────
	wsSvc := realtime.Services{
		Tick: tickSvc, Position: positionSvc, User: userSvc, Order: orderSvc,
		Alert: alertSvc, Deal: dealSvc,
	}
	wsHub := realtime.NewHub(ctx, wsSvc, cfg.WS.PushCadence, cfg.WS.SendBuffer, log)
	wsHub.SetOnDrop(func() { metrics.WSDropped.Inc() })

	// Distributed fan-out: when NATS is configured, the hub subscribes to the
	// bus (instead of polling), and a leader-elected poller does the single
	// cluster-wide poll per subscription.
	if cfg.NATS.URL != "" {
		bus, err := realtime.NewNATSBus(cfg.NATS.URL)
		if err != nil {
			log.Warn("nats unavailable; using per-pod WS fan-out", slog.Any("error", err))
		} else {
			wsHub.SetBus(bus)
			defer bus.Close()
			log.Info("nats connected; distributed WS fan-out enabled")
			if cfg.HasRole("poller") {
				poller := realtime.NewPoller(bus, wsSvc, cfg.WS.PushCadence, 0, locker, log)
				if err := poller.Start(ctx); err != nil {
					log.Warn("ws poller failed to start", slog.Any("error", err))
				}
			}
		}
	}
	var wsValidator realtime.Validator
	if jwtAuth != nil {
		wsValidator = jwtAuth
	}
	wsHandler := realtime.NewHandler(ctx, wsHub, wsValidator, realtime.HandlerConfig{
		RequireAuth:     cfg.Security.WSRequireAuth,
		AllowQueryToken: cfg.Security.WSAllowQueryToken,
		WriteTimeout:    cfg.WS.WriteTimeout,
		MaxMessageSize:  cfg.WS.MaxMessageSize,
		AllowedOrigins:  cfg.Security.CORSAllowedOrigins,
		OnConnect:       func() { metrics.WSActive.Inc() },
		OnDisconnect:    func() { metrics.WSActive.Dec() },
	}, log)

	// ── Rate limiter (distributed when Redis is reachable) ──────────────────
	// Keyed by clientIPKeyer, constructed above the API mount (spoofed XFF is
	// ignored for untrusted peers).
	rateLimitMW := middleware.RateLimit(ctx, cfg.RateLimit.RPS, cfg.RateLimit.Burst, clientIPKeyer)
	if cfg.RateLimit.RPS > 0 && len(cfg.Redis.Addrs) > 0 && cfg.Redis.Addrs[0] != "" {
		rc := cache.NewRedis(cfg.Redis.Addrs, cfg.Redis.Password)
		pingCtx, cancelP := context.WithTimeout(ctx, 3*time.Second)
		err := rc.Ping(pingCtx)
		cancelP()
		if err != nil {
			log.Warn("redis unavailable; using in-process rate limiter", slog.Any("error", err))
			_ = rc.Close()
		} else {
			// Redis errors fail open (traffic passes unlimited). Count every
			// occurrence; log at most once per 30s so an outage is visible
			// without flooding.
			var lastFailOpenLog atomic.Int64
			onFailOpen := func(err error) {
				metrics.RateLimitFailOpen.Inc()
				now := time.Now().Unix()
				if last := lastFailOpenLog.Load(); now-last >= 30 && lastFailOpenLog.CompareAndSwap(last, now) {
					log.Warn("rate limiter failing open: redis error, rate protection degraded",
						slog.Any("error", err))
				}
			}
			rateLimitMW = middleware.RateLimitWith(cache.NewRedisLimiter(rc, cfg.RateLimit.RPS, cfg.RateLimit.Burst), clientIPKeyer, onFailOpen)
			defer rc.Close()
			log.Info("redis connected; distributed rate limiting enabled")
		}
	}

	// ── HTTP surface ────────────────────────────────────────────────────────
	router := httpapi.NewRouter(httpapi.Deps{
		Log:           log,
		Health:        health,
		Recoverer:     middleware.Recoverer(log),
		RequestLogger: middleware.RequestLogger(log),
		CORS:          middleware.CORS(cfg.Security.CORSAllowedOrigins),
		Metrics:       middleware.Metrics(metrics),
		RateLimit:     rateLimitMW,
		BodyLimit:     middleware.RequestBodyLimit(cfg.Server.MaxBodyBytes),
		// Prometheus runs on the dedicated private listener below. Never mount
		// it on the public API surface.
		MetricsHandler: nil,
		JWT:            jwtAuth,
		CRM:            crm,
		MT5:            manager,
		MountAPI:       mountAPI,
		WS:             wsHandler,
	})

	srv := &http.Server{
		Addr:              cfg.Server.HTTPAddr,
		Handler:           router,
		ReadHeaderTimeout: cfg.Server.ReadHeaderTimeout,
		ReadTimeout:       cfg.Server.ReadTimeout,
		WriteTimeout:      cfg.Server.WriteTimeout,
		IdleTimeout:       cfg.Server.IdleTimeout,
	}
	metricsSrv := &http.Server{
		Addr:              cfg.Observability.MetricsAddr,
		Handler:           metrics.Handler(),
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       cfg.Server.IdleTimeout,
	}

	serverErr := make(chan error, 2)
	go func() {
		log.Info("http server listening", slog.String("addr", cfg.Server.HTTPAddr))
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			serverErr <- err
		}
	}()
	go func() {
		log.Info("metrics server listening", slog.String("addr", cfg.Observability.MetricsAddr))
		if err := metricsSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			serverErr <- fmt.Errorf("metrics server: %w", err)
		}
	}()

	select {
	case err := <-serverErr:
		return err
	case <-ctx.Done():
		log.Info("shutdown signal received, draining")
	}

	health.SetReady(false)
	shutdownCtx, cancel := context.WithTimeout(context.Background(), cfg.Server.ShutdownTimeout)
	defer cancel()
	shutdownErrs := make(chan error, 2)
	var shutdownWG sync.WaitGroup
	for name, server := range map[string]*http.Server{"http": srv, "metrics": metricsSrv} {
		shutdownWG.Add(1)
		go func() {
			defer shutdownWG.Done()
			if err := server.Shutdown(shutdownCtx); err != nil {
				shutdownErrs <- fmt.Errorf("%s server shutdown: %w", name, err)
			}
		}()
	}
	shutdownWG.Wait()
	close(shutdownErrs)
	var shutdownErr error
	for err := range shutdownErrs {
		shutdownErr = errors.Join(shutdownErr, err)
	}
	wsHub.Wait() // let topic pollers drain after the root context is cancelled
	if shutdownErr != nil {
		log.Error("graceful shutdown failed", slog.Any("error", shutdownErr))
		return shutdownErr
	}
	log.Info("shutdown complete")
	return nil
}

// watchReadiness mirrors the MT5 session state into the readiness probe so
// orchestrators stop routing to this pod when the upstream session is down.
// apiMounted is folded in on every tick: an unmounted REST surface is a
// permanent not-ready condition that the MT5 session must never override.
func watchReadiness(ctx context.Context, h *observability.Health, m *mt5.Manager, metrics *observability.Metrics, apiMounted bool, log *slog.Logger) {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			ready := m.Ready()
			h.SetReady(apiMounted && ready)
			// Exported separately from readiness: readiness also folds in
			// whether this process can serve its API, and an alert needs to
			// distinguish "the broker is refusing us" from "we are misconfigured".
			setSessionUp(metrics, ready)
		}
	}
}

// setSessionUp mirrors the MT5 session state into the mt5_session_up gauge.
func setSessionUp(metrics *observability.Metrics, up bool) {
	if up {
		metrics.MT5SessionUp.Set(1)
		return
	}
	metrics.MT5SessionUp.Set(0)
}
