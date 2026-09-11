package domain

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"testing"

	"github.com/nimadorostkar/TradePlatformDemo/backend/internal/transform"
)

// The long-range chart defect (2026-08-13 report): MT5 silently truncates one
// /api/chart/get answer at roughly a year of M1 rows, so a five-year window
// fetched in one request produced bars for the first ~56 weeks, a multi-year
// hole, and nothing else — rendered by TradingView as a broken chart. These
// tests emulate that cap and prove the chunked fetch recovers full coverage,
// degrades to newest-contiguous data on upstream failure, and stops cleanly at
// the broker's retention boundary.

const testBarStep int64 = 86400 // one bar per day keeps the fixtures small

// cappedChartMT5 emulates the production MT5 behaviors that matter here.
type cappedChartMT5 struct {
	capSeconds  int64 // a window's answer is truncated to this span from `from`
	errorBefore int64 // windows ending before this fail at transport (0 = off)
	emptyBefore int64 // windows ending before this answer empty (0 = off)
	chartCalls  int
}

func (f *cappedChartMT5) Post(_ context.Context, _ string, _ []byte) ([]byte, error) {
	return nil, errors.New("unexpected POST")
}

func (f *cappedChartMT5) Get(_ context.Context, path string) ([]byte, error) {
	if !strings.Contains(path, "/api/chart/get") {
		// The broker-clock probe. Erroring is fine: the resolver then uses its
		// deterministic EEST fallback, which these assertions do not depend on.
		return nil, errors.New("no tick data in this fake")
	}
	u, err := url.Parse(path)
	if err != nil {
		return nil, err
	}
	from, _ := strconv.ParseInt(u.Query().Get("from"), 10, 64)
	to, _ := strconv.ParseInt(u.Query().Get("to"), 10, 64)
	f.chartCalls++

	if f.errorBefore > 0 && to <= f.errorBefore {
		return nil, errors.New("upstream connection reset")
	}
	if f.emptyBefore > 0 && to <= f.emptyBefore {
		return []byte(`{"retcode":"0 Done","answer":[]}`), nil
	}

	end := to
	if f.capSeconds > 0 && from+f.capSeconds < end {
		end = from + f.capSeconds // the silent truncation being emulated
	}
	var rows []string
	for t := ((from + testBarStep - 1) / testBarStep) * testBarStep; t <= end; t += testBarStep {
		rows = append(rows, fmt.Sprintf("[%d,1.1,1.2,1.0,1.15]", t))
	}
	return []byte(`{"retcode":"0 Done","answer":[` + strings.Join(rows, ",") + `]}`), nil
}

func chartBars(t *testing.T, env any) []transform.TVTickResponse {
	t.Helper()
	bars, ok := env.([]transform.TVTickResponse)
	if !ok {
		t.Fatalf("data is %T, want []transform.TVTickResponse", env)
	}
	return bars
}

// assertCoverage fails on any hole larger than one bar step — the defect shape.
func assertCoverage(t *testing.T, bars []transform.TVTickResponse, wantSpanSeconds int64) {
	t.Helper()
	if len(bars) == 0 {
		t.Fatal("no bars returned")
	}
	for i := 1; i < len(bars); i++ {
		if bars[i].Time <= bars[i-1].Time {
			t.Fatalf("bars not strictly ascending at %d: %d then %d", i, bars[i-1].Time, bars[i].Time)
		}
		if gap := bars[i].Time - bars[i-1].Time; gap > testBarStep {
			t.Fatalf("hole of %ds at %d (bar %d -> %d)", gap, i, bars[i-1].Time, bars[i].Time)
		}
	}
	if span := bars[len(bars)-1].Time - bars[0].Time; span < wantSpanSeconds {
		t.Fatalf("coverage span %ds, want at least %ds", span, wantSpanSeconds)
	}
}

