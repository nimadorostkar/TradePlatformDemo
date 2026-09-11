// Command mockmt5 is a local stand-in for the MT5 Manager Web API and the
// OpoFinance CRM, faithful to the wire contracts the gateway consumes
// (docs/ANALYSIS.md). It serves the auth handshake (auth/start → auth/answer
// with a session cookie), the ping path, every data path in
// internal/mt5/apiurl.go with realistically-shaped bodies, and the CRM
// login/accounts flow.
//
// Usage: go run ./scripts/mockmt5 [-addr :5199]
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
	"net/http"
	"strings"
	"sync/atomic"
)

var requests atomic.Int64

func j(w http.ResponseWriter, body string) {
	w.Header().Set("Content-Type", "application/json")
	fmt.Fprint(w, body)
}

const (
	// Volumes are in MT5 units throughout: 10000 = 1 lot (docs/VOLUME-UNITS.md).
	orderRow  = `{"Order":"100001","ExternalID":"","Symbol":"EURUSD","State":1,"TimeSetup":1751500000,"Type":2,"PriceOrder":1.0800,"PriceSL":1.0700,"PriceTP":1.1000,"VolumeInitial":10000,"VolumeCurrent":10000,"Comment":"mock","side":0,"TypeTime":2,"TimeExpiration":1800000000}`
	posRow    = `{"Position":555001,"ExternalID":"","Login":1010,"Symbol":"EURUSD","Action":0,"TimeCreate":1751500000,"PriceOpen":1.0800,"PriceCurrent":1.0850,"PriceSL":1.0700,"PriceTP":1.1000,"Volume":10000,"Profit":50.0,"Storage":-1.25}`
	dealRow   = `{"Deal":"900001","Order":"100001","Login":1010,"Symbol":"EURUSD","Action":0,"Entry":0,"Price":1.0800,"Volume":10000,"Time":1751500000,"TimeMsc":1751500000000,"Commission":-3.5,"Storage":0,"Profit":0,"PositionID":"555001"}`
	symObj    = `{"Symbol":"EURUSD","Path":"Forex\\Majors\\EURUSD","Description":"Euro vs US Dollar","Sector":"Currency","Industry":"Forex","CurrencyBase":"EUR","Multiply":1,"VolumeMin":1000,"VolumeMax":5000000,"VolumeStep":1000,"VolumeMinExt":0,"SessionsTrades":[[{"Open":0,"Close":86400}]]}`
	tickRow   = `{"Symbol":"EURUSD","Datetime":"1751500000","Bid":1.0850,"Ask":1.0852,"Last":1.0851,"Volume":100}`
	placed    = `{"Order":"100002","ExternalID":"","Symbol":"EURUSD","Type":"0","Volume":10000,"PriceOrder":1.0800,"PriceSL":0,"PriceTP":0,"Comment":"mock","ResultRetcode":"10009 Done","ResultPrice":1.0850,"ResultVolume":10000,"TypeTime":0,"TimeExpiration":0}`
	genericOK = `{"retcode":"0 Done","answer":{"ok":true}}`
)

