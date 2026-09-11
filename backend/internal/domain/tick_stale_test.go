package domain

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/nimadorostkar/TradePlatformDemo/backend/internal/transform"
)

// chartWindowClient answers /api/tick/last with a zero-offset broker clock and
// /api/chart/get with fixed bars, recording every chart window it is asked
// for. failCharts makes the chart endpoint fail, the shape of the 2026-08-24
// upstream stalls.
type chartWindowClient struct {
	chartBody  string
	failCharts bool
	windows    [][2]int64
}

func (c *chartWindowClient) Get(_ context.Context, path string) ([]byte, error) {
	if strings.HasPrefix(path, "/api/tick/last") {
		return []byte(fmt.Sprintf(
			`{"retcode":"0 Done","answer":[{"Symbol":"EURUSD","Datetime":"%d","Bid":1,"Ask":2,"Last":1,"Volume":1}]}`,
			time.Now().UTC().Unix())), nil
	}
	if strings.HasPrefix(path, "/api/chart/get") {
		q, _ := url.ParseQuery(path[strings.Index(path, "?")+1:])
		from, _ := strconv.ParseInt(q.Get("from"), 10, 64)
		to, _ := strconv.ParseInt(q.Get("to"), 10, 64)
		c.windows = append(c.windows, [2]int64{from, to})
		if c.failCharts {
			return nil, errors.New("upstream stalled")
		}
		return []byte(c.chartBody), nil
	}
	return nil, errors.New("unexpected path " + path)
}
func (c *chartWindowClient) Post(_ context.Context, _ string, _ []byte) ([]byte, error) {
	return nil, errors.New("unexpected post")
}

// A daily/weekly request must not refetch history the store already holds —
// the observed 6-year weekly window took 79 seconds as M1 against a slow
// upstream — but it MUST fetch the segments the store does not: the head
// before its oldest row and the tail after its newest. The first cut fetched
// the tail alone, and the skipped head became a permanent six-year hole in
// the chart (user report, 2026-08-24 "there is gap on chart").
func TestHistory1D_LiveFetchCoversHeadAndTailButNotStoreSpan(t *testing.T) {
	const day = int64(86400)
	now := time.Now().UTC().Unix()
	lastStored := (now / day) * day // "today" per stored aggregation
	firstStored := lastStored - 2*day
	from := now - 2000*day
	store := &fakeStore{daily: []DailyCandle{
		{Symbol: "EURUSD", Timestamp: firstStored, Open: 1, High: 2, Low: 0.5, Close: 1.5},
		{Symbol: "EURUSD", Timestamp: lastStored, Open: 1.5, High: 1.8, Low: 1.4, Close: 1.6},
	}}
	client := &chartWindowClient{chartBody: fmt.Sprintf(
		`{"retcode":"0 Done","answer":[[%d,1.6,1.9,1.55,1.7]]}`, lastStored+3600)}
	svc := NewTickService(client, store, false)

	env := svc.GetHistoryBy1DResolution(context.Background(), "EURUSD", from, now, "1D")
	if !env.Success {
		t.Fatal("expected success")
	}
	// The head span is CHUNKED into bounded upstream calls; what matters is
	// the union: the head reaches all the way back to `from`, the tail starts
	// at the last stored day, and nothing intrudes into the stored interior.
	minFrom := int64(1 << 62)
	tailSeen := false
	for _, w := range client.windows {
		if w[0] < minFrom {
			minFrom = w[0]
		}
		if w[0] == lastStored {
			tailSeen = true
		}
		if w[1] > firstStored && w[0] < lastStored {
			t.Fatalf("window %v intrudes into the stored span [%d %d]", w, firstStored, lastStored)
		}
	}
	if minFrom != from {
		t.Fatalf("head coverage starts at %d, want %d — the pre-coverage years must be fetched", minFrom, from)
	}
	if !tailSeen {
		t.Fatalf("no tail segment starting at the last stored day %d: %v", lastStored, client.windows)
	}
}

