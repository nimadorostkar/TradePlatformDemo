package timescale

import (
	"context"
	"os"
	"testing"

	"github.com/nimadorostkar/TradePlatformDemo/backend/internal/domain"
)

// These tests run the real SQL — the COPY-based bulk upsert, the daily
// aggregation, the retention delete, and the advisory lock. They need a
// PostgreSQL to talk to and are skipped without one:
//
//	docker run -d --name opo-pg -e POSTGRES_PASSWORD=test -e POSTGRES_DB=opotest \
//	  -p 55432:5432 postgres:16-alpine
//	TIMESCALE_TEST_DSN='postgres://postgres:test@127.0.0.1:55432/opotest?sslmode=disable' \
//	  go test ./internal/store/timescale/
//
// Plain PostgreSQL is enough: Migrate applies the Timescale extension,
// hypertable, and retention policy best-effort, so the core schema and every
// query work without it. CI runs this job against a postgres service.
func testStore(t *testing.T) *Store {
	t.Helper()
	dsn := os.Getenv("TIMESCALE_TEST_DSN")
	if dsn == "" {
		t.Skip("TIMESCALE_TEST_DSN not set; skipping database-backed tests")
	}
	ctx := context.Background()
	s, err := New(ctx, dsn, 4)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	if err := s.Migrate(ctx); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	if _, err := s.pool.Exec(ctx, `TRUNCATE price_history, daily_data, logs`); err != nil {
		t.Fatalf("truncate: %v", err)
	}
	t.Cleanup(s.Close)
	return s
}

// Migrate must be safe to run on every boot — it runs on every boot.
func TestMigrateIsIdempotent(t *testing.T) {
	s := testStore(t)
	for i := 0; i < 3; i++ {
		if err := s.Migrate(context.Background()); err != nil {
			t.Fatalf("migrate run %d: %v", i+1, err)
		}
	}
}

