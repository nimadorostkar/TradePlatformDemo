package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// fixedProvider quotes whatever the test sets, so fills and triggers are
// deterministic.
type fixedProvider struct{ ticks map[string]Tick }

func (p *fixedProvider) Name() string { return "fixed" }
func (p *fixedProvider) Tick(ins *instrument) (Tick, bool) {
	t, ok := p.ticks[ins.Symbol]
	return t, ok
}
func (p *fixedProvider) Bars(*instrument, int64, int64) []Bar { return nil }
func (p *fixedProvider) set(symbol string, bid, ask float64) {
	p.ticks[symbol] = Tick{Bid: bid, Ask: ask, At: time.Now()}
}

func newTestBroker(t *testing.T) (*demoBroker, *fixedProvider, *memStore) {
	t.Helper()
	p := &fixedProvider{ticks: map[string]Tick{}}
	p.set("EURUSD", 1.10000, 1.10010)
	p.set("USDJPY", 150.000, 150.012)
	p.set("XAUUSD", 2400.00, 2400.30)
	users := newMemStore()
	b := newDemoBroker(p, users, "")
	return b, p, users
}

// submit sends a dealer request and returns the polled PlaceOrderAnswer.
func submit(t *testing.T, b *demoBroker, req map[string]any) map[string]any {
	t.Helper()
	body, _ := json.Marshal(req)
	id, rc := b.Submit(body)
	if rc != "" {
		t.Fatalf("submit refused outright: %s", rc)
	}
	raw, ok := b.Result(id)
	if !ok {
		t.Fatalf("no result for request %d", id)
	}
	var an map[string]any
	if err := json.Unmarshal([]byte(raw), &an); err != nil {
		t.Fatalf("result %s is not JSON: %v", raw, err)
	}
	return an
}

func retcode(an map[string]any) string { return an["ResultRetcode"].(string) }

func wantRetcode(t *testing.T, an map[string]any, prefix string) {
	t.Helper()
	if !strings.HasPrefix(retcode(an), prefix) {
		t.Fatalf("retcode = %q, want %s…", retcode(an), prefix)
	}
}

func summaryOf(t *testing.T, b *demoBroker, login int64) map[string]any {
	t.Helper()
	var root struct{ Answer map[string]any }
	if err := json.Unmarshal([]byte(b.Account(login)), &root); err != nil {
		t.Fatal(err)
	}
	return root.Answer
}

func num(v any) float64 {
	switch x := v.(type) {
	case float64:
		return x
	case string:
		var f float64
		fmt.Sscanf(x, "%g", &f)
		return f
	}
	return 0
}

func TestMarketOrderOpensPositionAndSettlesOnClose(t *testing.T) {
	b, p, users := newTestBroker(t)

	an := submit(t, b, map[string]any{"Action": "200", "Login": "1010", "Symbol": "EURUSD", "Type": 0, "Volume": 10000, "PriceSL": 1.09, "PriceTP": 1.12})
	wantRetcode(t, an, "10009")
	if num(an["ResultPrice"]) != 1.10010 {
		t.Fatalf("buy filled at %v, want the ask 1.10010", an["ResultPrice"])
	}
	ticket := int64(num(an["Order"]))

	// One position, valued at bid, with margin 1 lot × 100000 × 1.1 / 100.
	s := summaryOf(t, b, 1010)
	if got := num(s["Margin"]); got != 1100.1 {
		t.Fatalf("margin = %v, want 1100.10", got)
	}
	if got := num(s["Profit"]); got != -10 {
		t.Fatalf("floating profit = %v, want -10 (the spread)", got)
	}
	if b.PositionCount(1010) != 1 {
		t.Fatalf("positions = %d, want 1", b.PositionCount(1010))
	}

	// Price rallies 50 pips; close half, then the rest.
	p.set("EURUSD", 1.10510, 1.10520)
	an = submit(t, b, map[string]any{"Action": "200", "Login": "1010", "Symbol": "EURUSD", "Type": 1, "Volume": 5000, "Position": ticket})
	wantRetcode(t, an, "10009")
	if b.PositionCount(1010) != 1 {
		t.Fatal("partial close removed the position")
	}
	a, _ := users.AccountByLogin(nil, 1010)
	if a.Balance != demoStartBalance+250 {
		t.Fatalf("balance after partial close = %v, want %v", a.Balance, demoStartBalance+250)
	}
	an = submit(t, b, map[string]any{"Action": "200", "Login": "1010", "Symbol": "EURUSD", "Type": 1, "Volume": 5000, "Position": ticket})
	wantRetcode(t, an, "10009")
	if b.PositionCount(1010) != 0 {
		t.Fatal("full close left the position open")
	}
	a, _ = users.AccountByLogin(nil, 1010)
	if a.Balance != demoStartBalance+500 {
		t.Fatalf("balance after close = %v, want %v", a.Balance, demoStartBalance+500)
	}

	// Closing again is refused: the position is gone.
	an = submit(t, b, map[string]any{"Action": "200", "Login": "1010", "Symbol": "EURUSD", "Type": 1, "Volume": 5000, "Position": ticket})
	wantRetcode(t, an, "10036")

	// Three orders and three deals were booked (open, two closes).
	var hist struct{ Answer []map[string]any }
	_ = json.Unmarshal([]byte(b.History(1010, 0, 0, 0, 0)), &hist)
	if len(hist.Answer) != 3 {
		t.Fatalf("history has %d orders, want 3", len(hist.Answer))
	}
	var deals struct{ Answer []map[string]any }
	_ = json.Unmarshal([]byte(b.Deals(1010, 0, 0, 0, 0)), &deals)
	if len(deals.Answer) != 3 || num(deals.Answer[2]["Profit"]) != 250 || num(deals.Answer[2]["Entry"]) != 1 {
		t.Fatalf("deals = %v", deals.Answer)
	}
}