// When the store covers the request from its very start, ONLY the tail is
// fetched — the 79-second full-window refetch must stay dead.
func TestHistory1D_NoHeadFetchWhenStoreCoversTheStart(t *testing.T) {
	const day = int64(86400)
	now := time.Now().UTC().Unix()
	lastStored := (now / day) * day
	from := lastStored - 2*day // exactly the oldest stored row
	store := &fakeStore{daily: []DailyCandle{
		{Symbol: "EURUSD", Timestamp: from, Open: 1, High: 2, Low: 0.5, Close: 1.5},
		{Symbol: "EURUSD", Timestamp: lastStored, Open: 1.5, High: 1.8, Low: 1.4, Close: 1.6},
	}}
	client := &chartWindowClient{chartBody: fmt.Sprintf(
		`{"retcode":"0 Done","answer":[[%d,1.6,1.9,1.55,1.7]]}`, lastStored+3600)}
	svc := NewTickService(client, store, false)

	if env := svc.GetHistoryBy1DResolution(context.Background(), "EURUSD", from, now, "1D"); !env.Success {
		t.Fatal("expected success")
	}
	if len(client.windows) != 1 {
		t.Fatalf("want only the tail segment, got %d: %v", len(client.windows), client.windows)
	}
	if got := client.windows[0][0]; got != lastStored {
		t.Fatalf("tail fetch started at %d, want the last stored day %d — the store span was refetched", got, lastStored)
	}
}

// With the upstream down, stored daily candles ARE the chart.
func TestHistory1D_ServesStoreWhenLiveFetchFails(t *testing.T) {
	const day = int64(86400)
	now := time.Now().UTC().Unix()
	store := &fakeStore{daily: []DailyCandle{
		{Symbol: "EURUSD", Timestamp: now - 3*day, Open: 1, High: 2, Low: 0.5, Close: 1.5},
		{Symbol: "EURUSD", Timestamp: now - 2*day, Open: 1.5, High: 1.8, Low: 1.4, Close: 1.6},
	}}
	client := &chartWindowClient{failCharts: true}
	svc := NewTickService(client, store, false)

	env := svc.GetHistoryBy1DResolution(context.Background(), "EURUSD", now-10*day, now, "1D")
	if !env.Success {
		t.Fatal("stored candles must survive the upstream failing")
	}
	body := marshal(t, env)
	if !strings.Contains(body, `"close":1.6`) {
		t.Fatalf("stored candles missing from the answer: %s", body)
	}
}

// No store, upstream down: the failure passes through — never an invented
// empty chart, which TradingView would cache as "no data ever".
func TestHistory1D_NoStoreNoInvention(t *testing.T) {
	client := &chartWindowClient{failCharts: true}
	svc := NewTickService(client, nil, false)
	if env := svc.GetHistoryBy1DResolution(context.Background(), "EURUSD", 0, time.Now().Unix(), "1D"); env.Success {
		t.Fatal("expected failure with no store and a dead upstream")
	}
}

// The intraday path falls back to the poller-fed store on upstream failure,
// ascending like the live path answers.
func TestM1History_ServesStoreWhenLiveFetchFails(t *testing.T) {
	store := &fakeStore{intraday: []Candle{
		{Symbol: "EURUSD", Time: 1800, Open: 1.2, High: 1.3, Low: 1.1, Close: 1.25},
		{Symbol: "EURUSD", Time: 1700, Open: 1.1, High: 1.2, Low: 1.0, Close: 1.15},
	}}
	client := &chartWindowClient{failCharts: true}
	svc := NewTickService(client, store, false)

	env := svc.GetM1History(context.Background(), "EURUSD", 1600, 1900, "dhloc")
	if !env.Success {
		t.Fatal("stored minutes must survive the upstream failing")
	}
	body := marshal(t, env)
	if strings.Index(body, `"time":1700`) > strings.Index(body, `"time":1800`) {
		t.Fatalf("fallback bars not ascending: %s", body)
	}
}

