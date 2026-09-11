package main

// Tick-level crypto from Binance's public market-data API — no account, no
// key. The combined WebSocket stream delivers every best bid/ask change
// (bookTicker) and the forming one-minute candle (kline_1m); REST klines give
// history at the finest interval that fits one request. Binance is not
// reachable from every network; a symbol that has no fresh Binance data falls
// back to the Yahoo provider (see compositeProvider), so the terminal keeps
// working — just at Yahoo's slower cadence.

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

const (
	binanceREST      = "https://api.binance.com"
	binanceStream    = "wss://stream.binance.com:9443/stream"
	binanceFresh     = 30 * time.Second // a tick older than this is not "live"
	binanceRecentTTL = 20 * time.Second
	binanceHistTTL   = 90 * time.Second
	binanceMaxRows   = 1000
)

type binanceProvider struct {
	client *http.Client

	mu      sync.Mutex
	ticks   map[string]Tick      // by instrument symbol
	forming map[string]Bar       // the kline_1m in progress, by symbol
	recent  map[string]recentM1  // by symbol
	history map[string]histEntry // by cache key
	backoff time.Duration
	paused  time.Time
	symbols []*instrument
}

func newBinanceProvider(symbols []*instrument) *binanceProvider {
	return &binanceProvider{
		client:  &http.Client{Timeout: 15 * time.Second},
		ticks:   map[string]Tick{},
		forming: map[string]Bar{},
		recent:  map[string]recentM1{},
		history: map[string]histEntry{},
		symbols: symbols,
	}
}

func (b *binanceProvider) Name() string { return "binance" }

// Start runs the stream in the background, reconnecting with backoff.
func (b *binanceProvider) Start(ctx context.Context) {
	if len(b.symbols) == 0 {
		return
	}
	go func() {
		delay := 2 * time.Second
		for {
			err := b.stream(ctx)
			if ctx.Err() != nil {
				return
			}
			log.Printf("binance: stream ended: %v — reconnecting in %s", err, delay)
			select {
			case <-ctx.Done():
				return
			case <-time.After(delay):
			}
			if delay < time.Minute {
				delay *= 2
			}
		}
	}()
}

type streamEnvelope struct {
	Stream string          `json:"stream"`
	Data   json.RawMessage `json:"data"`
}

// Binance uses lower/upper-case pairs of keys ("b" bid price, "B" bid qty;
// "t" open time, "T" close time). encoding/json matches keys case-
// insensitively when no exact field exists, so every such sibling is declared
// explicitly — otherwise "B" lands in Bid and "T" in Start.
type bookTicker struct {
	Symbol string `json:"s"`
	Bid    string `json:"b"`
	BidQty string `json:"B"`
	Ask    string `json:"a"`
	AskQty string `json:"A"`
}

type klineEvent struct {
	Symbol string `json:"s"`
	Kline  struct {
		Start       int64  `json:"t"`
		End         int64  `json:"T"`
		Open        string `json:"o"`
		High        string `json:"h"`
		Low         string `json:"l"`
		Close       string `json:"c"`
		Volume      string `json:"v"`
		QuoteVolume string `json:"q"`
		Trades      int64  `json:"n"`
		TakerBase   string `json:"V"`
		TakerQuote  string `json:"Q"`
		Ignore      string `json:"B"`
	} `json:"k"`
}