func TestValidationRetcodes(t *testing.T) {
	b, _, _ := newTestBroker(t)
	cases := []struct {
		name string
		req  map[string]any
		want string
	}{
		{"unknown login", map[string]any{"Action": "200", "Login": 9, "Symbol": "EURUSD", "Type": 0, "Volume": 10000}, "10013"},
		{"volume below minimum", map[string]any{"Action": "200", "Login": 1010, "Symbol": "EURUSD", "Type": 0, "Volume": 500}, "10014"},
		{"volume off the step", map[string]any{"Action": "200", "Login": 1010, "Symbol": "EURUSD", "Type": 0, "Volume": 1500}, "10014"},
		{"no money", map[string]any{"Action": "200", "Login": 3030, "Symbol": "EURUSD", "Type": 0, "Volume": 5000000}, "10019"},
		{"stops on the wrong side", map[string]any{"Action": "200", "Login": 1010, "Symbol": "EURUSD", "Type": 0, "Volume": 10000, "PriceSL": 1.2}, "10016"},
		{"buy limit above the market", map[string]any{"Action": "201", "Login": 1010, "Symbol": "EURUSD", "Type": 2, "Volume": 10000, "PriceOrder": 1.2}, "10015"},
		{"sell stop above the market", map[string]any{"Action": "201", "Login": 1010, "Symbol": "EURUSD", "Type": 5, "Volume": 10000, "PriceOrder": 1.2}, "10015"},
		{"pending with a market type", map[string]any{"Action": "201", "Login": 1010, "Symbol": "EURUSD", "Type": 0, "Volume": 10000, "PriceOrder": 1.09}, "10035"},
		{"unknown symbol", map[string]any{"Action": "200", "Login": 1010, "Symbol": "NOPE", "Type": 0, "Volume": 10000}, "10013"},
		{"unknown action", map[string]any{"Action": "999", "Login": 1010, "Symbol": "EURUSD"}, "10013"},
		{"cancel unknown order", map[string]any{"Action": "204", "Login": 1010, "Order": 42}, "10013"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) { wantRetcode(t, submit(t, b, tc.req), tc.want) })
	}
	if b.PositionCount(1010) != 0 || b.OrderCount(1010) != 0 {
		t.Fatal("a refused request left state behind")
	}
}