func TestM1History_NoStoreRowsNoInvention(t *testing.T) {
	client := &chartWindowClient{failCharts: true}
	svc := NewTickService(client, &fakeStore{}, false)
	if env := svc.GetM1History(context.Background(), "EURUSD", 1600, 1900, "dhloc"); env.Success {
		t.Fatal("expected failure when the store holds nothing for the window")
	}
}

// rangedStore serves daily rows range-aware, like the real store.
type rangedStore struct {
	fakeStore
	allDaily []DailyCandle
}

func (r *rangedStore) DailyRange(_ context.Context, _ string, from, to int64) ([]DailyCandle, error) {
	var out []DailyCandle
	for _, d := range r.allDaily {
		if d.Timestamp >= from && d.Timestamp <= to {
			out = append(out, d)
		}
	}
	return out, nil
}

// The chart pages BACKWARD through history. During an outage, the page that
// reaches past the store's coverage must come back EMPTY, not broken —
// TradingView answers a broken page by discarding the series it has already
// drawn (observed live: 36 served candles, one 400 on the 2014-2020 page,
// then "No data here").
func TestHistory1D_PreCoveragePageIsEmptyNotBroken(t *testing.T) {
	const day = int64(86400)
	now := time.Now().UTC().Unix()
	store := &rangedStore{allDaily: []DailyCandle{
		{Symbol: "EURUSD", Timestamp: now - 3*day, Open: 1, High: 2, Low: 0.5, Close: 1.5},
	}}
	client := &chartWindowClient{failCharts: true}
	svc := NewTickService(client, store, false)

	// A window entirely BEFORE the store's oldest row.
	env := svc.GetHistoryBy1DResolution(context.Background(), "EURUSD", now-4000*day, now-2000*day, "1W")
	if !env.Success {
		t.Fatal("a pre-coverage page must be empty, not an error")
	}
	bars, ok := env.Data.([]transform.TVTickResponse)
	if !ok || len(bars) != 0 {
		t.Fatalf("want empty bars, got %#v", env.Data)
	}

	// A symbol the store has NEVER seen still fails honestly.
	unseen := NewTickService(client, &rangedStore{}, false)
	if env := unseen.GetHistoryBy1DResolution(context.Background(), "GBPUSD", now-4000*day, now-2000*day, "1W"); env.Success {
		t.Fatal("an unseen symbol must fail when the upstream fails")
	}
}

// A successfully fetched head segment is BANKED: the broker's outage cycles
// are shorter than a multi-year head fetch, so a range that survives one
// healthy window must never need fetching again.
func TestHistory1D_BanksFetchedSegmentsAsDailyRows(t *testing.T) {
	const day = int64(86400)
	now := time.Now().UTC().Unix()
	lastStored := (now / day) * day
	firstStored := lastStored - 2*day
	oldBarDay := ((now - 30*day) / day) * day
	store := &fakeStore{daily: []DailyCandle{
		{Symbol: "EURUSD", Timestamp: firstStored, Open: 1, High: 2, Low: 0.5, Close: 1.5},
		{Symbol: "EURUSD", Timestamp: lastStored, Open: 1.5, High: 1.8, Low: 1.4, Close: 1.6},
	}}
	client := &chartWindowClient{chartBody: fmt.Sprintf(
		`{"retcode":"0 Done","answer":[[%d,1.2,1.3,1.1,1.25],[%d,1.25,1.4,1.2,1.35]]}`,
		oldBarDay+3600, oldBarDay+7200)}
	svc := NewTickService(client, store, false)

	if env := svc.GetHistoryBy1DResolution(context.Background(), "EURUSD", now-2000*day, now, "1D"); !env.Success {
		t.Fatal("expected success")
	}
	if len(store.insertedDaily) == 0 {
		t.Fatal("fetched head bars were not banked into daily_data")
	}
	found := false
	for _, c := range store.insertedDaily {
		if c.Timestamp == oldBarDay {
			found = true
			if c.Open != 1.2 || c.High != 1.4 || c.Low != 1.1 || c.Close != 1.35 {
				t.Fatalf("banked candle misaggregated: %+v", c)
			}
		}
		// The current still-forming broker day must never be frozen.
		if c.Timestamp >= (now/day)*day {
			t.Fatalf("banked the still-forming day: %+v", c)
		}
	}
	if !found {
		t.Fatalf("expected a banked candle for %d, got %+v", oldBarDay, store.insertedDaily)
	}
}