func (b *binanceProvider) stream(ctx context.Context) error {
	names := make([]string, 0, 2*len(b.symbols))
	byPair := make(map[string]*instrument, len(b.symbols))
	for _, ins := range b.symbols {
		pair := strings.ToLower(ins.Binance)
		byPair[strings.ToUpper(pair)] = ins
		names = append(names, pair+"@bookTicker", pair+"@kline_1m")
	}
	conn, _, err := websocket.Dial(ctx, binanceStream+"?streams="+strings.Join(names, "/"), nil)
	if err != nil {
		return err
	}
	defer conn.Close(websocket.StatusNormalClosure, "")
	conn.SetReadLimit(1 << 20)
	log.Printf("binance: streaming %d pairs", len(b.symbols))
	for {
		_, msg, err := conn.Read(ctx)
		if err != nil {
			return err
		}
		var env streamEnvelope
		if err := json.Unmarshal(msg, &env); err != nil {
			continue
		}
		switch {
		case strings.HasSuffix(env.Stream, "@bookTicker"):
			var t bookTicker
			if json.Unmarshal(env.Data, &t) != nil {
				continue
			}
			ins := byPair[t.Symbol]
			bid, err1 := strconv.ParseFloat(t.Bid, 64)
			ask, err2 := strconv.ParseFloat(t.Ask, 64)
			if ins == nil || err1 != nil || err2 != nil || bid <= 0 || ask <= 0 {
				continue
			}
			now := time.Now()
			b.mu.Lock()
			b.ticks[ins.Symbol] = Tick{Bid: ins.round(bid), Ask: ins.round(ask), At: now, Minute: now.Unix() - now.Unix()%60}
			b.mu.Unlock()
		case strings.HasSuffix(env.Stream, "@kline_1m"):
			var k klineEvent
			if json.Unmarshal(env.Data, &k) != nil {
				continue
			}
			ins := byPair[k.Symbol]
			if ins == nil {
				continue
			}
			bar, ok := parseKline(ins, k.Kline.Start/1000, k.Kline.Open, k.Kline.High, k.Kline.Low, k.Kline.Close, k.Kline.Volume)
			if !ok {
				continue
			}
			b.mu.Lock()
			b.forming[ins.Symbol] = bar
			b.mu.Unlock()
		}
	}
}

func parseKline(ins *instrument, start int64, o, h, l, c, v string) (Bar, bool) {
	fo, e1 := strconv.ParseFloat(o, 64)
	fh, e2 := strconv.ParseFloat(h, 64)
	fl, e3 := strconv.ParseFloat(l, 64)
	fc, e4 := strconv.ParseFloat(c, 64)
	fv, _ := strconv.ParseFloat(v, 64)
	if e1 != nil || e2 != nil || e3 != nil || e4 != nil {
		return Bar{}, false
	}
	return Bar{Time: start, Open: ins.round(fo), High: ins.round(fh), Low: ins.round(fl), Close: ins.round(fc), Volume: int64(fv)}, true
}

// Tick reports only FRESH stream data; anything older means the stream is
// down and the composite provider should ask Yahoo instead.
func (b *binanceProvider) Tick(ins *instrument) (Tick, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	t, ok := b.ticks[ins.Symbol]
	if !ok || time.Since(t.At) > binanceFresh {
		return Tick{}, false
	}
	return t, true
}

// ── REST history ────────────────────────────────────────────────────────────

