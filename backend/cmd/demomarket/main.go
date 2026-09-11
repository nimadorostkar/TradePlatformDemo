// Command demomarket is the platform's simulated market and broker.
//
// It stands in for BOTH upstreams the gateway speaks to — the MT5 Manager Web
// API and the CRM — on the same wire contracts (docs/ANALYSIS.md), so the
// gateway runs unmodified and never needs, or has, a connection to a real
// trading server. Nothing here talks to any external system.
//
// Prices are synthetic but consistent: every symbol follows a deterministic
// multi-octave noise path, so the M1 candles served for any window — a week
// of 1-minute bars or three years for a weekly chart — agree with each other
// and with the live ticks that continue the same path. Positions, orders and
// balances are fixed sample data.
//
// Usage: go run ./cmd/demomarket [-addr :5199]
//
// Point the gateway at it with:
//
//	MT5_HOST_URL=http://127.0.0.1 MT5_PORT=5199 CRM_URL=http://127.0.0.1:5199
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"math"
	"net/http"
	"path"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
)

// ── The simulated instruments ───────────────────────────────────────────────

type instrument struct {
	Symbol      string
	Description string
	Path        string
	Base        string
	Profit      string
	Digits      int
	Price       float64 // the level the path wanders around
	Vol         float64 // amplitude of the wander, as a fraction of price
	Spread      float64 // ask − bid, as a fraction of price
	Sessions    string  // JSON: seven days of MT5 minute-of-day sessions
	seed        uint64
}

const (
	weekdays = `[[],[{"Open":0,"Close":1440}],[{"Open":0,"Close":1440}],[{"Open":0,"Close":1440}],[{"Open":0,"Close":1440}],[{"Open":0,"Close":1440}],[]]`
	allWeek  = `[[{"Open":0,"Close":1440}],[{"Open":0,"Close":1440}],[{"Open":0,"Close":1440}],[{"Open":0,"Close":1440}],[{"Open":0,"Close":1440}],[{"Open":0,"Close":1440}],[{"Open":0,"Close":1440}]]`
)

var instruments = []*instrument{
	{"EURUSD", "Euro vs US Dollar", `Forex\Majors\EURUSD`, "EUR", "USD", 5, 1.0850, 0.012, 0.00002, weekdays, 11},
	{"GBPUSD", "Great Britain Pound vs US Dollar", `Forex\Majors\GBPUSD`, "GBP", "USD", 5, 1.2700, 0.014, 0.00003, weekdays, 12},
	{"USDJPY", "US Dollar vs Japanese Yen", `Forex\Majors\USDJPY`, "USD", "JPY", 3, 150.25, 0.013, 0.00002, weekdays, 13},
	{"AUDUSD", "Australian Dollar vs US Dollar", `Forex\Majors\AUDUSD`, "AUD", "USD", 5, 0.6600, 0.015, 0.00003, weekdays, 14},
	{"USDCAD", "US Dollar vs Canadian Dollar", `Forex\Majors\USDCAD`, "USD", "CAD", 5, 1.3600, 0.011, 0.00003, weekdays, 15},
	{"USDCHF", "US Dollar vs Swiss Franc", `Forex\Majors\USDCHF`, "USD", "CHF", 5, 0.8800, 0.012, 0.00003, weekdays, 16},
	{"NZDUSD", "New Zealand Dollar vs US Dollar", `Forex\Minors\NZDUSD`, "NZD", "USD", 5, 0.6000, 0.016, 0.00004, weekdays, 17},
	{"XAUUSD", "Gold vs US Dollar", `Metals\Spot\XAUUSD`, "XAU", "USD", 2, 2400.00, 0.030, 0.00012, weekdays, 21},
	{"BTCUSD", "Bitcoin vs US Dollar", `Crypto\Majors\BTCUSD`, "BTC", "USD", 2, 65000.0, 0.090, 0.0004, allWeek, 31},
}

var bySymbol = func() map[string]*instrument {
	m := make(map[string]*instrument, len(instruments))
	for _, ins := range instruments {
		m[ins.Symbol] = ins
	}
	return m
}()

// ── Deterministic price path ────────────────────────────────────────────────