func TestInsertCandlesRoundTripAndLatestTime(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()

	in := []domain.Candle{
		{Symbol: "EURUSD", Time: 1000, Open: 1.10, High: 1.12, Low: 1.09, Close: 1.11, Volume: 5},
		{Symbol: "EURUSD", Time: 2000, Open: 1.11, High: 1.15, Low: 1.10, Close: 1.14, Volume: 7},
		{Symbol: "GBPUSD", Time: 1500, Open: 1.30, High: 1.31, Low: 1.29, Close: 1.305, Volume: 3},
	}
	if err := s.InsertCandles(ctx, in); err != nil {
		t.Fatalf("insert: %v", err)
	}

	got, err := s.IntradayRange(ctx, "EURUSD", 0, 9999)
	if err != nil {
		t.Fatalf("range: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("want 2 EURUSD candles, got %d", len(got))
	}
	// Documented as newest first — the chart reader depends on the ordering.
	if got[0].Time != 2000 || got[1].Time != 1000 {
		t.Errorf("want newest first, got %d then %d", got[0].Time, got[1].Time)
	}
	if got[0].Close != 1.14 || got[0].Volume != 7 {
		t.Errorf("values did not round-trip: %+v", got[0])
	}

	latest, err := s.LatestTime(ctx, "EURUSD", 0, 9999)
	if err != nil {
		t.Fatalf("latest: %v", err)
	}
	if latest != 2000 {
		t.Errorf("LatestTime = %d, want 2000", latest)
	}
	// An empty window is 0, not an error — callers treat 0 as "nothing stored".
	empty, err := s.LatestTime(ctx, "EURUSD", 5000, 6000)
	if err != nil || empty != 0 {
		t.Errorf("empty window: got (%d,%v), want (0,nil)", empty, err)
	}
}

// The job re-fetches overlapping windows, so the same (symbol,time) arrives
// repeatedly. It must update in place rather than duplicate or fail.
func TestInsertCandlesUpsertsOnConflict(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()

	first := []domain.Candle{{Symbol: "EURUSD", Time: 1000, Open: 1, High: 2, Low: 0.5, Close: 1.5, Volume: 10}}
	if err := s.InsertCandles(ctx, first); err != nil {
		t.Fatalf("insert: %v", err)
	}
	revised := []domain.Candle{{Symbol: "EURUSD", Time: 1000, Open: 1, High: 9, Low: 0.5, Close: 8.5, Volume: 99}}
	if err := s.InsertCandles(ctx, revised); err != nil {
		t.Fatalf("re-insert: %v", err)
	}

	got, err := s.IntradayRange(ctx, "EURUSD", 0, 9999)
	if err != nil {
		t.Fatalf("range: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("re-inserting the same candle duplicated it: %d rows", len(got))
	}
	if got[0].High != 9 || got[0].Close != 8.5 || got[0].Volume != 99 {
		t.Errorf("upsert did not take the newer values: %+v", got[0])
	}
}

func TestInsertCandlesEmptyIsANoop(t *testing.T) {
	s := testStore(t)
	if err := s.InsertCandles(context.Background(), nil); err != nil {
		t.Fatalf("empty insert should be a no-op, got %v", err)
	}
}

// open=first, close=last, high=max, low=min — getting open/close backwards is
// invisible in aggregate row counts and wrong on every chart.
func TestAggregateDailyPicksFirstOpenAndLastClose(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()

	if err := s.InsertCandles(ctx, []domain.Candle{
		{Symbol: "EURUSD", Time: 100, Open: 1.00, High: 1.05, Low: 0.99, Close: 1.02, Volume: 1},
		{Symbol: "EURUSD", Time: 200, Open: 1.02, High: 1.20, Low: 0.90, Close: 1.10, Volume: 1},
		{Symbol: "EURUSD", Time: 300, Open: 1.10, High: 1.15, Low: 1.05, Close: 1.12, Volume: 1},
	}); err != nil {
		t.Fatalf("insert: %v", err)
	}
	if err := s.AggregateDaily(ctx, 100, 300, []string{"EURUSD"}); err != nil {
		t.Fatalf("aggregate: %v", err)
	}

	daily, err := s.DailyRange(ctx, "EURUSD", 0, 9999)
	if err != nil {
		t.Fatalf("daily: %v", err)
	}
	if len(daily) != 1 {
		t.Fatalf("want 1 daily row, got %d", len(daily))
	}
	d := daily[0]
	if d.Open != 1.00 {
		t.Errorf("open = %v, want the FIRST candle's open (1.00)", d.Open)
	}
	if d.Close != 1.12 {
		t.Errorf("close = %v, want the LAST candle's close (1.12)", d.Close)
	}
	if d.High != 1.20 {
		t.Errorf("high = %v, want 1.20", d.High)
	}
	if d.Low != 0.90 {
		t.Errorf("low = %v, want 0.90", d.Low)
	}
}

// Re-running the day's aggregation must correct the row, not fail on conflict.
func TestAggregateDailyReRunUpdatesInPlace(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()

	if err := s.InsertCandles(ctx, []domain.Candle{
		{Symbol: "EURUSD", Time: 100, Open: 1, High: 1, Low: 1, Close: 1},
	}); err != nil {
		t.Fatalf("insert: %v", err)
	}
	if err := s.AggregateDaily(ctx, 100, 300, []string{"EURUSD"}); err != nil {
		t.Fatalf("aggregate 1: %v", err)
	}
	// A later candle arrives for the same day.
	if err := s.InsertCandles(ctx, []domain.Candle{
		{Symbol: "EURUSD", Time: 200, Open: 1, High: 4, Low: 1, Close: 3},
	}); err != nil {
		t.Fatalf("insert 2: %v", err)
	}
	if err := s.AggregateDaily(ctx, 100, 300, []string{"EURUSD"}); err != nil {
		t.Fatalf("aggregate 2: %v", err)
	}

	daily, err := s.DailyRange(ctx, "EURUSD", 0, 9999)
	if err != nil {
		t.Fatalf("daily: %v", err)
	}
	if len(daily) != 1 {
		t.Fatalf("re-aggregation duplicated the day: %d rows", len(daily))
	}
	if daily[0].Close != 3 || daily[0].High != 4 {
		t.Errorf("re-aggregation did not update: %+v", daily[0])
	}
}

func TestAggregateDailyWithNoSymbolsIsANoop(t *testing.T) {
	s := testStore(t)
	if err := s.AggregateDaily(context.Background(), 0, 1, nil); err != nil {
		t.Fatalf("no symbols should be a no-op, got %v", err)
	}
}

func TestDeleteOlderThanPrunesOnlyBeforeTheCutoff(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()

	if err := s.InsertCandles(ctx, []domain.Candle{
		{Symbol: "EURUSD", Time: 100, Open: 1, High: 1, Low: 1, Close: 1},
		{Symbol: "EURUSD", Time: 500, Open: 1, High: 1, Low: 1, Close: 1},
		{Symbol: "EURUSD", Time: 900, Open: 1, High: 1, Low: 1, Close: 1},
	}); err != nil {
		t.Fatalf("insert: %v", err)
	}
	if err := s.DeleteOlderThan(ctx, 500); err != nil {
		t.Fatalf("delete: %v", err)
	}

	got, err := s.IntradayRange(ctx, "EURUSD", 0, 9999)
	if err != nil {
		t.Fatalf("range: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("want 2 rows kept, got %d", len(got))
	}
	// The cutoff is exclusive: a row exactly at the boundary survives.
	for _, c := range got {
		if c.Time < 500 {
			t.Errorf("row at %d should have been pruned", c.Time)
		}
	}
}

func TestDistinctSymbols(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()

	if err := s.InsertCandles(ctx, []domain.Candle{
		{Symbol: "EURUSD", Time: 1, Open: 1, High: 1, Low: 1, Close: 1},
		{Symbol: "EURUSD", Time: 2, Open: 1, High: 1, Low: 1, Close: 1},
		{Symbol: "GBPUSD", Time: 1, Open: 1, High: 1, Low: 1, Close: 1},
	}); err != nil {
		t.Fatalf("insert: %v", err)
	}
	syms, err := s.DistinctSymbols(ctx)
	if err != nil {
		t.Fatalf("symbols: %v", err)
	}
	if len(syms) != 2 {
		t.Fatalf("want 2 distinct symbols, got %d (%v)", len(syms), syms)
	}
}

// The scheduler relies on this to keep two nodes from running the same
// price-history sweep. A lock that both callers can take is the whole bug.
func TestTryLockIsExclusiveUntilReleased(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	const key = int64(987654321)

	got, release, err := s.TryLock(ctx, key)
	if err != nil {
		t.Fatalf("first lock: %v", err)
	}
	if !got {
		t.Fatal("first caller should acquire the lock")
	}

	second, release2, err := s.TryLock(ctx, key)
	if err != nil {
		t.Fatalf("second lock: %v", err)
	}
	if second {
		release2()
		release()
		t.Fatal("two callers held the same advisory lock at once")
	}

	release()

	third, release3, err := s.TryLock(ctx, key)
	if err != nil {
		t.Fatalf("third lock: %v", err)
	}
	if !third {
		t.Fatal("lock was not released")
	}
	release3()
}
