package domain

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/nimadorostkar/TradePlatformDemo/backend/internal/transform"
)

// fakeStore is an in-memory PriceStore for tests.
type fakeStore struct {
	intraday      []Candle
	daily         []DailyCandle
	inserted      []Candle
	insertedDaily []DailyCandle
}

func (f *fakeStore) LatestTime(_ context.Context, _ string, _, _ int64) (int64, error) {
	return 0, nil
}
func (f *fakeStore) InsertCandles(_ context.Context, c []Candle) error {
	f.inserted = append(f.inserted, c...)
	return nil
}
func (f *fakeStore) DeleteOlderThan(_ context.Context, _ int64) error { return nil }
func (f *fakeStore) IntradayRange(_ context.Context, _ string, _, _ int64) ([]Candle, error) {
	return f.intraday, nil
}
func (f *fakeStore) DailyRange(_ context.Context, _ string, _, _ int64) ([]DailyCandle, error) {
	return f.daily, nil
}
func (f *fakeStore) AggregateDaily(_ context.Context, _, _ int64, _ []string) error { return nil }
func (f *fakeStore) InsertDailyCandles(_ context.Context, c []DailyCandle) error {
	f.insertedDaily = append(f.insertedDaily, c...)
	return nil
}
func (f *fakeStore) DistinctSymbols(_ context.Context) ([]string, error) { return nil, nil }

// With readFromDB=true, GetM1History syncs then returns DB intraday rows.
func TestGetM1History_DBPath(t *testing.T) {
	chart := `{"retcode":"0 Done","answer":[[1700,1.1,1.2,1.0,1.15]]}`
	store := &fakeStore{intraday: []Candle{{Time: 1700, Open: 1.1, High: 1.2, Low: 1.0, Close: 1.15}}}
	svc := NewTickService(&fakeClient{body: []byte(chart)}, store, true)

	env := svc.GetM1History(context.Background(), "EURUSD", 1600, 1800, "dhloc")
	if !env.Success {
		t.Fatal("expected success")
	}
	if len(store.inserted) != 1 {
		t.Errorf("expected 1 candle inserted from sync, got %d", len(store.inserted))
	}
	got := marshal(t, env)
	if !strings.Contains(got, `"time":1700`) || !strings.Contains(got, `"close":1.15`) {
		t.Errorf("DB rows not returned: %s", got)
	}
}

// ── Broker clock vs UTC ─────────────────────────────────────────────────────

// brokerClock is an MT5 whose clock runs `offset` ahead of UTC (Opogroup-Server1
// runs UTC+3). It stamps ticks in its own base, records the chart windows it is
// asked for, and answers each one with a single bar at the window's start — so a
// test can see both what the gateway asked for and what base it hands back.
type brokerClock struct {
	offset int64
	mu     sync.Mutex
	asked  [][2]int64
}

func (b *brokerClock) Get(_ context.Context, path string) ([]byte, error) {
	if strings.HasPrefix(path, "/api/tick/last") {
		return []byte(fmt.Sprintf(`{"retcode":"0 Done","answer":[{"Symbol":"XAUUSD","Datetime":"%d","Bid":1,"Ask":2,"Last":1,"Volume":1}]}`,
			time.Now().UTC().Unix()+b.offset)), nil
	}
	if strings.HasPrefix(path, "/api/chart/get") {
		var from, to int64
		var sym, data string
		_, _ = fmt.Sscanf(path, "/api/chart/get?symbol=%s", &sym)
		for _, part := range strings.Split(path[strings.Index(path, "?")+1:], "&") {
			var v int64
			if _, err := fmt.Sscanf(part, "from=%d", &v); err == nil {
				from = v
			}
			if _, err := fmt.Sscanf(part, "to=%d", &v); err == nil {
				to = v
			}
			_ = data
		}
		b.mu.Lock()
		b.asked = append(b.asked, [2]int64{from, to})
		b.mu.Unlock()
		return []byte(fmt.Sprintf(`{"retcode":"0 Done","answer":[[%d,1.0,2.0,0.5,1.5]]}`, from)), nil
	}
	return []byte(`{"retcode":"0 Done","answer":{}}`), nil
}

func (b *brokerClock) Post(_ context.Context, _ string, _ []byte) ([]byte, error) {
	return []byte(`{"retcode":"0 Done"}`), nil
}

func (b *brokerClock) lastWindow(t *testing.T) (from, to int64) {
	t.Helper()
	b.mu.Lock()
	defer b.mu.Unlock()
	if len(b.asked) == 0 {
		t.Fatal("no chart window was requested upstream")
	}
	w := b.asked[len(b.asked)-1]
	return w[0], w[1]
}