// hash01 maps (seed, i) to a uniform value in [-1, 1] — splitmix64 finalizer.
func hash01(seed uint64, i int64) float64 {
	z := seed ^ (uint64(i) * 0x9E3779B97F4A7C15)
	z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9
	z = (z ^ (z >> 27)) * 0x94D049BB133111EB
	z ^= z >> 31
	return float64(z>>11)/float64(1<<53)*2 - 1
}

// valueNoise interpolates hashed lattice values smoothly: continuous, so a
// bar's close is the next bar's open and a tick continues the forming bar.
func valueNoise(seed uint64, x float64) float64 {
	i := math.Floor(x)
	f := x - i
	f = f * f * (3 - 2*f) // smoothstep
	a := hash01(seed, int64(i))
	b := hash01(seed, int64(i)+1)
	return a + (b-a)*f
}

// octaves: (amplitude weight, period in minutes). Long, slow swings down to
// second-level jitter, so the path looks like a market at every zoom level.
var octaves = [...][2]float64{
	{1.00, 60 * 24 * 45},
	{0.60, 60 * 24 * 7},
	{0.35, 60 * 24},
	{0.20, 60 * 4},
	{0.10, 60},
	{0.05, 10},
	{0.025, 1},
	{0.012, 0.25},
}

// price of an instrument at a unix second, in its quote currency (the bid).
func (ins *instrument) price(atSeconds float64) float64 {
	minutes := atSeconds / 60
	var s float64
	for k, o := range octaves {
		s += o[0] * valueNoise(ins.seed*7919+uint64(k)*104729, minutes/o[1])
	}
	// s is roughly in [-2.3, 2.3]; scale to the instrument's wander.
	return ins.Price * math.Exp(s/2.3*ins.Vol)
}

func (ins *instrument) round(v float64) float64 {
	p := math.Pow(10, float64(ins.Digits))
	return math.Round(v*p) / p
}

func (ins *instrument) tick(at time.Time) (bid, ask float64) {
	bid = ins.round(ins.price(float64(at.UnixMilli()) / 1000))
	ask = ins.round(bid * (1 + ins.Spread))
	if ask <= bid {
		ask = ins.round(bid + math.Pow(10, -float64(ins.Digits)))
	}
	return bid, ask
}

// m1Bar is the one-minute candle starting at minuteStart (unix seconds).
func (ins *instrument) m1Bar(minuteStart int64) (o, h, l, c float64, vol int64) {
	o = ins.price(float64(minuteStart))
	c = ins.price(float64(minuteStart + 59))
	h, l = math.Max(o, c), math.Min(o, c)
	for _, sec := range [...]int64{10, 20, 30, 40, 50} {
		p := ins.price(float64(minuteStart + sec))
		h, l = math.Max(h, p), math.Min(l, p)
	}
	vol = 40 + int64(math.Abs(hash01(ins.seed+3, minuteStart/60))*400)
	return ins.round(o), ins.round(h), ins.round(l), ins.round(c), vol
}

// ── HTTP ────────────────────────────────────────────────────────────────────

var requests atomic.Int64

func j(w http.ResponseWriter, body string) {
	w.Header().Set("Content-Type", "application/json")
	fmt.Fprint(w, body)
}

