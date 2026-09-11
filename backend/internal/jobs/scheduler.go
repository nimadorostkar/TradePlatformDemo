package jobs

import (
	"context"
	"log/slog"
	"time"

	"github.com/robfig/cron/v3"
)

// Locker guards a job so only one replica runs it (satisfied by timescale.Store).
type Locker interface {
	TryLock(ctx context.Context, key int64) (bool, func(), error)
}

// Scheduler runs the price-history job daily (and once at startup).
type Scheduler struct {
	cron *cron.Cron
}

// StartScheduler registers the daily job, runs it once at startup, and starts
// the cron loop. locker may be nil (single-instance, no distributed guard).
func StartScheduler(ctx context.Context, job *PriceHistoryJob, locker Locker, log *slog.Logger) (*Scheduler, error) {
	c := cron.New(cron.WithLocation(time.UTC))
	run := func() { runGuarded(ctx, job, locker, log) }
	if _, err := c.AddFunc("@daily", run); err != nil {
		return nil, err
	}
	// Fire once at startup (guarded), mirroring the .NET boot enqueue.
	go run()
	c.Start()
	return &Scheduler{cron: c}, nil
}

// Stop halts the scheduler, waiting for the running job to finish.
func (s *Scheduler) Stop() {
	<-s.cron.Stop().Done()
}

// runGuarded acquires the distributed lock (if any) and runs the fetch then the
// aggregation. If another replica holds the lock, it skips.
func runGuarded(ctx context.Context, job *PriceHistoryJob, locker Locker, log *slog.Logger) {
	if locker != nil {
		ok, release, err := locker.TryLock(ctx, LockKey)
		if err != nil {
			log.Warn("price-history lock error", slog.Any("error", err))
			return
		}
		if !ok {
			log.Info("price-history job skipped (lock held by another replica)")
			return
		}
		defer release()
	}
	if err := job.FetchAndSave(ctx); err != nil {
		if ctx.Err() != nil {
			return
		}
		log.Warn("price-history fetch failed", slog.Any("error", err))
	}
	if ctx.Err() != nil {
		return
	}
	if err := job.FetchAndAggregate(ctx); err != nil {
		if ctx.Err() != nil {
			return
		}
		log.Warn("price-history aggregate failed", slog.Any("error", err))
	}
}