func barTimes(t *testing.T, env any) []int64 {
	t.Helper()
	resp, ok := env.([]transform.TVTickResponse)
	if !ok {
		t.Fatalf("data is %T, want chart bars", env)
	}
	out := make([]int64, 0, len(resp))
	for _, b := range resp {
		out = append(out, b.Time)
	}
	return out
}

// MT5 selects and stamps chart data on the broker's clock, so a UTC window must
// be shifted onto that clock before it is sent and the bars shifted back before
// they are returned. Sending UTC straight through fetched bars from `offset`
// seconds earlier and returned them stamped `offset` ahead.
func TestChartWindowIsTranslatedToBrokerTimeAndBack(t *testing.T) {
	const offset = 3 * 3600
	up := &brokerClock{offset: offset}
	svc := NewTickService(up, nil, false)

	utcNow := time.Now().UTC().Unix()
	fromUTC, toUTC := utcNow-600, utcNow

	env := svc.GetM1History(context.Background(), "XAUUSD", fromUTC, toUTC, "dhloc")
	if !env.Success {
		t.Fatalf("expected success, got %+v", env)
	}

	gotFrom, gotTo := up.lastWindow(t)
	if gotFrom != fromUTC+offset || gotTo != toUTC+offset {
		t.Errorf("upstream window = [%d,%d], want [%d,%d] (UTC + broker offset)",
			gotFrom, gotTo, fromUTC+offset, toUTC+offset)
	}

	times := barTimes(t, env.Data)
	if len(times) != 1 {
		t.Fatalf("want 1 bar, got %d", len(times))
	}
	if times[0] != fromUTC {
		t.Errorf("bar time = %d, want %d restated in UTC (off by %+ds)", times[0], fromUTC, times[0]-fromUTC)
	}
}

// The whole point: the live window and a historical window must land on the
// same clock. They used to differ by exactly the broker offset, which is the
// gap that opened in the chart on every login.
func TestLiveAndHistoricalWindowsShareOneClock(t *testing.T) {
	const offset = 3 * 3600
	up := &brokerClock{offset: offset}
	svc := NewTickService(up, nil, false)
	utcNow := time.Now().UTC().Unix()

	// The live subscription's from=0&to=1 trick.
	svc.GetM1History(context.Background(), "XAUUSD", 0, 1, "dhloc")
	_, liveTo := up.lastWindow(t)

	// A history request for the same instant.
	svc.GetM1History(context.Background(), "XAUUSD", utcNow-600, utcNow, "dhloc")
	_, histTo := up.lastWindow(t)

	if drift := liveTo - histTo; drift < -2 || drift > 2 {
		t.Errorf("live window ends %+ds from the historical window; they must share one clock", drift)
	}
}

// An unreadable clock falls back to EEST rather than to "no offset". Returning
// zero would leave the chart three hours stale against this broker, which is
// the failure the fallback exists to avoid. (Matches the .NET resolver.)
func TestBrokerOffsetFallsBackToEEST(t *testing.T) {
	svc := NewTickService(&fakeClient{body: []byte(`{"retcode":"0 Done","answer":[]}`)}, nil, false)
	if got := svc.brokerOffsetSeconds(context.Background(), "EURUSD"); got != defaultBrokerOffset {
		t.Errorf("offset = %d, want the EEST fallback %d", got, defaultBrokerOffset)
	}
}

// The offset is measured from the last tick, which on an illiquid or closed
// symbol may be many minutes old. Rounding to the whole hour recovers the true
// timezone instead of enshrining the staleness — the reason the .NET service
// rounds to the hour rather than to something finer.
func TestBrokerOffsetRoundsToWholeHour(t *testing.T) {
	cases := map[int64]int64{
		10800:  10800, // exact
		10793:  10800, // tick printed 7s ago
		9900:   10800, // tick 15 minutes stale
		9060:   10800, // tick 29 minutes stale
		7200:   7200,  // genuinely UTC+2 (EET, winter)
		-3600:  -3600, // a broker behind UTC
		-3593:  -3600,
		0:      0,
		604800: 604800, // absurd, but rounding is not where that is caught
	}
	for in, want := range cases {
		if got := roundToHour(in); got != want {
			t.Errorf("roundToHour(%d) = %d, want %d", in, got, want)
		}
	}

	up := &brokerClock{offset: 10800 - 900} // last tick 15 minutes old
	svc := NewTickService(up, nil, false)
	if got := svc.brokerOffsetSeconds(context.Background(), "XAUUSD"); got != 10800 {
		t.Errorf("brokerOffsetSeconds = %d, want 10800 recovered from a stale tick", got)
	}
}