func (b *binanceProvider) get(path string, query url.Values) ([]byte, error) {
	b.mu.Lock()
	paused := time.Now().Before(b.paused)
	b.mu.Unlock()
	if paused {
		return nil, fmt.Errorf("backing off after an upstream error")
	}
	resp, err := b.client.Get(binanceREST + path + "?" + query.Encode())
	if err != nil {
		b.fail(err)
		return nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil || resp.StatusCode != http.StatusOK {
		if err == nil {
			err = fmt.Errorf("binance %s: HTTP %d", path, resp.StatusCode)
		}
		b.fail(err)
		return nil, err
	}
	b.mu.Lock()
	b.backoff = 0
	b.mu.Unlock()
	return body, nil
}

func (b *binanceProvider) fail(err error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.backoff == 0 {
		b.backoff = 5 * time.Second
	} else if b.backoff < maxBackoff {
		b.backoff *= 2
	}
	b.paused = time.Now().Add(b.backoff)
	log.Printf("binance: %v — pausing REST for %s", err, b.backoff)
}

var binanceIntervals = []struct {
	name string
	secs int64
}{{"1m", 60}, {"5m", 300}, {"15m", 900}, {"1h", 3600}, {"4h", 14400}, {"1d", 86400}}

func (b *binanceProvider) fetchKlines(ins *instrument, interval string, from, to int64) ([]Bar, error) {
	body, err := b.get("/api/v3/klines", url.Values{
		"symbol":    {ins.Binance},
		"interval":  {interval},
		"startTime": {fmt.Sprint(from * 1000)},
		"endTime":   {fmt.Sprint(to*1000 + 999)},
		"limit":     {fmt.Sprint(binanceMaxRows)},
	})
	if err != nil {
		return nil, err
	}
	var rows [][]json.RawMessage
	if err := json.Unmarshal(body, &rows); err != nil {
		return nil, err
	}
	bars := make([]Bar, 0, len(rows))
	for _, row := range rows {
		if len(row) < 6 {
			continue
		}
		var start int64
		var o, h, l, c, v string
		if json.Unmarshal(row[0], &start) != nil || json.Unmarshal(row[1], &o) != nil || json.Unmarshal(row[2], &h) != nil ||
			json.Unmarshal(row[3], &l) != nil || json.Unmarshal(row[4], &c) != nil || json.Unmarshal(row[5], &v) != nil {
			continue
		}
		if bar, ok := parseKline(ins, start/1000, o, h, l, c, v); ok {
			bars = append(bars, bar)
		}
	}
	return bars, nil
}

// Bars: the finest interval that fits one request for the window. Returns
// ok=false when nothing could be fetched or cached, so the caller can fall
// back.
func (b *binanceProvider) bars(ins *instrument, from, to int64) ([]Bar, bool) {
	now := time.Now().Unix()
	if to > now {
		to = now
	}
	if from >= to {
		return nil, true
	}
	live := to >= now-120 && to-from <= int64(recentSpan/time.Second)
	interval, step := "1d", int64(86400)
	if live {
		interval, step = "1m", 60
	} else {
		for _, iv := range binanceIntervals {
			if (to-from)/iv.secs <= binanceMaxRows {
				interval, step = iv.name, iv.secs
				break
			}
		}
	}
	ttl := binanceHistTTL
	key := fmt.Sprintf("%s|%s|%d|%d", ins.Symbol, interval, from/step, to/step)
	if live {
		ttl = binanceRecentTTL
		key = ins.Symbol + "|live"
		from = now - int64(recentSpan/time.Second)
		to = now
	}
	b.mu.Lock()
	entry, cached := b.history[key]
	b.mu.Unlock()
	var bars []Bar
	if cached && time.Since(entry.fetchedAt) < ttl {
		bars = entry.bars
	} else {
		fetched, err := b.fetchKlines(ins, interval, from, to)
		if err != nil {
			if !cached {
				return nil, false
			}
			bars = entry.bars
		} else {
			bars = fetched
			b.mu.Lock()
			b.history[key] = histEntry{bars: bars, fetchedAt: time.Now()}
			b.mu.Unlock()
		}
	}
	if !live {
		return bars, true
	}
	// Overlay the forming candle from the stream, then cut to the window.
	b.mu.Lock()
	forming, hasForming := b.forming[ins.Symbol]
	b.mu.Unlock()
	out := make([]Bar, 0, len(bars)+1)
	for _, bar := range bars {
		if hasForming && bar.Time >= forming.Time {
			break
		}
		out = append(out, bar)
	}
	if hasForming {
		out = append(out, forming)
	}
	return out, true
}

func (b *binanceProvider) Bars(ins *instrument, from, to int64) []Bar {
	bars, _ := b.bars(ins, from, to)
	return bars
}

// ── Composite: Binance for crypto when it is live, Yahoo otherwise ──────────

type compositeProvider struct {
	binance *binanceProvider
	yahoo   *yahooProvider
}

func (c compositeProvider) Name() string { return "yahoo-finance + binance (crypto)" }

func (c compositeProvider) Tick(ins *instrument) (Tick, bool) {
	if ins.Binance != "" {
		if t, ok := c.binance.Tick(ins); ok {
			return t, true
		}
	}
	return c.yahoo.Tick(ins)
}

func (c compositeProvider) Bars(ins *instrument, from, to int64) []Bar {
	if ins.Binance != "" {
		if bars, ok := c.binance.bars(ins, from, to); ok && len(bars) > 0 {
			return bars
		}
	}
	return c.yahoo.Bars(ins, from, to)
}
