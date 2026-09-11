package main

// Real market data from Yahoo Finance's public chart endpoints — no account,
// no key, no credential. Three request shapes are used:
//
//   - spark  : ONE request every few seconds for every instrument's latest
//              minute closes → live prices (FX and crypto are real-time there;
//              gold futures are exchange-delayed, said so in its description);
//   - chart  : true OHLC bars for a window, at the finest granularity Yahoo
//              serves for that window (1m ≤ 7 d, 5m ≤ 60 d, 1h ≤ 730 d, else 1d);
//   - recent : the last few hours of 1m OHLC for a symbol a chart is showing,
//              refreshed at most every 20 s and kept moving between refreshes
//              by the spark ticks.
//
// Everything is cached and every failure serves the last good answer, with
// exponential backoff so a rate limit never turns into a request storm. There
// is deliberately NO synthetic fallback in this provider: a chart shows real
// bars or says it has none.

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	yahooBase        = "https://query1.finance.yahoo.com"
	sparkEvery       = 3 * time.Second
	recentTTL        = 20 * time.Second
	recentSpan       = 6 * time.Hour
	historyTTL       = 90 * time.Second
	maxBackoff       = 2 * time.Minute
	userAgent        = "Mozilla/5.0 (compatible; TradePlatformDemo/1.0)"
	yahooHTTPTimeout = 15 * time.Second
)

type yahooProvider struct {
	client *http.Client

	mu          sync.Mutex
	ticks       map[string]Tick      // by instrument symbol
	recent      map[string]recentM1  // by instrument symbol
	history     map[string]histEntry // by cache key
	backoff     time.Duration
	pausedUntil time.Time
}

type recentM1 struct {
	bars      []Bar
	fetchedAt time.Time
}

type histEntry struct {
	bars      []Bar
	fetchedAt time.Time
}

func newYahooProvider() *yahooProvider {
	return &yahooProvider{
		client:  &http.Client{Timeout: yahooHTTPTimeout},
		ticks:   map[string]Tick{},
		recent:  map[string]recentM1{},
		history: map[string]histEntry{},
	}
}

func (y *yahooProvider) Name() string { return "yahoo-finance" }

// Start begins the live price poll; it returns once the first poll completed
// (successfully or not) so callers can log the initial state.
func (y *yahooProvider) Start(ctx context.Context) {
	y.pollSpark()
	go func() {
		t := time.NewTicker(sparkEvery)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				y.pollSpark()
			}
		}
	}()
}

// ── HTTP with backoff ───────────────────────────────────────────────────────