// A bogus tick must not throw the chart across the world: an offset no trade
// server could have is rejected and the last known good value kept.
func TestImplausibleBrokerOffsetIsRejected(t *testing.T) {
	up := &brokerClock{offset: 3 * 3600}
	svc := NewTickService(up, nil, false)
	if got := svc.brokerOffsetSeconds(context.Background(), "XAUUSD"); got != 10800 {
		t.Fatalf("setup: offset = %d, want 10800", got)
	}

	// The broker now reports a wild timestamp, and the cache has expired.
	up.offset = 40 * 3600
	svc.brokerMu.Lock()
	svc.brokerCached = 0
	svc.brokerMu.Unlock()

	if got := svc.brokerOffsetSeconds(context.Background(), "XAUUSD"); got != 10800 {
		t.Errorf("offset = %d, want the last known 10800 kept", got)
	}
}

// The offset cache is global and refreshed by whatever symbol lapses the TTL —
// including closed markets whose last tick is hours old. A tick is stamped in
// the broker's past, never its future, so a LOWER reading is staleness, not a
// clock change: it must not drag the clock down while the held value is still
// being confirmed. (Observed live: a Hong Kong stock closed all day resolved
// the global offset to −14h and shifted every chart on the terminal.)
func TestStaleSymbolCannotDragTheBrokerClockDown(t *testing.T) {
	up := &brokerClock{offset: 3 * 3600}
	svc := NewTickService(up, nil, false)
	if got := svc.brokerOffsetSeconds(context.Background(), "EURUSD"); got != 10800 {
		t.Fatalf("setup: offset = %d, want 10800", got)
	}

	// A symbol whose market closed 3h ago reads as offset 0; the TTL lapsed.
	up.offset = 0
	svc.brokerMu.Lock()
	svc.brokerCached = 0
	svc.brokerMu.Unlock()

	if got := svc.brokerOffsetSeconds(context.Background(), "CTPCF.HK"); got != 10800 {
		t.Errorf("offset = %d, want the held 10800: a lower reading is a stale tick", got)
	}
}

// A HIGHER reading can only come from a fresher tick, so it is better evidence
// and is adopted at once — this is also what recovers a cold start that first
// read a stale symbol.
func TestFresherReadingRaisesTheBrokerClockImmediately(t *testing.T) {
	up := &brokerClock{offset: 0} // first reading from a 3h-stale symbol
	svc := NewTickService(up, nil, false)
	if got := svc.brokerOffsetSeconds(context.Background(), "CTPCF.HK"); got != 0 {
		t.Fatalf("setup: offset = %d, want 0 adopted on cold start", got)
	}

	up.offset = 3 * 3600 // a live symbol ticks
	svc.brokerMu.Lock()
	svc.brokerCached = 0
	svc.brokerMu.Unlock()

	// An expired-but-known offset is served as held — never awaited — so the
	// call after expiry still answers with the old value while the refresh
	// happens off the request path (the 2026-08-24 outage queue was exactly
	// this resolver blocking under its mutex).
	if got := svc.brokerOffsetSeconds(context.Background(), "EURUSD"); got != 0 {
		t.Errorf("offset = %d, want the held 0 served stale while revalidating", got)
	}
	svc.refreshBrokerOffset("EURUSD") // the background refresh, run to completion
	if got := svc.brokerOffsetSeconds(context.Background(), "EURUSD"); got != 10800 {
		t.Errorf("offset = %d, want 10800 adopted from the fresher tick after refresh", got)
	}
}

// A genuine server timezone/DST change reads lower and must still land — after
// the held value has gone unconfirmed for the re-anchor window.
func TestUnconfirmedBrokerClockReanchorsDownward(t *testing.T) {
	up := &brokerClock{offset: 3 * 3600}
	svc := NewTickService(up, nil, false)
	if got := svc.brokerOffsetSeconds(context.Background(), "EURUSD"); got != 10800 {
		t.Fatalf("setup: offset = %d, want 10800", got)
	}

	// The server moved to UTC+2 and nothing has confirmed +3 for over a day.
	up.offset = 2 * 3600
	svc.brokerMu.Lock()
	svc.brokerCached = 0
	svc.brokerConfirmedAt = time.Now().UTC().Unix() - brokerReanchorWindow - 1
	svc.brokerMu.Unlock()

	// Stale-while-revalidate: the held value answers this call, and the
	// re-anchor lands through the off-path refresh.
	if got := svc.brokerOffsetSeconds(context.Background(), "EURUSD"); got != 10800 {
		t.Errorf("offset = %d, want the held 10800 served while revalidating", got)
	}
	svc.refreshBrokerOffset("EURUSD")
	if got := svc.brokerOffsetSeconds(context.Background(), "EURUSD"); got != 7200 {
		t.Errorf("offset = %d, want 7200 re-anchored after the window", got)
	}
}

