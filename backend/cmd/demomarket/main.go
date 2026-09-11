// Command demomarket is the platform's market-data source and demo broker.
//
// It stands in for BOTH upstreams the gateway speaks to — the MT5 Manager Web
// API and the CRM — on the same wire contracts (docs/ANALYSIS.md), so the
// gateway runs unmodified and never needs, or has, a connection to a trading
// server.
//
// Prices are REAL: by default they come from Yahoo Finance's public endpoints
// (yahoo.go) — live FX and crypto, exchange-delayed gold futures, years of
// history — without any account or key. `-source synthetic` swaps in a
// deterministic generator for offline work and tests.
//
// The broker side is a demo: one sample account whose position, pending
// order and equity follow the live EURUSD price, plus canned deals/history.
//
// Usage: go run ./cmd/demomarket [-addr :5199] [-source live|synthetic]
//
// Point the gateway at it with:
//
//	MT5_HOST_URL=http://127.0.0.1 MT5_PORT=5199 CRM_URL=http://127.0.0.1:5199
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"math"
	"net/http"
	"path"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

var requests atomic.Int64

func j(w http.ResponseWriter, body string) {
	w.Header().Set("Content-Type", "application/json")
	fmt.Fprint(w, body)
}

func ftoa(v float64, digits int) string { return strconv.FormatFloat(v, 'f', digits, 64) }

