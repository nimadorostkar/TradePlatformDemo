package jobs

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"sync"
	"testing"
	"time"
)

type fakeMT5 struct{ body []byte }

func (f fakeMT5) Get(_ context.Context, _ string) ([]byte, error) { return f.body, nil }

type fakeSyncer struct {
	mu      sync.Mutex
	synced  []string
	aggDone bool
}

func (f *fakeSyncer) SyncSymbolHistoryData(_ context.Context, symbol string, _, _ int64, _ string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.synced = append(f.synced, symbol)
	return nil
}
func (f *fakeSyncer) AggregateDaily(_ context.Context, _ time.Time) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.aggDone = true
	return nil
}

func testLog() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

// Uses the live symbol list from MT5 when present.
func TestFetchAndSave_UsesLiveSymbols(t *testing.T) {
	mt5 := fakeMT5{body: []byte(`{"retcode":"0 Done","answer":["EURUSD","XAUUSD"]}`)}
	sync := &fakeSyncer{}
	job := NewPriceHistoryJob(mt5, sync, []string{"FALLBACK"}, "dhloc", testLog())

	if err := job.FetchAndSave(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(sync.synced) != 2 || sync.synced[0] != "EURUSD" {
		t.Errorf("expected live symbols synced, got %v", sync.synced)
	}
}

// Falls back to the default symbol list when MT5 returns no symbols.
func TestFetchAndSave_FallbackSymbols(t *testing.T) {
	mt5 := fakeMT5{body: []byte(`{"retcode":"0 Done","answer":[]}`)}
	sync := &fakeSyncer{}
	job := NewPriceHistoryJob(mt5, sync, []string{"FALLBACK"}, "dhloc", testLog())

	_ = job.FetchAndSave(context.Background())
	if len(sync.synced) != 1 || sync.synced[0] != "FALLBACK" {
		t.Errorf("expected fallback symbols, got %v", sync.synced)
	}
}

// When the distributed lock is held by another replica, the job is skipped.
type lockedLocker struct{}

func (lockedLocker) TryLock(_ context.Context, _ int64) (bool, func(), error) {
	return false, func() {}, nil
}

func TestRunGuarded_SkipsWhenLockHeld(t *testing.T) {
	mt5 := fakeMT5{body: []byte(`{"answer":["EURUSD"]}`)}
	sync := &fakeSyncer{}
	job := NewPriceHistoryJob(mt5, sync, nil, "dhloc", testLog())

	runGuarded(context.Background(), job, lockedLocker{}, testLog())
	if len(sync.synced) != 0 {
		t.Errorf("job ran despite lock held: %v", sync.synced)
	}
}

type cancelingSyncer struct {
	cancel context.CancelFunc
	calls  int
}

func (f *cancelingSyncer) SyncSymbolHistoryData(_ context.Context, _ string, _, _ int64, _ string) error {
	f.calls++
	f.cancel()
	return context.Canceled
}

func (f *cancelingSyncer) AggregateDaily(_ context.Context, _ time.Time) error {
	panic("aggregation must not run after cancellation")
}

func TestFetchAndSave_StopsAfterCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	sync := &cancelingSyncer{cancel: cancel}
	job := NewPriceHistoryJob(
		fakeMT5{body: []byte(`{"answer":["EURUSD","XAUUSD","GBPUSD"]}`)},
		sync,
		nil,
		"dhloc",
		testLog(),
	)

	if err := job.FetchAndSave(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("FetchAndSave error = %v, want context canceled", err)
	}
	if sync.calls != 1 {
		t.Fatalf("synced %d symbols after cancellation, want 1", sync.calls)
	}
}