// The broker publishes millisecond precision when it has it; prefer that field
// over whole seconds, as the .NET resolver does.
func TestBrokerClockPrefersMillisecondField(t *testing.T) {
	utc := time.Now().UTC().Unix()
	body := fmt.Sprintf(`{"retcode":"0 Done","answer":[{"Symbol":"EURUSD","Datetime":"%d","DatetimeMsc":"%d000"}]}`,
		utc, utc+3*3600)
	svc := NewTickService(&fakeClient{body: []byte(body)}, nil, false)
	if got := svc.brokerOffsetSeconds(context.Background(), "EURUSD"); got != 10800 {
		t.Errorf("offset = %d, want 10800 read from DatetimeMsc", got)
	}
}

// A quote with no timestamp cannot be placed on the chart's axis, so a client
// has to invent one from its own clock — which is how a tick-driven forming
// candle drifts away from the bars underneath it. The quote carries the
// broker's own print time, restated in UTC like every bar.
func TestQuoteCarriesBrokerTickTimeInUTC(t *testing.T) {
	utcNow := time.Now().UTC().Unix()
	up := &brokerClock{offset: 3 * 3600}
	svc := NewTickService(up, nil, false)

	env := svc.GetQuotes(context.Background(), "XAUUSD", 1, SourceTV)
	if !env.Success {
		t.Fatalf("expected success, got %+v", env)
	}
	quotes, ok := env.Data.([]transform.Quote)
	if !ok || len(quotes) == 0 {
		t.Fatalf("data = %T, want quotes", env.Data)
	}
	if drift := quotes[0].Time - utcNow; drift < -5 || drift > 5 {
		t.Errorf("quote time is %+ds from UTC now; it must be UTC, not broker time", drift)
	}
}

// The quote push is the hottest path in the gateway. It already fetches the
// tick that carries the broker's clock, so resolving the offset must not fetch
// it a second time — that would double upstream load on every symbol, every
// push, against a single shared MT5 connection.
func TestQuotePathMakesOneUpstreamCall(t *testing.T) {
	up := &countingTicks{offset: 3 * 3600}
	svc := NewTickService(up, nil, false)

	for i := 0; i < 5; i++ {
		svc.GetQuotes(context.Background(), "XAUUSD", 1, SourceTV)
	}
	if got := up.calls(); got != 5 {
		t.Errorf("%d upstream calls for 5 quote pushes, want 5", got)
	}
}

// countingTicks counts every upstream request and always answers with a tick.
type countingTicks struct {
	offset int64
	mu     sync.Mutex
	n      int
}

func (c *countingTicks) Get(_ context.Context, _ string) ([]byte, error) {
	c.mu.Lock()
	c.n++
	c.mu.Unlock()
	return []byte(fmt.Sprintf(`{"retcode":"0 Done","answer":[{"Symbol":"XAUUSD","Datetime":"%d","Bid":1,"Ask":2,"Last":1,"Volume":1}]}`,
		time.Now().UTC().Unix()+c.offset)), nil
}

func (c *countingTicks) Post(_ context.Context, _ string, _ []byte) ([]byte, error) {
	return []byte(`{"retcode":"0 Done"}`), nil
}

func (c *countingTicks) calls() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.n
}

// The live window must be able to heal a hole. A client that missed pushes says
// where it left off and gets everything since; one that says nothing gets the
// default lookback; and nobody gets to ask MT5 for a year of minutes.
func TestLiveChartWindowBackfillsAndIsBounded(t *testing.T) {
	utcNow := time.Now().UTC().Unix()
	cases := []struct {
		name     string
		from, to int64
		wantSpan int64
	}{
		{name: "live edge only", from: 0, to: 1, wantSpan: liveChartLookback},
		{name: "client backfills its hole", from: utcNow - 1800, to: 1, wantSpan: 1800},
		{name: "absurd backfill is capped", from: utcNow - 400*24*3600, to: 1, wantSpan: maxLiveChartLookback},
		{name: "from in the future falls back to the default", from: utcNow + 9999, to: 1, wantSpan: liveChartLookback},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			up := &brokerClock{offset: 3 * 3600}
			svc := NewTickService(up, nil, false)

			svc.GetM1History(context.Background(), "XAUUSD", tc.from, tc.to, "dhloc")
			gotFrom, gotTo := up.lastWindow(t)

			if span := gotTo - gotFrom; span != tc.wantSpan {
				t.Errorf("window span = %ds, want %ds", span, tc.wantSpan)
			}
			// Whatever the span, the window still ends at the broker's "now".
			if drift := gotTo - (utcNow + 3*3600); drift < -5 || drift > 5 {
				t.Errorf("window ends %+ds from broker now", drift)
			}
		})
	}
}