func (y *yahooProvider) get(path string, query url.Values) ([]byte, error) {
	y.mu.Lock()
	paused := time.Now().Before(y.pausedUntil)
	y.mu.Unlock()
	if paused {
		return nil, fmt.Errorf("backing off after an upstream error")
	}
	req, err := http.NewRequest(http.MethodGet, yahooBase+path+"?"+query.Encode(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("Accept", "application/json")
	resp, err := y.client.Do(req)
	if err != nil {
		y.fail(err)
		return nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		y.fail(err)
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		err := fmt.Errorf("yahoo %s: HTTP %d", path, resp.StatusCode)
		y.fail(err)
		return nil, err
	}
	y.mu.Lock()
	y.backoff = 0
	y.mu.Unlock()
	return body, nil
}

func (y *yahooProvider) fail(err error) {
	y.mu.Lock()
	defer y.mu.Unlock()
	if y.backoff == 0 {
		y.backoff = 5 * time.Second
	} else if y.backoff < maxBackoff {
		y.backoff *= 2
	}
	y.pausedUntil = time.Now().Add(y.backoff)
	log.Printf("yahoo: %v — pausing requests for %s, serving cached data", err, y.backoff)
}

// ── Live prices ─────────────────────────────────────────────────────────────

type sparkSeries struct {
	Timestamp []int64    `json:"timestamp"`
	Close     []*float64 `json:"close"`
}

func (y *yahooProvider) pollSpark() {
	y.spark(instruments, "15m", "1m")

	// A process started while a market is closed — Friday evening, the
	// weekend, a holiday — sees an EMPTY 15-minute window for it and would
	// otherwise carry no price at all until the next session: every quote
	// blank, every order "10021 No quotes". The last close of the past week
	// is the right price to show and to fill demo orders at until then.
	var unpriced []*instrument
	y.mu.Lock()
	for _, ins := range instruments {
		if _, ok := y.ticks[ins.Symbol]; !ok {
			unpriced = append(unpriced, ins)
		}
	}
	y.mu.Unlock()
	if len(unpriced) > 0 {
		y.spark(unpriced, "5d", "15m")
		y.mu.Lock()
		for _, ins := range unpriced {
			if t, ok := y.ticks[ins.Symbol]; ok {
				log.Printf("yahoo: %s has no price in the last 15 minutes; using the last close %s from %s", ins.Symbol, ftoa(t.Bid, ins.Digits), time.Unix(t.Minute, 0).UTC().Format(time.RFC3339))
			} else {
				log.Printf("yahoo: %s has no price in the last 5 days", ins.Symbol)
			}
		}
		y.mu.Unlock()
	}
}

// spark refreshes the latest price of the given instruments from the spark
// endpoint over one range/interval, keeping whatever it already had for an
// instrument the answer leaves blank.
func (y *yahooProvider) spark(list []*instrument, rng, interval string) {
	symbols := make([]string, 0, len(list))
	for _, ins := range list {
		symbols = append(symbols, ins.Yahoo)
	}
	body, err := y.get("/v8/finance/spark", url.Values{
		"symbols":  {strings.Join(symbols, ",")},
		"range":    {rng},
		"interval": {interval},
	})
	if err != nil {
		return
	}
	var parsed map[string]sparkSeries
	if err := json.Unmarshal(body, &parsed); err != nil {
		log.Printf("yahoo: spark parse: %v", err)
		return
	}
	now := time.Now()
	y.mu.Lock()
	defer y.mu.Unlock()
	for _, ins := range list {
		series, ok := parsed[ins.Yahoo]
		if !ok {
			continue
		}
		// Latest non-null close and its minute.
		for i := len(series.Close) - 1; i >= 0; i-- {
			if series.Close[i] == nil || i >= len(series.Timestamp) {
				continue
			}
			price := *series.Close[i]
			bid, ask := ins.spread(price)
			y.ticks[ins.Symbol] = Tick{Bid: bid, Ask: ask, At: now, Minute: series.Timestamp[i] - series.Timestamp[i]%60}
			// Keep the forming minute of the recent-bars cache moving.
			y.applyTickLocked(ins, series.Timestamp[i], price)
			break
		}
	}
}

func (y *yahooProvider) applyTickLocked(ins *instrument, minute int64, price float64) {
	rc, ok := y.recent[ins.Symbol]
	if !ok || len(rc.bars) == 0 {
		return
	}
	minute -= minute % 60
	last := &rc.bars[len(rc.bars)-1]
	switch {
	case minute == last.Time:
		last.Close = price
		if price > last.High {
			last.High = price
		}
		if price < last.Low {
			last.Low = price
		}
	case minute > last.Time:
		rc.bars = append(rc.bars, Bar{Time: minute, Open: price, High: price, Low: price, Close: price})
		if len(rc.bars) > int(recentSpan/time.Minute) {
			rc.bars = rc.bars[1:]
		}
	}
	y.recent[ins.Symbol] = rc
}

func (y *yahooProvider) Tick(ins *instrument) (Tick, bool) {
	y.mu.Lock()
	defer y.mu.Unlock()
	t, ok := y.ticks[ins.Symbol]
	return t, ok
}

// ── Bars ────────────────────────────────────────────────────────────────────

type chartResponse struct {
	Chart struct {
		Result []struct {
			Timestamp  []int64 `json:"timestamp"`
			Indicators struct {
				Quote []struct {
					Open   []*float64 `json:"open"`
					High   []*float64 `json:"high"`
					Low    []*float64 `json:"low"`
					Close  []*float64 `json:"close"`
					Volume []*float64 `json:"volume"`
				} `json:"quote"`
			} `json:"indicators"`
		} `json:"result"`
		Error *struct {
			Description string `json:"description"`
		} `json:"error"`
	} `json:"chart"`
}

func (y *yahooProvider) fetchChart(ins *instrument, interval string, from, to int64) ([]Bar, error) {
	body, err := y.get("/v8/finance/chart/"+url.PathEscape(ins.Yahoo), url.Values{
		"interval": {interval},
		"period1":  {fmt.Sprint(from)},
		"period2":  {fmt.Sprint(to)},
	})
	if err != nil {
		return nil, err
	}
	var parsed chartResponse
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, err
	}
	if parsed.Chart.Error != nil {
		return nil, fmt.Errorf("yahoo chart %s: %s", ins.Yahoo, parsed.Chart.Error.Description)
	}
	if len(parsed.Chart.Result) == 0 || len(parsed.Chart.Result[0].Indicators.Quote) == 0 {
		return nil, nil
	}
	res := parsed.Chart.Result[0]
	q := res.Indicators.Quote[0]
	// Yahoo stamps the forming bar with its last trade time, not its bucket
	// start; intraday bars are aligned here (daily ones keep the session
	// start Yahoo gives them). Two rows landing in one bucket are merged.
	var step int64
	switch interval {
	case "1m":
		step = 60
	case "5m":
		step = 300
	case "1h":
		step = 3600
	}
	bars := make([]Bar, 0, len(res.Timestamp))
	for i, ts := range res.Timestamp {
		if i >= len(q.Open) || q.Open[i] == nil || q.High[i] == nil || q.Low[i] == nil || q.Close[i] == nil {
			continue
		}
		if step > 0 {
			ts -= ts % step
		}
		if n := len(bars); n > 0 && bars[n-1].Time == ts {
			last := &bars[n-1]
			last.High = math.Max(last.High, ins.round(*q.High[i]))
			last.Low = math.Min(last.Low, ins.round(*q.Low[i]))
			last.Close = ins.round(*q.Close[i])
			if i < len(q.Volume) && q.Volume[i] != nil {
				last.Volume += int64(*q.Volume[i])
			}
			continue
		}
		bar := Bar{
			Time:  ts,
			Open:  ins.round(*q.Open[i]),
			High:  ins.round(*q.High[i]),
			Low:   ins.round(*q.Low[i]),
			Close: ins.round(*q.Close[i]),
		}
		if i < len(q.Volume) && q.Volume[i] != nil {
			bar.Volume = int64(*q.Volume[i])
		}
		bars = append(bars, bar)
	}
	sort.Slice(bars, func(a, b int) bool { return bars[a].Time < bars[b].Time })
	return bars, nil
}

// granularity picks the finest interval Yahoo serves for the window: 1m only
// within the last 30 days and 7 days per request, 5m within 60 days, 1h
// within 730 days, daily beyond.
func granularity(from, to int64) (interval string, step int64) {
	age := time.Now().Unix() - from
	span := to - from
	switch {
	case age <= 29*86400 && span <= 7*86400:
		return "1m", 60
	case age <= 59*86400 && span <= 60*86400:
		return "5m", 300
	case age <= 729*86400:
		return "1h", 3600
	default:
		return "1d", 86400
	}
}

func (y *yahooProvider) Bars(ins *instrument, from, to int64) []Bar {
	now := time.Now().Unix()
	if to > now {
		to = now
	}
	if from >= to {
		return nil
	}
	// A short window ending now is a live chart: serve the moving recent cache.
	if to >= now-120 && to-from <= int64(recentSpan/time.Second) {
		return y.recentBars(ins, from, to)
	}
	interval, step := granularity(from, to)
	key := fmt.Sprintf("%s|%s|%d|%d", ins.Symbol, interval, from/step, to/step)
	y.mu.Lock()
	entry, ok := y.history[key]
	y.mu.Unlock()
	if ok && time.Since(entry.fetchedAt) < historyTTL {
		return entry.bars
	}
	bars, err := y.fetchChart(ins, interval, from, to)
	if err != nil {
		if ok {
			return entry.bars
		}
		return nil
	}
	y.mu.Lock()
	y.history[key] = histEntry{bars: bars, fetchedAt: time.Now()}
	if len(y.history) > 512 {
		for k, e := range y.history {
			if time.Since(e.fetchedAt) > historyTTL {
				delete(y.history, k)
			}
		}
	}
	y.mu.Unlock()
	return bars
}

func (y *yahooProvider) recentBars(ins *instrument, from, to int64) []Bar {
	y.mu.Lock()
	rc, ok := y.recent[ins.Symbol]
	stale := !ok || time.Since(rc.fetchedAt) >= recentTTL
	y.mu.Unlock()
	if stale {
		now := time.Now().Unix()
		bars, err := y.fetchChart(ins, "1m", now-int64(recentSpan/time.Second), now)
		if err == nil && len(bars) > 0 {
			y.mu.Lock()
			// Merge rather than replace: Yahoo's FX minutes carry one quote each
			// (O=H=L=C), while our tick sampling has seen the real range inside
			// the minutes we watched. Keep the widest high/low for any minute
			// both sides know; Yahoo's open and close stay authoritative.
			if prev, ok := y.recent[ins.Symbol]; ok {
				seen := make(map[int64]Bar, len(prev.bars))
				for _, b := range prev.bars {
					seen[b.Time] = b
				}
				for i := range bars {
					if b, ok := seen[bars[i].Time]; ok {
						bars[i].High = math.Max(bars[i].High, b.High)
						bars[i].Low = math.Min(bars[i].Low, b.Low)
					}
				}
			}
			y.recent[ins.Symbol] = recentM1{bars: bars, fetchedAt: time.Now()}
			// The very latest tick may be newer than the fetched bars.
			if t, ok := y.ticks[ins.Symbol]; ok {
				mid := (t.Bid + t.Ask) / 2
				y.applyTickLocked(ins, t.Minute, ins.round(mid))
			}
			y.mu.Unlock()
		} else if !ok {
			return nil
		}
	}
	y.mu.Lock()
	defer y.mu.Unlock()
	rc = y.recent[ins.Symbol]
	out := make([]Bar, 0, len(rc.bars))
	for _, b := range rc.bars {
		if b.Time >= from-59 && b.Time <= to {
			out = append(out, b)
		}
	}
	return out
}