func symbolJSON(ins *instrument) string {
	multiply := math.Pow(10, float64(ins.Digits))
	return fmt.Sprintf(`{"Symbol":%q,"Path":%q,"Description":%q,"Sector":"Currency","Industry":"Forex","CurrencyBase":%q,"CurrencyProfit":%q,"Digits":%d,"Multiply":%d,"ContractSize":100000,"VolumeMin":1000,"VolumeMax":5000000,"VolumeStep":1000,"VolumeMinExt":0,"SessionsTrades":%s}`,
		ins.Symbol, strings.ReplaceAll(ins.Path, `\`, `\\`), ins.Description, ins.Base, ins.Profit, ins.Digits, int64(multiply), ins.Sessions)
}

func tickJSON(ins *instrument, at time.Time) string {
	bid, ask := ins.tick(at)
	return fmt.Sprintf(`{"Symbol":%q,"Datetime":"%d","DatetimeMsc":"%d","Bid":%s,"Ask":%s,"Last":%s,"Volume":100}`,
		ins.Symbol, at.Unix(), at.UnixMilli(), ftoa(bid, ins.Digits), ftoa(ask, ins.Digits), ftoa(bid, ins.Digits))
}

func ftoa(v float64, digits int) string { return strconv.FormatFloat(v, 'f', digits, 64) }

// lookup resolves the instrument for ?symbol= (exact) — unknown symbols fall
// back to EURUSD's shape under the requested name, so the gateway's contract
// tests for arbitrary names still get a well-formed answer.
func lookup(r *http.Request) *instrument {
	name := r.URL.Query().Get("symbol")
	if ins, ok := bySymbol[name]; ok {
		return ins
	}
	if name == "" || strings.ContainsAny(name, `*?\`) {
		return bySymbol["EURUSD"]
	}
	clone := *bySymbol["EURUSD"]
	clone.Symbol = name
	clone.Path = `Forex\Other\` + name
	clone.Description = name
	clone.seed = uint64(len(name)) * 977
	for _, ch := range name {
		clone.seed = clone.seed*31 + uint64(ch)
	}
	return &clone
}

// candles answers /api/chart/get: M1 bars covering [from, to], capped like
// MT5 caps its answers, so the gateway's chunking stays exercised.
func candles(r *http.Request) string {
	ins := lookup(r)
	q := r.URL.Query()
	to := time.Now().Unix()
	if v, err := strconv.ParseInt(q.Get("to"), 10, 64); err == nil && v > 0 && v < to {
		to = v
	}
	from := to - 300*60
	if v, err := strconv.ParseInt(q.Get("from"), 10, 64); err == nil && v > 0 {
		from = v
	}
	const maxBars = 60 * 24 * 31
	if (to-from)/60 > maxBars {
		from = to - maxBars*60
	}
	var sb strings.Builder
	sb.WriteString(`{"retcode":"0 Done","answer":[`)
	first := true
	for t := from - from%60; t <= to; t += 60 {
		if !ins.tradesAt(t) {
			continue
		}
		o, h, l, c, vol := ins.m1Bar(t)
		if !first {
			sb.WriteByte(',')
		}
		first = false
		fmt.Fprintf(&sb, "[%d,%s,%s,%s,%s,%d]", t, ftoa(o, ins.Digits), ftoa(h, ins.Digits), ftoa(l, ins.Digits), ftoa(c, ins.Digits), vol)
	}
	sb.WriteString("]}")
	return sb.String()
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

func main() {
	addr := flag.String("addr", ":5199", "listen address")
	flag.Parse()

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

	// ── Sample account state (volumes in MT5 units: 10000 = 1 lot) ──────────
	const (
		orderRow = `{"Order":"100001","ExternalID":"","Symbol":"EURUSD","State":1,"TimeSetup":1751500000,"Type":2,"PriceOrder":1.0800,"PriceSL":1.0700,"PriceTP":1.1000,"VolumeInitial":10000,"VolumeCurrent":10000,"Comment":"demo","side":0,"TypeTime":2,"TimeExpiration":1800000000}`
		posRow   = `{"Position":555001,"ExternalID":"","Login":1010,"Symbol":"EURUSD","Action":0,"TimeCreate":1751500000,"PriceOpen":1.0800,"PriceCurrent":1.0850,"PriceSL":1.0700,"PriceTP":1.1000,"Volume":10000,"Profit":50.0,"Storage":-1.25}`
		dealRow  = `{"Deal":"900001","Order":"100001","Login":1010,"Symbol":"EURUSD","Action":0,"Entry":0,"Price":1.0800,"Volume":10000,"Time":1751500000,"TimeMsc":1751500000000,"Commission":-3.5,"Storage":0,"Profit":0,"PositionID":"555001"}`
		placed   = `{"Order":"100002","ExternalID":"","Symbol":"EURUSD","Type":"0","Volume":10000,"PriceOrder":1.0800,"PriceSL":0,"PriceTP":0,"Comment":"demo","ResultRetcode":"10009 Done","ResultPrice":1.0850,"ResultVolume":10000,"TypeTime":0,"TimeExpiration":0}`
	)
	mux.HandleFunc("/api/order/get_page", func(w http.ResponseWriter, r *http.Request) {
		j(w, `{"retcode":"0 Done","answer":[`+orderRow+`]}`)
	})
	mux.HandleFunc("/api/history/get_page", func(w http.ResponseWriter, r *http.Request) {
		j(w, `{"retcode":"0 Done","answer":[`+orderRow+`]}`)
	})
	mux.HandleFunc("/api/order/update", func(w http.ResponseWriter, r *http.Request) {
		j(w, `{"retcode":"0 Done","answer":{"Order":100001,"ExternalID":"","Login":1010,"Symbol":"EURUSD","PriceOrder":1.0800,"PriceSL":1.0700,"PriceTP":1.1000,"VolumeInitial":10000}}`)
	})
	mux.HandleFunc("/api/position/get", func(w http.ResponseWriter, r *http.Request) {
		j(w, `{"retcode":"0 Done","answer":`+posRow+`}`)
	})
	mux.HandleFunc("/api/position/get_page", func(w http.ResponseWriter, r *http.Request) {
		j(w, `{"retcode":"0 Done","answer":[`+posRow+`]}`)
	})
	mux.HandleFunc("/api/position/update", func(w http.ResponseWriter, r *http.Request) {
		j(w, `{"retcode":"0 Done","answer":`+posRow+`}`)
	})
	mux.HandleFunc("/api/user/get", func(w http.ResponseWriter, r *http.Request) {
		j(w, `{"retcode":"0 Done","answer":{"ID":"1010","Name":"Demo Trader"}}`)
	})
	mux.HandleFunc("/api/user/account/get", func(w http.ResponseWriter, r *http.Request) {
		j(w, `{"retcode":"0 Done","answer":{"Login":"1010","Balance":10000.50,"Equity":10050.50,"Profit":50.0}}`)
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
				rows = append(rows, symbolJSON(lookup(r)))
			}
			j(w, `{"retcode":"0 Done","answer":[`+strings.Join(rows, ",")+`]}`)
			return
		}
		j(w, `{"retcode":"0 Done","answer":`+symbolJSON(lookup(r))+`}`)
	})
	mux.HandleFunc("/api/symbol/get_group", func(w http.ResponseWriter, r *http.Request) {
		j(w, `{"retcode":"0 Done","answer":`+symbolJSON(lookup(r))+`}`)
	})

	// ── Ticks / candles / depth ──────────────────────────────────────────────
	mux.HandleFunc("/api/tick/last", func(w http.ResponseWriter, r *http.Request) {
		j(w, `{"retcode":"0 Done","trans_id":"1","answer":[`+tickJSON(lookup(r), time.Now())+`]}`)
	})
	mux.HandleFunc("/api/tick/last_group", func(w http.ResponseWriter, r *http.Request) {
		j(w, `{"retcode":"0 Done","trans_id":"1","answer":[`+tickJSON(lookup(r), time.Now())+`]}`)
	})
	mux.HandleFunc("/api/chart/get", func(w http.ResponseWriter, r *http.Request) {
		j(w, candles(r))
	})
	// Book side codes follow MQL5 ENUM_BOOK_TYPE (1=sell/ask, 2=buy/bid).
	mux.HandleFunc("/api/book/get", func(w http.ResponseWriter, r *http.Request) {
		ins := lookup(r)
		bid, ask := ins.tick(time.Now())
		step := math.Pow(10, -float64(ins.Digits))
		var items []string
		for i := 0; i < 4; i++ {
			items = append(items,
				fmt.Sprintf(`{"Type":2,"Price":%s,"Volume":%d}`, ftoa(bid-float64(i)*step, ins.Digits), 100000*(i+1)),
				fmt.Sprintf(`{"Type":1,"Price":%s,"Volume":%d}`, ftoa(ask+float64(i)*step, ins.Digits), 120000*(i+1)))
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
		log.Printf("%s %s", r.Method, r.URL.String())
		mux.ServeHTTP(w, r)
	})
	log.Printf("demo market + CRM simulator listening on %s (%d instruments)", *addr, len(instruments))
	log.Fatal(http.ListenAndServe(*addr, logged))
}
