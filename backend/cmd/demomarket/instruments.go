package main

import (
	"math"
	"time"
)

// Bar is one candle; Time is the bucket start in unix seconds.
type Bar struct {
	Time                   int64
	Open, High, Low, Close float64
	Volume                 int64
}

// Tick is the latest price of an instrument.
type Tick struct {
	Bid, Ask float64
	At       time.Time
	// Minute is the start of the price's minute at the source (unix seconds),
	// which can lag At by up to a minute on a slow instrument.
	Minute int64
}

// Provider is a source of market data for the instruments table.
type Provider interface {
	// Tick returns the latest quote, or ok=false when none has been seen yet.
	Tick(ins *instrument) (Tick, bool)
	// Bars returns candles covering [from, to] (unix seconds), oldest first.
	// The granularity is the finest the source offers for that window — the
	// gateway aggregates into whatever bucket the client asked for.
	Bars(ins *instrument, from, to int64) []Bar
	// Name identifies the source in logs.
	Name() string
}

type instrument struct {
	Symbol      string
	Description string
	Path        string
	Base        string
	Profit      string
	Digits      int
	// Yahoo is the Yahoo Finance ticker this instrument's real data comes from.
	Yahoo string
	// SpreadPoints is the nominal bid/ask spread in price units — real venues
	// publish a single price for FX and futures; a broker's spread is applied
	// around it, and this is the demo broker's.
	SpreadPoints float64
	Sessions     string // JSON: seven days of MT5 minute-of-day sessions

	// Synthetic-source parameters.
	Price float64 // the level the path wanders around
	Vol   float64 // amplitude of the wander, as a fraction of price
	seed  uint64
}

const (
	weekdays = `[[],[{"Open":0,"Close":1440}],[{"Open":0,"Close":1440}],[{"Open":0,"Close":1440}],[{"Open":0,"Close":1440}],[{"Open":0,"Close":1440}],[]]`
	allWeek  = `[[{"Open":0,"Close":1440}],[{"Open":0,"Close":1440}],[{"Open":0,"Close":1440}],[{"Open":0,"Close":1440}],[{"Open":0,"Close":1440}],[{"Open":0,"Close":1440}],[{"Open":0,"Close":1440}]]`
)