func TestStopLossAndTakeProfitFire(t *testing.T) {
	b, p, users := newTestBroker(t)
	an := submit(t, b, map[string]any{"Action": "200", "Login": "1010", "Symbol": "EURUSD", "Type": 1, "Volume": 20000, "PriceSL": 1.105, "PriceTP": 1.095})
	wantRetcode(t, an, "10009")

	// Modify the stops, then move the market through the take profit.
	ticket := int64(num(an["Order"]))
	an = submit(t, b, map[string]any{"Action": "202", "Login": "1010", "Symbol": "EURUSD", "Type": 1, "Position": ticket, "PriceSL": 1.106, "PriceTP": 1.0955})
	wantRetcode(t, an, "10009")
	an = submit(t, b, map[string]any{"Action": "202", "Login": "1010", "Symbol": "EURUSD", "Type": 1, "Position": ticket, "PriceSL": 1.106, "PriceTP": 1.0955})
	wantRetcode(t, an, "10025")

	b.evaluate()
	if b.PositionCount(1010) != 1 {
		t.Fatal("position closed with the market untouched")
	}
	p.set("EURUSD", 1.09540, 1.09550) // ask ≤ TP 1.0955 → a sell's target
	b.evaluate()
	if b.PositionCount(1010) != 0 {
		t.Fatal("take profit did not close the sell")
	}
	a, _ := users.AccountByLogin(nil, 1010)
	// Sold 2 lots at 1.10000, bought back at 1.09550: 45 pips × 2 × $10.
	if a.Balance != demoStartBalance+900 {
		t.Fatalf("balance = %v, want %v", a.Balance, demoStartBalance+900)
	}
	var deals struct{ Answer []map[string]any }
	_ = json.Unmarshal([]byte(b.Deals(1010, 0, 0, 0, 0)), &deals)
	if got := deals.Answer[len(deals.Answer)-1]["Comment"]; got != "[tp]" {
		t.Fatalf("closing deal comment = %v, want [tp]", got)
	}
}

func TestPendingOrderLifecycle(t *testing.T) {
	b, p, _ := newTestBroker(t)

	// A buy limit under the market rests…
	an := submit(t, b, map[string]any{"Action": "201", "Login": "1010", "Symbol": "EURUSD", "Type": 2, "Volume": 10000, "PriceOrder": 1.095, "PriceTP": 1.11})
	wantRetcode(t, an, "10008")
	limit := int64(num(an["Order"]))
	b.evaluate()
	if b.OrderCount(1010) != 1 || b.PositionCount(1010) != 0 {
		t.Fatal("resting limit was not left alone")
	}

	// …can be moved (a modify carries the whole SL/TP set, as MT5's does)…
	an = submit(t, b, map[string]any{"Action": "203", "Login": "1010", "Order": limit, "Symbol": "EURUSD", "Type": 2, "PriceOrder": 1.097, "PriceTP": 1.11, "Volume": 20000})
	wantRetcode(t, an, "10009")
	var orders struct{ Answer []map[string]any }
	_ = json.Unmarshal([]byte(b.Orders(1010, 0, 0)), &orders)
	if num(orders.Answer[0]["PriceOrder"]) != 1.097 || num(orders.Answer[0]["VolumeCurrent"]) != 20000 {
		t.Fatalf("modified order = %v", orders.Answer[0])
	}

	// …and fills when the ask reaches it, at no worse than its price.
	p.set("EURUSD", 1.09680, 1.09690)
	b.evaluate()
	if b.OrderCount(1010) != 0 || b.PositionCount(1010) != 1 {
		t.Fatal("limit did not fill")
	}
	var positions struct{ Answer []map[string]any }
	_ = json.Unmarshal([]byte(b.Positions(1010, 0, 0)), &positions)
	if num(positions.Answer[0]["PriceOpen"]) != 1.0969 || num(positions.Answer[0]["PriceTP"]) != 1.11 {
		t.Fatalf("filled position = %v", positions.Answer[0])
	}
	var hist struct{ Answer []map[string]any }
	_ = json.Unmarshal([]byte(b.History(1010, 0, 0, 0, 0)), &hist)
	if num(hist.Answer[0]["State"]) != stateFilled || hist.Answer[0]["Order"] != fmt.Sprint(limit) {
		t.Fatalf("history = %v", hist.Answer)
	}

	// A sell stop is cancelled; an expired GTD order lapses on its own.
	an = submit(t, b, map[string]any{"Action": "201", "Login": "1010", "Symbol": "EURUSD", "Type": 5, "Volume": 10000, "PriceOrder": 1.09})
	wantRetcode(t, an, "10008")
	an = submit(t, b, map[string]any{"Action": "204", "Login": "1010", "Order": int64(num(an["Order"])), "Symbol": "EURUSD", "Type": 5})
	wantRetcode(t, an, "10009")
	an = submit(t, b, map[string]any{"Action": "201", "Login": "1010", "Symbol": "EURUSD", "Type": 4, "Volume": 10000, "PriceOrder": 1.2, "TypeTime": 2, "TimeExpiration": time.Now().Add(time.Second).Unix()})
	wantRetcode(t, an, "10008")
	if b.OrderCount(1010) != 1 {
		t.Fatal("GTD order not resting")
	}
	b.mu.Lock()
	for _, o := range b.accounts[1010].Orders {
		o.TimeExpiration = time.Now().Add(-time.Second).Unix()
	}
	b.mu.Unlock()
	b.evaluate()
	if b.OrderCount(1010) != 0 {
		t.Fatal("expired order still resting")
	}
	_ = json.Unmarshal([]byte(b.History(1010, 0, 0, 0, 0)), &hist)
	states := map[float64]int{}
	for _, o := range hist.Answer {
		states[num(o["State"])]++
	}
	if states[stateFilled] != 1 || states[stateCanceled] != 1 || states[stateExpired] != 1 {
		t.Fatalf("history states = %v", states)
	}
}

