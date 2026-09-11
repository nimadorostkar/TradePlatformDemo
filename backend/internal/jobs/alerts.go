package jobs

import (
	"context"
	"log/slog"
	"time"

	"github.com/nimadorostkar/TradePlatformDemo/backend/internal/domain"
)

// The alert evaluator is what makes a price alert a server feature rather than
// a browser one. It sweeps the symbols that have active alerts, compares the
// current quote, and flips the ones that crossed — so an alert keeps working
// after the trader closes the tab, which is the whole point of asking the
// backend for it.

// QuoteSource supplies the current price of a symbol (satisfied by
// *domain.TickService).
type QuoteSource interface {
	LastPrice(ctx context.Context, symbol string) (float64, error)
}

// AlertEvaluator periodically evaluates active alerts.
type AlertEvaluator struct {
	store    domain.AlertStore
	quotes   QuoteSource
	locker   Locker
	interval time.Duration
	log      *slog.Logger
}

// AlertLockKey is the advisory-lock key shared by all replicas for this job.
const AlertLockKey int64 = 0x4f504f414c525453 // "OPOALRTS"

// DefaultAlertInterval is how often alerts are evaluated. It matches the WS
// push cadence: evaluating faster than the client can be told is wasted
// upstream load.
const DefaultAlertInterval = 3 * time.Second

// NewAlertEvaluator constructs the evaluator. locker may be nil (single node).
func NewAlertEvaluator(store domain.AlertStore, quotes QuoteSource, locker Locker, interval time.Duration, log *slog.Logger) *AlertEvaluator {
	if interval <= 0 {
		interval = DefaultAlertInterval
	}
	return &AlertEvaluator{
		store:    store,
		quotes:   quotes,
		locker:   locker,
		interval: interval,
		log:      log.With(slog.String("component", "alert-evaluator")),
	}
}

// Start runs the evaluation loop until ctx is cancelled.
func (e *AlertEvaluator) Start(ctx context.Context) {
	go func() {
		ticker := time.NewTicker(e.interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				e.runGuarded(ctx)
			}
		}
	}()
}

// runGuarded evaluates once, holding the distributed lock when one is
// available. The lock is an optimization, not a correctness requirement:
// MarkAlertTriggered is itself race-safe, so a double-run costs a duplicate
// quote fetch but can never fire an alert twice.
func (e *AlertEvaluator) runGuarded(ctx context.Context) {
	if e.locker != nil {
		ok, release, err := e.locker.TryLock(ctx, AlertLockKey)
		if err != nil {
			e.log.Warn("alert lock error", slog.Any("error", err))
			return
		}
		if !ok {
			return // another replica is evaluating
		}
		defer release()
	}
	if err := e.EvaluateOnce(ctx); err != nil {
		e.log.Warn("alert evaluation failed", slog.Any("error", err))
	}
}

// EvaluateOnce performs one full sweep and returns the number of alerts fired.
func (e *AlertEvaluator) EvaluateOnce(ctx context.Context) error {
	symbols, err := e.store.ActiveAlertSymbols(ctx)
	if err != nil {
		return err
	}
	for _, symbol := range symbols {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		price, err := e.quotes.LastPrice(ctx, symbol)
		if err != nil {
			// One unquotable symbol (closed market, bad name) must not stop the
			// sweep — the other symbols' alerts are still live.
			e.log.Debug("no quote for alert symbol", slog.String("symbol", symbol), slog.Any("error", err))
			continue
		}
		alerts, err := e.store.ActiveAlertsForSymbol(ctx, symbol)
		if err != nil {
			e.log.Warn("load alerts failed", slog.String("symbol", symbol), slog.Any("error", err))
			continue
		}
		now := time.Now().UTC()
		for _, a := range alerts {
			if !domain.AlertCrossed(a.Condition, a.Price, price) {
				continue
			}
			fired, err := e.store.MarkAlertTriggered(ctx, a.ID, now, price)
			if err != nil {
				e.log.Warn("mark alert triggered failed", slog.Int64("alert", a.ID), slog.Any("error", err))
				continue
			}
			if fired {
				e.log.Info("price alert triggered",
					slog.Int64("alert", a.ID),
					slog.String("login", a.Login),
					slog.String("symbol", a.Symbol),
					slog.String("condition", a.Condition),
					slog.Float64("level", a.Price),
					slog.Float64("price", price))
			}
		}
	}
	return nil
}