func main() {
	addr := flag.String("addr", ":5199", "listen address")
	flag.Parse()

	mux := http.NewServeMux()

	// ── MT5 auth handshake + ping ────────────────────────────────────────────
	mux.HandleFunc("/api/auth/start", func(w http.ResponseWriter, r *http.Request) {
		j(w, `{"retcode":"0 Done","srv_rand":"a1b2c3d4e5f60718293a4b5c6d7e8f90"}`)
	})
	mux.HandleFunc("/api/auth/answer", func(w http.ResponseWriter, r *http.Request) {
		http.SetCookie(w, &http.Cookie{Name: "MT5Session", Value: "mock-session-cookie"})
		j(w, `{"retcode":"0 Done","cli_rand_answer":"00"}`)
	})
	mux.HandleFunc("/api/test/access", func(w http.ResponseWriter, r *http.Request) {
		j(w, `{"retcode":"0 Done"}`)
	})

	// ── Order / History: array-of-order shapes for page endpoints ───────────
	mux.HandleFunc("/api/order/get_page", func(w http.ResponseWriter, r *http.Request) {
		j(w, `{"retcode":"0 Done","answer":[`+orderRow+`]}`)
	})
	mux.HandleFunc("/api/history/get_page", func(w http.ResponseWriter, r *http.Request) {
		j(w, `{"retcode":"0 Done","answer":[`+orderRow+`]}`)
	})
	mux.HandleFunc("/api/order/update", func(w http.ResponseWriter, r *http.Request) {
		j(w, `{"retcode":"0 Done","answer":{"Order":100001,"ExternalID":"","Login":1010,"Symbol":"EURUSD","PriceOrder":1.0800,"PriceSL":1.0700,"PriceTP":1.1000,"VolumeInitial":10000}}`)
	})

	// ── Position ─────────────────────────────────────────────────────────────
	mux.HandleFunc("/api/position/get", func(w http.ResponseWriter, r *http.Request) {
		j(w, `{"retcode":"0 Done","answer":`+posRow+`}`)
	})
	mux.HandleFunc("/api/position/get_page", func(w http.ResponseWriter, r *http.Request) {
		j(w, `{"retcode":"0 Done","answer":[`+posRow+`]}`)
	})
	mux.HandleFunc("/api/position/update", func(w http.ResponseWriter, r *http.Request) {
		j(w, `{"retcode":"0 Done","answer":`+posRow+`}`)
	})

	// ── User ─────────────────────────────────────────────────────────────────
	mux.HandleFunc("/api/user/get", func(w http.ResponseWriter, r *http.Request) {
		j(w, `{"retcode":"0 Done","answer":{"ID":"1010","Name":"Mock User"}}`)
	})
	mux.HandleFunc("/api/user/account/get", func(w http.ResponseWriter, r *http.Request) {
		j(w, `{"retcode":"0 Done","answer":{"Login":"1010","Balance":10000.50,"Equity":10050.50,"Profit":50.0}}`)
	})

	// ── Symbol ───────────────────────────────────────────────────────────────
	mux.HandleFunc("/api/symbol/list", func(w http.ResponseWriter, r *http.Request) {
		j(w, `{"retcode":"0 Done","answer":["EURUSD","XAUUSD","GBPUSD"]}`)
	})
	mux.HandleFunc("/api/symbol/get", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("mask") != "" {
			j(w, `{"retcode":"0 Done","answer":[`+symObj+`]}`)
			return
		}
		j(w, `{"retcode":"0 Done","answer":`+symObj+`}`)
	})
	mux.HandleFunc("/api/symbol/get_group", func(w http.ResponseWriter, r *http.Request) {
		j(w, `{"retcode":"0 Done","answer":`+symObj+`}`)
	})

	// ── Tick / Chart / Book ──────────────────────────────────────────────────
	mux.HandleFunc("/api/tick/last", func(w http.ResponseWriter, r *http.Request) {
		j(w, `{"retcode":"0 Done","trans_id":"1","answer":[`+tickRow+`]}`)
	})
	mux.HandleFunc("/api/tick/last_group", func(w http.ResponseWriter, r *http.Request) {
		j(w, `{"retcode":"0 Done","trans_id":"1","answer":[`+tickRow+`]}`)
	})
	mux.HandleFunc("/api/chart/get", func(w http.ResponseWriter, r *http.Request) {
		j(w, `{"retcode":"0 Done","answer":[[1751500000,1.0800,1.0900,1.0700,1.0850],[1751500060,1.0850,1.0950,1.0800,1.0900]]}`)
	})
	// Book side codes follow MQL5 ENUM_BOOK_TYPE (1=sell/ask, 2=buy/bid) and
	// volumes are in MT5 units (10000 = 1 lot), matching what the gateway
	// normalizes into the documented bids/asks ladder.
	mux.HandleFunc("/api/book/get", func(w http.ResponseWriter, r *http.Request) {
		j(w, `{"retcode":"0 Done","answer":{"Symbol":"EURUSD","Items":[`+
			`{"Type":2,"Price":1.0850,"Volume":100000},`+
			`{"Type":2,"Price":1.0849,"Volume":250000},`+
			`{"Type":1,"Price":1.0852,"Volume":120000},`+
			`{"Type":1,"Price":1.0853,"Volume":300000}]}}`)
	})

	// ── Deal (per-fill executions) ───────────────────────────────────────────
	mux.HandleFunc("/api/deal/get_page", func(w http.ResponseWriter, r *http.Request) {
		j(w, `{"retcode":"0 Done","answer":[`+dealRow+`]}`)
	})

	// ── Dealer (trade execution) ─────────────────────────────────────────────
	mux.HandleFunc("/api/dealer/send_request", func(w http.ResponseWriter, r *http.Request) {
		j(w, `{"retcode":"0 Done","answer":{"Id":777}}`)
	})
	mux.HandleFunc("/api/dealer/get_request_result", func(w http.ResponseWriter, r *http.Request) {
		j(w, `{"retcode":"0 Done","answer":{"777":[{"result":"0"},{"result":"0","answer":`+placed+`}]}}`)
	})

	// ── CRM ──────────────────────────────────────────────────────────────────
	mux.HandleFunc("/client-api/login", func(w http.ResponseWriter, r *http.Request) {
		var req struct{ Email, Password string }
		_ = json.NewDecoder(r.Body).Decode(&req)
		if strings.EqualFold(req.Email, "trader@opofinance.com") && req.Password == "correct-password" {
			j(w, `{"accessToken":"mock-crm-token"}`)
			return
		}
		w.WriteHeader(http.StatusUnauthorized)
		j(w, `{"error":"invalid credentials"}`)
	})
	mux.HandleFunc("/client-api/accounts", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer mock-crm-token" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		// The gateway's account policy keeps only types whose symbol suffix is
		// known — by default 57–67. typeId 1 is not a trading account, and
		// 11/26 are excluded until their suffix is confirmed (see
		// CRM_ALLOWED_ACCOUNT_TYPES).
		j(w, `[{"login":"1010","typeId":57},{"login":"2020","typeId":58},{"login":"3030","typeId":11},{"login":"9999","typeId":1}]`)
	})

	// ── Everything else under /api → generic raw-passthrough body ───────────
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") {
			j(w, genericOK)
			return
		}
		http.NotFound(w, r)
	})

	logged := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		log.Printf("%s %s", r.Method, r.URL.String())
		mux.ServeHTTP(w, r)
	})

	log.Printf("mock MT5+CRM listening on %s", *addr)
	log.Fatal(http.ListenAndServe(*addr, logged))
}