var instruments = []*instrument{
	{Symbol: "EURUSD", Description: "Euro vs US Dollar", Path: `Forex\Majors\EURUSD`, Base: "EUR", Profit: "USD", Digits: 5, Yahoo: "EURUSD=X", SpreadPoints: 0.00008, Sessions: weekdays, Price: 1.0850, Vol: 0.012, seed: 11},
	{Symbol: "GBPUSD", Description: "Great Britain Pound vs US Dollar", Path: `Forex\Majors\GBPUSD`, Base: "GBP", Profit: "USD", Digits: 5, Yahoo: "GBPUSD=X", SpreadPoints: 0.00012, Sessions: weekdays, Price: 1.2700, Vol: 0.014, seed: 12},
	{Symbol: "USDJPY", Description: "US Dollar vs Japanese Yen", Path: `Forex\Majors\USDJPY`, Base: "USD", Profit: "JPY", Digits: 3, Yahoo: "USDJPY=X", SpreadPoints: 0.012, Sessions: weekdays, Price: 150.25, Vol: 0.013, seed: 13},
	{Symbol: "AUDUSD", Description: "Australian Dollar vs US Dollar", Path: `Forex\Majors\AUDUSD`, Base: "AUD", Profit: "USD", Digits: 5, Yahoo: "AUDUSD=X", SpreadPoints: 0.00012, Sessions: weekdays, Price: 0.6600, Vol: 0.015, seed: 14},
	{Symbol: "USDCAD", Description: "US Dollar vs Canadian Dollar", Path: `Forex\Majors\USDCAD`, Base: "USD", Profit: "CAD", Digits: 5, Yahoo: "USDCAD=X", SpreadPoints: 0.00015, Sessions: weekdays, Price: 1.3600, Vol: 0.011, seed: 15},
	{Symbol: "USDCHF", Description: "US Dollar vs Swiss Franc", Path: `Forex\Majors\USDCHF`, Base: "USD", Profit: "CHF", Digits: 5, Yahoo: "USDCHF=X", SpreadPoints: 0.00015, Sessions: weekdays, Price: 0.8800, Vol: 0.012, seed: 16},
	{Symbol: "NZDUSD", Description: "New Zealand Dollar vs US Dollar", Path: `Forex\Minors\NZDUSD`, Base: "NZD", Profit: "USD", Digits: 5, Yahoo: "NZDUSD=X", SpreadPoints: 0.00018, Sessions: weekdays, Price: 0.6000, Vol: 0.016, seed: 17},
	{Symbol: "XAUUSD", Description: "Gold vs US Dollar (COMEX futures, exchange-delayed)", Path: `Metals\Spot\XAUUSD`, Base: "XAU", Profit: "USD", Digits: 2, Yahoo: "GC=F", SpreadPoints: 0.30, Sessions: weekdays, Price: 2400.00, Vol: 0.030, seed: 21},
	{Symbol: "BTCUSD", Description: "Bitcoin vs US Dollar", Path: `Crypto\Majors\BTCUSD`, Base: "BTC", Profit: "USD", Digits: 2, Yahoo: "BTC-USD", SpreadPoints: 12.0, Sessions: allWeek, Price: 65000.0, Vol: 0.090, seed: 31},
	{Symbol: "ETHUSD", Description: "Ethereum vs US Dollar", Path: `Crypto\Majors\ETHUSD`, Base: "ETH", Profit: "USD", Digits: 2, Yahoo: "ETH-USD", SpreadPoints: 0.80, Sessions: allWeek, Price: 3200.0, Vol: 0.110, seed: 32},
}

var bySymbol = func() map[string]*instrument {
	m := make(map[string]*instrument, len(instruments))
	for _, ins := range instruments {
		m[ins.Symbol] = ins
	}
	return m
}()

func (ins *instrument) round(v float64) float64 {
	p := math.Pow(10, float64(ins.Digits))
	return math.Round(v*p) / p
}

// spread applies the demo broker's nominal spread around a single price.
func (ins *instrument) spread(mid float64) (bid, ask float64) {
	half := ins.SpreadPoints / 2
	bid, ask = ins.round(mid-half), ins.round(mid+half)
	if ask <= bid {
		ask = ins.round(bid + math.Pow(10, -float64(ins.Digits)))
	}
	return bid, ask
}

// tradesAt applies the instrument's sessions: FX and metals are closed at the
// weekend; crypto trades every day.
func (ins *instrument) tradesAt(unix int64) bool {
	if ins.Sessions == allWeek {
		return true
	}
	wd := time.Unix(unix, 0).UTC().Weekday()
	return wd != time.Saturday && wd != time.Sunday
}

// ── Synthetic provider ──────────────────────────────────────────────────────

type syntheticProvider struct{}

func (syntheticProvider) Name() string { return "synthetic" }

func (syntheticProvider) Tick(ins *instrument) (Tick, bool) {
	now := time.Now()
	bid, ask := ins.tick(now)
	return Tick{Bid: bid, Ask: ask, At: now, Minute: now.Unix() - now.Unix()%60}, true
}

func (syntheticProvider) Bars(ins *instrument, from, to int64) []Bar {
	const maxBars = 60 * 24 * 31
	if (to-from)/60 > maxBars {
		from = to - maxBars*60
	}
	var out []Bar
	for t := from - from%60; t <= to; t += 60 {
		if !ins.tradesAt(t) {
			continue
		}
		o, h, l, c, vol := ins.m1Bar(t)
		out = append(out, Bar{Time: t, Open: o, High: h, Low: l, Close: c, Volume: vol})
	}
	return out
}