func TestStopOutClosesLosers(t *testing.T) {
	b, p, _ := newTestBroker(t)
	// 5000 USD account, 1:100: 4 lots of EURUSD need 4400 margin.
	an := submit(t, b, map[string]any{"Action": "200", "Login": "3030", "Symbol": "EURUSD", "Type": 0, "Volume": 40000})
	wantRetcode(t, an, "10009")
	// Bought at 1.10010; a bid of 1.09000 is 101 pips against, costing 4040:
	// equity 960 against margin 4400 is 22 %, well under the 50 % stop-out.
	p.set("EURUSD", 1.09000, 1.09010)
	b.evaluate()
	if b.PositionCount(3030) != 0 {
		t.Fatal("stop-out did not close the position")
	}
	s := summaryOf(t, b, 3030)
	if num(s["Balance"]) != 960 || num(s["Margin"]) != 0 {
		t.Fatalf("after stop-out: %v", s)
	}
}

func TestCrossCurrencyProfitAndGoldContract(t *testing.T) {
	b, p, users := newTestBroker(t)
	// 1 lot USDJPY: a 1-yen move is ¥100000 = 100000/151 USD.
	an := submit(t, b, map[string]any{"Action": "200", "Login": "1010", "Symbol": "USDJPY", "Type": 0, "Volume": 10000})
	wantRetcode(t, an, "10009")
	p.set("USDJPY", 151.012, 151.024)
	an = submit(t, b, map[string]any{"Action": "200", "Login": "1010", "Symbol": "USDJPY", "Type": 1, "Volume": 10000, "Position": int64(num(an["Order"]))})
	wantRetcode(t, an, "10009")
	a, _ := users.AccountByLogin(nil, 1010)
	if got := a.Balance - demoStartBalance; got < 662 || got > 663 {
		t.Fatalf("USDJPY profit = %v, want ≈ 662.20", got)
	}

	// Gold is a 100 oz contract: 0.1 lot × 100 oz × $2400 / 100 = $240 margin.
	an = submit(t, b, map[string]any{"Action": "200", "Login": "2020", "Symbol": "XAUUSD", "Type": 0, "Volume": 1000})
	wantRetcode(t, an, "10009")
	if got := num(summaryOf(t, b, 2020)["Margin"]); got != 240.03 {
		t.Fatalf("gold margin = %v, want 240.03", got)
	}
}

func TestStateFileRoundTrip(t *testing.T) {
	file := filepath.Join(t.TempDir(), "state", "broker.json")
	p := &fixedProvider{ticks: map[string]Tick{}}
	p.set("EURUSD", 1.10000, 1.10010)
	b := newDemoBroker(p, newMemStore(), file)
	submit(t, b, map[string]any{"Action": "200", "Login": "1010", "Symbol": "EURUSD", "Type": 0, "Volume": 10000})
	submit(t, b, map[string]any{"Action": "201", "Login": "1010", "Symbol": "EURUSD", "Type": 2, "Volume": 10000, "PriceOrder": 1.09})
	b.save()
	if _, err := os.Stat(file); err != nil {
		t.Fatal(err)
	}

	users := newMemStore()
	again := newDemoBroker(p, users, file)
	if again.PositionCount(1010) != 1 || again.OrderCount(1010) != 1 {
		t.Fatal("state not restored")
	}
	// Tickets continue where they left off, so nothing is ever reissued.
	an := submit(t, again, map[string]any{"Action": "200", "Login": "1010", "Symbol": "EURUSD", "Type": 0, "Volume": 10000})
	if int64(num(an["Order"])) <= 600003 {
		t.Fatalf("ticket %v reused after restore", an["Order"])
	}
	if _, rc := again.Submit([]byte("not json")); !strings.HasPrefix(rc, "10013") {
		t.Fatalf("malformed body → %q, want 10013", rc)
	}
}
