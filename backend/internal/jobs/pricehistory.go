// Package jobs runs the background price-history pipeline (the .NET Hangfire
// PriceHistoryJob): a daily fetch of M1 candles per symbol into the store, then
// a daily aggregation — guarded by a distributed lock so multiple replicas don't
// double-fire (fixing the .NET boot double-enqueue). See ANALYSIS §10.
package jobs

import (
	"context"
	"encoding/json"
	"log/slog"
	"time"

	"github.com/nimadorostkar/TradePlatformDemo/backend/internal/mt5"
)

// MT5Client fetches the live symbol list.
type MT5Client interface {
	Get(ctx context.Context, path string) ([]byte, error)
}

// Syncer is the TickService subset the job needs.
type Syncer interface {
	SyncSymbolHistoryData(ctx context.Context, symbol string, from, to int64, data string) error
	AggregateDaily(ctx context.Context, day time.Time) error
}

// PriceHistoryJob holds the job dependencies.
type PriceHistoryJob struct {
	mt5            MT5Client
	tick           Syncer
	defaultSymbols []string
	chartData      string
	log            *slog.Logger
}

// NewPriceHistoryJob constructs the job.
func NewPriceHistoryJob(mt5c MT5Client, tick Syncer, defaultSymbols []string, chartData string, log *slog.Logger) *PriceHistoryJob {
	return &PriceHistoryJob{mt5: mt5c, tick: tick, defaultSymbols: defaultSymbols, chartData: chartData, log: log.With(slog.String("component", "price-history-job"))}
}

// FetchAndSave pulls yesterday→now M1 candles for every symbol into the store.
func (j *PriceHistoryJob) FetchAndSave(ctx context.Context) error {
	now := time.Now().UTC()
	from := now.AddDate(0, 0, -1).Unix()
	to := now.Unix()

	symbols := j.symbolList(ctx)
	if err := ctx.Err(); err != nil {
		return err
	}
	j.log.Info("price-history fetch starting", slog.Int("symbols", len(symbols)))
	var firstErr error
	for _, sym := range symbols {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := j.tick.SyncSymbolHistoryData(ctx, sym, from, to, j.chartData); err != nil {
			if ctxErr := ctx.Err(); ctxErr != nil {
				return ctxErr
			}
			j.log.Warn("sync symbol failed", slog.String("symbol", sym), slog.Any("error", err))
			if firstErr == nil {
				firstErr = err
			}
		}
	}
	return firstErr
}

// FetchAndAggregate rolls the previous day's intraday rows into daily rows.
func (j *PriceHistoryJob) FetchAndAggregate(ctx context.Context) error {
	return j.tick.AggregateDaily(ctx, time.Now().UTC())
}

// symbolList returns the live MT5 symbol list, falling back to the configured
// default list.
func (j *PriceHistoryJob) symbolList(ctx context.Context) []string {
	body, err := j.mt5.Get(ctx, mt5.PathSymbolList)
	if err == nil {
		var resp struct {
			Answer []string `json:"answer"`
		}
		if json.Unmarshal(body, &resp) == nil && len(resp.Answer) > 0 {
			return resp.Answer
		}
	}
	return j.defaultSymbols
}

// LockKey is the advisory-lock key shared by all replicas for this job.
const LockKey int64 = 0x4f504f5052494345 // "OPOPRICE"