func symbolJSON(ins *instrument) string {
	multiply := math.Pow(10, float64(ins.Digits))
	return fmt.Sprintf(`{"Symbol":%q,"Path":%q,"Description":%q,"Sector":"Currency","Industry":"Forex","CurrencyBase":%q,"CurrencyProfit":%q,"Digits":%d,"Multiply":%d,"ContractSize":100000,"VolumeMin":1000,"VolumeMax":5000000,"VolumeStep":1000,"VolumeMinExt":0,"SessionsTrades":%s}`,
		ins.Symbol, strings.ReplaceAll(ins.Path, `\`, `\\`), ins.Description, ins.Base, ins.Profit, ins.Digits, int64(multiply), ins.Sessions)
}

func tickJSON(ins *instrument, t Tick) string {
	return fmt.Sprintf(`{"Symbol":%q,"Datetime":"%d","DatetimeMsc":"%d","Bid":%s,"Ask":%s,"Last":%s,"Volume":100}`,
		ins.Symbol, t.At.Unix(), t.At.UnixMilli(), ftoa(t.Bid, ins.Digits), ftoa(t.Ask, ins.Digits), ftoa(t.Bid, ins.Digits))
}

// lookup resolves ?symbol= to a listed instrument. Unknown names get an
// EURUSD-shaped definition under the requested name (the gateway's contract
// tests probe arbitrary names) but no prices.
func lookup(r *http.Request) (*instrument, bool) {
	name := r.URL.Query().Get("symbol")
	if ins, ok := bySymbol[name]; ok {
		return ins, true
	}
	if name == "" || strings.ContainsAny(name, `*?\`) {
		return bySymbol["EURUSD"], true
	}
	clone := *bySymbol["EURUSD"]
	clone.Symbol = name
	clone.Path = `Forex\Other\` + name
	clone.Description = name
	return &clone, false
}

func candlesJSON(ins *instrument, bars []Bar) string {
	var sb strings.Builder
	sb.WriteString(`{"retcode":"0 Done","answer":[`)
	for i, b := range bars {
		if i > 0 {
			sb.WriteByte(',')
		}
		fmt.Fprintf(&sb, "[%d,%s,%s,%s,%s,%d]", b.Time, ftoa(b.Open, ins.Digits), ftoa(b.High, ins.Digits), ftoa(b.Low, ins.Digits), ftoa(b.Close, ins.Digits), b.Volume)
	}
	sb.WriteString("]}")
	return sb.String()
}

// ── Demo broker: one account that follows the live EURUSD price ─────────────

type demoBroker struct {
	provider Provider
	mu       sync.Mutex
	anchor   float64 // EURUSD price when the position was "opened"
}

const (
	demoLogin    = 1010
	demoBalance  = 10000.50
	demoLots     = 1.0     // the sample position's size
	contractSize = 100000. // units per lot
)

// entry fixes the sample position's open price to the first live price seen,
// slightly below it so the demo starts in modest profit.
func (b *demoBroker) entry() (open, current float64, ok bool) {
	ins := bySymbol["EURUSD"]
	t, ok := b.provider.Tick(ins)
	if !ok {
		return 0, 0, false
	}
	b.mu.Lock()
	if b.anchor == 0 {
		b.anchor = ins.round(t.Bid - 0.0005)
	}
	open = b.anchor
	b.mu.Unlock()
	return open, t.Bid, true
}

func (b *demoBroker) profit() float64 {
	open, current, ok := b.entry()
	if !ok {
		return 0
	}
	return math.Round((current-open)*demoLots*contractSize*100) / 100
}

func (b *demoBroker) positionJSON() string {
	open, current, ok := b.entry()
	if !ok {
		open, current = 1.0800, 1.0800
	}
	return fmt.Sprintf(`{"Position":555001,"ExternalID":"","Login":%d,"Symbol":"EURUSD","Action":0,"TimeCreate":%d,"PriceOpen":%s,"PriceCurrent":%s,"PriceSL":%s,"PriceTP":%s,"Volume":%d,"Profit":%s,"Storage":-1.25}`,
		demoLogin, time.Now().Add(-26*time.Hour).Unix(), ftoa(open, 5), ftoa(current, 5), ftoa(open-0.0100, 5), ftoa(open+0.0200, 5), int(demoLots*10000), ftoa(b.profit(), 2))
}

func (b *demoBroker) orderJSON() string {
	open, _, ok := b.entry()
	if !ok {
		open = 1.0800
	}
	// A working buy-limit a little under the market, with its own SL/TP.
	price := open - 0.0030
	return fmt.Sprintf(`{"Order":"100001","ExternalID":"","Symbol":"EURUSD","State":1,"TimeSetup":%d,"Type":2,"PriceOrder":%s,"PriceSL":%s,"PriceTP":%s,"VolumeInitial":10000,"VolumeCurrent":10000,"Comment":"demo","side":0,"TypeTime":2,"TimeExpiration":%d}`,
		time.Now().Add(-3*time.Hour).Unix(), ftoa(price, 5), ftoa(price-0.0100, 5), ftoa(price+0.0200, 5), time.Now().Add(30*24*time.Hour).Unix())
}

func (b *demoBroker) accountJSON() string {
	p := b.profit()
	return fmt.Sprintf(`{"retcode":"0 Done","answer":{"Login":"%d","Balance":%s,"Equity":%s,"Profit":%s}}`, demoLogin, ftoa(demoBalance, 2), ftoa(demoBalance+p, 2), ftoa(p, 2))
}

func main() {
	addr := flag.String("addr", ":5199", "listen address")
	source := flag.String("source", "live", "price source: live (Yahoo Finance, real data) or synthetic")
	flag.Parse()

	var provider Provider
	switch *source {
	case "synthetic":
		provider = syntheticProvider{}
	case "live":
		y := newYahooProvider()
		y.Start(context.Background())
		provider = y
	default:
		log.Fatalf("unknown -source %q (live|synthetic)", *source)
	}
	broker := &demoBroker{provider: provider}

	mux := http.NewServeMux()

	// ── MT5 auth handshake + ping ────────────────────────────────────────────
	mux.HandleFunc("/api/auth/start", func(w http.ResponseWriter, r *http.Request) {
		j(w, `{"retcode":"0 Done","srv_rand":"a1b2c3d4e5f60718293a4b5c6d7e8f90"}`)
	})
	mux.HandleFunc("/api/auth/answer", func(w http.ResponseWriter, r *http.Request) {
		http.SetCookie(w, &http.Cookie{Name: "MT5Session", Value: "demo-session"})
		j(w, `{"retcode":"0 Done","cli_rand_answer":"00"}`)
	})
	mux.HandleFunc("/api/test/access", func(w http.ResponseWriter, r *http.Request) {
		j(w, `{"retcode":"0 Done"}`)
	})

	// ── Demo account ─────────────────────────────────────────────────────────
	const (
		dealRow = `{"Deal":"900001","Order":"100001","Login":1010,"Symbol":"EURUSD","Action":0,"Entry":0,"Price":1.0800,"Volume":10000,"Time":1751500000,"TimeMsc":1751500000000,"Commission":-3.5,"Storage":0,"Profit":0,"PositionID":"555001"}`
		placed  = `{"Order":"100002","ExternalID":"","Symbol":"EURUSD","Type":"0","Volume":10000,"PriceOrder":1.0800,"PriceSL":0,"PriceTP":0,"Comment":"demo","ResultRetcode":"10009 Done","ResultPrice":1.0850,"ResultVolume":10000,"TypeTime":0,"TimeExpiration":0}`
	)
	mux.HandleFunc("/api/order/get_page", func(w http.ResponseWriter, r *http.Request) {
		j(w, `{"retcode":"0 Done","answer":[`+broker.orderJSON()+`]}`)
	})
	mux.HandleFunc("/api/history/get_page", func(w http.ResponseWriter, r *http.Request) {
		j(w, `{"retcode":"0 Done","answer":[`+broker.orderJSON()+`]}`)
	})
	mux.HandleFunc("/api/order/update", func(w http.ResponseWriter, r *http.Request) {
		j(w, `{"retcode":"0 Done","answer":`+broker.orderJSON()+`}`)
	})
	mux.HandleFunc("/api/position/get", func(w http.ResponseWriter, r *http.Request) {
		j(w, `{"retcode":"0 Done","answer":`+broker.positionJSON()+`}`)
	})
	mux.HandleFunc("/api/position/get_page", func(w http.ResponseWriter, r *http.Request) {
		j(w, `{"retcode":"0 Done","answer":[`+broker.positionJSON()+`]}`)
	})
	mux.HandleFunc("/api/position/update", func(w http.ResponseWriter, r *http.Request) {
		j(w, `{"retcode":"0 Done","answer":`+broker.positionJSON()+`}`)
	})
	mux.HandleFunc("/api/user/get", func(w http.ResponseWriter, r *http.Request) {
		j(w, `{"retcode":"0 Done","answer":{"ID":"1010","Name":"Demo Trader"}}`)
	})
	mux.HandleFunc("/api/user/account/get", func(w http.ResponseWriter, r *http.Request) {
		j(w, broker.accountJSON())
	})
	mux.HandleFunc("/api/deal/get_page", func(w http.ResponseWriter, r *http.Request) {
		j(w, `{"retcode":"0 Done","answer":[`+dealRow+`]}`)
	})
	mux.HandleFunc("/api/dealer/send_request", func(w http.ResponseWriter, r *http.Request) {
		j(w, `{"retcode":"0 Done","answer":{"Id":777}}`)
	})
	mux.HandleFunc("/api/dealer/get_request_result", func(w http.ResponseWriter, r *http.Request) {
		j(w, `{"retcode":"0 Done","answer":{"777":[{"result":"0"},{"result":"0","answer":`+placed+`}]}}`)
	})

	// ── Symbols ──────────────────────────────────────────────────────────────
	mux.HandleFunc("/api/symbol/list", func(w http.ResponseWriter, r *http.Request) {
		names := make([]string, 0, len(instruments))
		for _, ins := range instruments {
			names = append(names, strconv.Quote(ins.Symbol))
		}
		j(w, `{"retcode":"0 Done","answer":[`+strings.Join(names, ",")+`]}`)
	})
	mux.HandleFunc("/api/symbol/get", func(w http.ResponseWriter, r *http.Request) {
		if mask := r.URL.Query().Get("mask"); mask != "" {
			var rows []string
			for _, ins := range instruments {
				if ok, _ := path.Match(strings.ToUpper(mask), ins.Symbol); ok {
					rows = append(rows, symbolJSON(ins))
				}
			}
			if len(rows) == 0 {
				ins, _ := lookup(r)
				rows = append(rows, symbolJSON(ins))
			}
			j(w, `{"retcode":"0 Done","answer":[`+strings.Join(rows, ",")+`]}`)
			return
		}
		ins, _ := lookup(r)
		j(w, `{"retcode":"0 Done","answer":`+symbolJSON(ins)+`}`)
	})
	mux.HandleFunc("/api/symbol/get_group", func(w http.ResponseWriter, r *http.Request) {
		ins, _ := lookup(r)
		j(w, `{"retcode":"0 Done","answer":`+symbolJSON(ins)+`}`)
	})

	// ── Ticks / candles / depth ──────────────────────────────────────────────
	tickHandler := func(w http.ResponseWriter, r *http.Request) {
		ins, listed := lookup(r)
		if t, ok := provider.Tick(ins); listed && ok {
			j(w, `{"retcode":"0 Done","trans_id":"1","answer":[`+tickJSON(ins, t)+`]}`)
			return
		}
		// No price yet (source unreachable or unknown symbol): an empty
		// answer, never an invented one.
		j(w, `{"retcode":"0 Done","trans_id":"1","answer":[]}`)
	}
	mux.HandleFunc("/api/tick/last", tickHandler)
	mux.HandleFunc("/api/tick/last_group", tickHandler)
	mux.HandleFunc("/api/chart/get", func(w http.ResponseWriter, r *http.Request) {
		ins, listed := lookup(r)
		q := r.URL.Query()
		to := time.Now().Unix()
		if v, err := strconv.ParseInt(q.Get("to"), 10, 64); err == nil && v > 0 && v < to {
			to = v
		}
		from := to - 300*60
		if v, err := strconv.ParseInt(q.Get("from"), 10, 64); err == nil && v > 0 {
			from = v
		}
		if !listed {
			j(w, `{"retcode":"0 Done","answer":[]}`)
			return
		}
		j(w, candlesJSON(ins, provider.Bars(ins, from, to)))
	})
	// Book side codes follow MQL5 ENUM_BOOK_TYPE (1=sell/ask, 2=buy/bid).
	mux.HandleFunc("/api/book/get", func(w http.ResponseWriter, r *http.Request) {
		ins, _ := lookup(r)
		t, ok := provider.Tick(ins)
		if !ok {
			j(w, fmt.Sprintf(`{"retcode":"0 Done","answer":{"Symbol":%q,"Items":[]}}`, ins.Symbol))
			return
		}
		step := math.Pow(10, -float64(ins.Digits))
		var items []string
		for i := 0; i < 4; i++ {
			items = append(items,
				fmt.Sprintf(`{"Type":2,"Price":%s,"Volume":%d}`, ftoa(t.Bid-float64(i)*step, ins.Digits), 100000*(i+1)),
				fmt.Sprintf(`{"Type":1,"Price":%s,"Volume":%d}`, ftoa(t.Ask+float64(i)*step, ins.Digits), 120000*(i+1)))
		}
		j(w, fmt.Sprintf(`{"retcode":"0 Done","answer":{"Symbol":%q,"Items":[%s]}}`, ins.Symbol, strings.Join(items, ",")))
	})

	// ── CRM: login + account list ────────────────────────────────────────────
	mux.HandleFunc("/client-api/login", func(w http.ResponseWriter, r *http.Request) {
		var req struct{ Email, Password string }
		_ = json.NewDecoder(r.Body).Decode(&req)
		if strings.EqualFold(req.Email, "trader@example.com") && req.Password == "correct-password" {
			j(w, `{"accessToken":"demo-crm-token"}`)
			return
		}
		w.WriteHeader(http.StatusUnauthorized)
		j(w, `{"error":"invalid credentials"}`)
	})
	mux.HandleFunc("/client-api/accounts", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer demo-crm-token" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		// Three demo accounts of different types, plus one non-trading profile
		// (typeId 1) the gateway's account policy must filter out.
		j(w, `[{"login":"1010","typeId":57},{"login":"2020","typeId":58},{"login":"3030","typeId":11},{"login":"9999","typeId":1}]`)
	})

	// ── Everything else under /api → generic OK ─────────────────────────────
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") {
			j(w, `{"retcode":"0 Done","answer":{"ok":true}}`)
			return
		}
		http.NotFound(w, r)
	})

	logged := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		mux.ServeHTTP(w, r)
	})
	log.Printf("demo market + CRM listening on %s — prices: %s, %d instruments", *addr, provider.Name(), len(instruments))
	log.Fatal(http.ListenAndServe(*addr, logged))
}