// An explicit historical window is not the live sentinel and must be left alone.
func TestExplicitWindowIsNotTreatedAsLive(t *testing.T) {
	up := &brokerClock{offset: 3 * 3600}
	svc := NewTickService(up, nil, false)

	from, to := int64(1700000000), int64(1700003600)
	svc.GetM1History(context.Background(), "XAUUSD", from, to, "dhloc")
	gotFrom, gotTo := up.lastWindow(t)
	if gotFrom != from+3*3600 || gotTo != to+3*3600 {
		t.Errorf("window = [%d,%d], want the client's own window shifted onto the broker clock", gotFrom, gotTo)
	}
}

// Daily and weekly candles are cut on the broker's calendar. Bucketing the UTC
// stamps directly would move every one of them by the broker offset.
func TestDailyBucketsFollowTheBrokerCalendar(t *testing.T) {
	const offset = 3 * 3600
	up := &brokerClock{offset: offset}
	svc := NewTickService(up, nil, false)

	// A bar just after the broker's midnight, which is still the previous UTC day.
	brokerMidnight := time.Date(2026, 8, 6, 0, 0, 0, 0, time.UTC).Unix()
	barUTC := brokerMidnight - offset + 60

	env := svc.GetHistoryBy1DResolution(context.Background(), "XAUUSD", barUTC, barUTC+60, "1D")
	times := barTimes(t, env.Data)
	if len(times) != 1 {
		t.Fatalf("want 1 bucket, got %d", len(times))
	}
	if want := brokerMidnight - offset; times[0] != want {
		t.Errorf("bucket start = %d, want %d (broker midnight, restated in UTC)", times[0], want)
	}
}

// GetHistoryBy1DResolution folds in the store's pre-aggregated daily rows.
func TestGetHistory1D_MergesDaily(t *testing.T) {
	chart := `{"retcode":"0 Done","answer":[]}`
	day := int64(1700000000)
	store := &fakeStore{daily: []DailyCandle{{Timestamp: day, Open: 2, High: 3, Low: 1, Close: 2.5}}}
	svc := NewTickService(&fakeClient{body: []byte(chart)}, store, false)

	env := svc.GetHistoryBy1DResolution(context.Background(), "EURUSD", day-100, day+100, "1D")
	got := marshal(t, env)
	if !strings.Contains(got, `"open":2`) || !strings.Contains(got, `"close":2.5`) {
		t.Errorf("daily DB rows not merged: %s", got)
	}
}

// A daily candle is a trading day. Aggregating on UTC midnight instead of the
// broker's would open each row three hours into the session and carry the tail
// of the previous one — and because the aggregate is folded into 1D/1W/1M
// responses before the live bars, its wrong open would win the bucket.
func TestDailyAggregationCutsOnTheBrokerDay(t *testing.T) {
	store := &windowRecordingStore{symbols: []string{"XAUUSD"}}
	svc := NewTickService(&brokerClock{offset: 3 * 3600}, store, false)

	// 2026-08-06 12:00 UTC — the job aggregates the day before.
	day := time.Date(2026, 8, 6, 12, 0, 0, 0, time.UTC)
	if err := svc.AggregateDaily(context.Background(), day); err != nil {
		t.Fatalf("aggregate: %v", err)
	}

	// The broker day before is 2026-08-05 00:00 broker = 2026-08-04 21:00 UTC.
	wantStart := time.Date(2026, 8, 4, 21, 0, 0, 0, time.UTC).Unix()
	if store.start != wantStart {
		t.Errorf("start = %s, want broker midnight %s",
			time.Unix(store.start, 0).UTC(), time.Unix(wantStart, 0).UTC())
	}
	if span := store.end - store.start; span != 24*3600-1 {
		t.Errorf("span = %ds, want a day minus the next day's opening bar", span)
	}
}

// windowRecordingStore captures the window the daily aggregation asks for.
type windowRecordingStore struct {
	PriceStore
	symbols    []string
	start, end int64
}

func (w *windowRecordingStore) DistinctSymbols(context.Context) ([]string, error) {
	return w.symbols, nil
}

func (w *windowRecordingStore) AggregateDaily(_ context.Context, start, end int64, _ []string) error {
	w.start, w.end = start, end
	return nil
}