func TestChartRange_ChunksThroughUpstreamCap(t *testing.T) {
	// The cap (200d) exceeds one chunk (120d) but is far below the request
	// (600d): a single fetch reproduces the reported truncation, the chunked
	// fetch must not.
	fake := &cappedChartMT5{capSeconds: 200 * 24 * 3600}
	svc := NewTickService(fake, nil, false)

	const to = int64(1_786_600_000)
	from := to - 600*24*3600
	env := svc.GetM1History(context.Background(), "EURUSD", from, to, "dhloc")
	if !env.Success {
		t.Fatalf("expected success: %+v", env)
	}
	bars := chartBars(t, env.Data)
	assertCoverage(t, bars, 598*24*3600)
	if fake.chartCalls < 5 {
		t.Fatalf("expected the window to fan out into chunks, got %d upstream calls", fake.chartCalls)
	}
}

func TestChartRange_WeeklyBucketsHaveNoHole(t *testing.T) {
	// The exact user-visible symptom: a 5y weekly chart with a multi-year hole.
	fake := &cappedChartMT5{capSeconds: 200 * 24 * 3600}
	svc := NewTickService(fake, nil, false)

	const to = int64(1_786_600_000)
	from := to - 5*365*24*3600
	env := svc.GetHistoryBy1DResolution(context.Background(), "EURUSD", from, to, "1W")
	if !env.Success {
		t.Fatalf("expected success: %+v", env)
	}
	weeks := chartBars(t, env.Data)
	if len(weeks) < 250 {
		t.Fatalf("expected ~260 weekly bars over 5y, got %d", len(weeks))
	}
	for i := 1; i < len(weeks); i++ {
		if gap := weeks[i].Time - weeks[i-1].Time; gap > 8*24*3600 {
			t.Fatalf("weekly hole of %d days (%d -> %d)", gap/86400, weeks[i-1].Time, weeks[i].Time)
		}
	}
}

func TestChartRange_UpstreamErrorKeepsNewestContiguous(t *testing.T) {
	// Older chunks fail at transport. The result must be the newest data,
	// contiguous back to the failure boundary — a shorter chart, never one
	// with an interior hole dressed up as complete.
	const to = int64(1_786_600_000)
	boundary := to - 250*24*3600
	fake := &cappedChartMT5{capSeconds: 400 * 24 * 3600, errorBefore: boundary}
	svc := NewTickService(fake, nil, false)

	from := to - 600*24*3600
	env := svc.GetM1History(context.Background(), "EURUSD", from, to, "dhloc")
	if !env.Success {
		t.Fatalf("partial coverage must still be a success: %+v", env)
	}
	bars := chartBars(t, env.Data)
	assertCoverage(t, bars, 230*24*3600)
	if bars[0].Time < boundary-chartChunkSeconds {
		t.Fatalf("oldest bar %d reaches past the failing boundary %d", bars[0].Time, boundary)
	}
}

func TestChartRange_RetentionEndStopsCleanly(t *testing.T) {
	// Below the broker's retention the answer is empty, not an error; the
	// fetch stops there and reports what exists.
	const to = int64(1_786_600_000)
	retention := to - 300*24*3600
	fake := &cappedChartMT5{capSeconds: 400 * 24 * 3600, emptyBefore: retention}
	svc := NewTickService(fake, nil, false)

	from := to - 900*24*3600
	env := svc.GetM1History(context.Background(), "EURUSD", from, to, "dhloc")
	if !env.Success {
		t.Fatalf("expected success: %+v", env)
	}
	bars := chartBars(t, env.Data)
	assertCoverage(t, bars, 280*24*3600)
}

func TestChartRange_SmallWindowStaysSingleFetch(t *testing.T) {
	// The everyday intraday request must not start fanning out.
	fake := &cappedChartMT5{}
	svc := NewTickService(fake, nil, false)

	const to = int64(1_786_600_000)
	env := svc.GetM1History(context.Background(), "EURUSD", to-3600, to, "dhloc")
	if !env.Success {
		t.Fatalf("expected success: %+v", env)
	}
	if fake.chartCalls != 1 {
		t.Fatalf("small window used %d upstream calls, want 1", fake.chartCalls)
	}
}