// MT5's chart pages can overshoot the requested window BACKWARDS; a bucket
// assembled from that spill is a candle older than the caller asked for.
// Observed live as a weekly backfill for [Aug 16 → now] answering with an
// Aug 9 candle, which TradingView rejects on every replay.
func TestHistory1D_NeverAnswersBucketsBeforeTheRequestedWindow(t *testing.T) {
	const day = int64(86400)
	// Anchor on a Monday-00:00 UTC boundary so the weekly bucket of `from`
	// equals `from` itself (offset is 0 in this fake).
	monday := int64(1786924800) // 2026-08-17T00:00:00Z, a Monday
	from := monday
	to := monday + 3*day
	// The upstream answers with bars from BEFORE the requested window (the
	// page spill) plus bars inside it.
	client := &chartWindowClient{chartBody: fmt.Sprintf(
		`{"retcode":"0 Done","answer":[[%d,1.1,1.2,1.0,1.15],[%d,1.2,1.3,1.1,1.25]]}`,
		monday-3*day+3600, // Thursday of the PREVIOUS week
		monday+3600)}
	svc := NewTickService(client, nil, false)

	env := svc.GetHistoryBy1DResolution(context.Background(), "EURUSD", from, to, "1W")
	if !env.Success {
		t.Fatal("expected success")
	}
	bars, ok := env.Data.([]transform.TVTickResponse)
	if !ok || len(bars) == 0 {
		t.Fatalf("no bars: %#v", env.Data)
	}
	for _, b := range bars {
		if b.Time < from {
			t.Fatalf("answer contains bucket %d before the requested window start %d", b.Time, from)
		}
	}
}

// stallingClock hangs every upstream call until its release channel closes —
// the shape of the 2026-08-24 broker outage, where the farm's whitelist
// dropped this gateway's SYNs and every request rode the OS connect timeout.
type stallingClock struct {
	release chan struct{}
}

func (s *stallingClock) Get(ctx context.Context, _ string) ([]byte, error) {
	select {
	case <-s.release:
	case <-ctx.Done():
	}
	return nil, errors.New("upstream unreachable")
}
func (s *stallingClock) Post(ctx context.Context, _ string, _ []byte) ([]byte, error) {
	return s.Get(ctx, "")
}

// A caller holding a known-but-expired offset must be answered from the cache
// immediately, never behind a stalled upstream read. During the 2026-08-24
// outage this resolver blocked under brokerMu for the full connect timeout and
// queued getServerTime, deals, history and positions behind one dead read —
// the terminal's "chart never opens" was this line.
func TestExpiredBrokerOffsetIsServedStaleNotBehindAStalledUpstream(t *testing.T) {
	up := &stallingClock{release: make(chan struct{})}
	defer close(up.release)
	svc := NewTickService(up, nil, false)

	svc.brokerMu.Lock()
	svc.brokerOffset, svc.brokerHasOffset = 3*3600, true
	svc.brokerCached = 0 // TTL long expired
	svc.brokerMu.Unlock()

	done := make(chan int64, 1)
	go func() { done <- svc.brokerOffsetSeconds(context.Background(), "EURUSD") }()
	select {
	case got := <-done:
		if got != 10800 {
			t.Errorf("offset = %d, want the held 10800 served stale", got)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("brokerOffsetSeconds blocked behind a stalled upstream; the held offset must be served immediately")
	}
}
