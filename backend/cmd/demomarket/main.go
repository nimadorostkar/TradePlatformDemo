// Command demomarket is the platform's market-data source and demo broker.
//
// It stands in for BOTH upstreams the gateway speaks to — the MT5 Manager Web
// API and the CRM — on the same wire contracts (docs/ANALYSIS.md), so the
// gateway runs unmodified and never needs, or has, a connection to a trading
// server.
//
// Prices are REAL: by default FX and gold come from Yahoo Finance's public
// endpoints (yahoo.go — live FX, exchange-delayed gold futures, years of
// history) and crypto streams tick-by-tick from Binance's public WebSocket
// (binance.go), falling back to Yahoo when Binance is unreachable. No account
// or key anywhere. `-source synthetic` swaps in a deterministic generator for
// offline work and tests.
//
// The broker side is a demo execution engine (broker.go): market and pending
// orders fill against the live prices, stops and targets fire, margin is
// checked and equity follows the open positions. Nothing is real — the
// counterparty is this process — but the wire contract is MT5's.
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
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"os"
	"path"
	"strconv"
	"strings"
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
	return fmt.Sprintf(`{"Symbol":%q,"Path":%q,"Description":%q,"Sector":"Currency","Industry":"Forex","CurrencyBase":%q,"CurrencyProfit":%q,"Digits":%d,"Multiply":%d,"ContractSize":%d,"VolumeMin":%d,"VolumeMax":%d,"VolumeStep":%d,"VolumeMinExt":0,"SessionsTrades":%s}`,
		ins.Symbol, strings.ReplaceAll(ins.Path, `\`, `\\`), ins.Description, ins.Base, ins.Profit, ins.Digits, int64(multiply), int64(ins.contract()), volumeMin, volumeMax, volumeStep, ins.Sessions)
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
	// A list or a glob is never a symbol name; answer with a real instrument
	// rather than minting one called "EURUSD,USDJPY,…".
	if name == "" || strings.ContainsAny(name, `*?\,`) {
		return bySymbol["EURUSD"], true
	}
	clone := *bySymbol["EURUSD"]
	clone.Symbol = name
	clone.Path = `Forex\Other\` + name
	clone.Description = name
	return &clone, false
}

// matchesMask applies an MT5 symbol mask: comma-separated globs, case-
// insensitive, a bare name matching exactly.
func matchesMask(mask, symbol string) bool {
	for _, part := range strings.Split(strings.ToUpper(mask), ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		if ok, err := path.Match(part, symbol); err == nil && ok {
			return true
		}
	}
	return false
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

// userDTO is the profile as the CRM reports it to the client and the admin.
func userDTO(u *User) map[string]any {
	return map[string]any{
		"id": u.ID, "email": u.Email, "name": u.Name,
		"phone": u.Phone, "country": u.Country, "city": u.City,
		"language": u.Language, "timezone": u.Timezone,
		"kycStatus": u.KYCStatus, "createdAt": u.CreatedAt, "updatedAt": u.UpdatedAt,
	}
}

// accountDTO is a trading account with its live figures from the broker.
func accountDTO(a Account, broker *demoBroker) map[string]any {
	s := broker.Summary(a.Login)
	return map[string]any{
		"login": strconv.FormatInt(a.Login, 10), "typeId": a.TypeID, "currency": a.Currency,
		"balance": a.Balance, "equity": s.Equity, "margin": s.Margin, "marginFree": s.MarginFree,
		"leverage": s.Leverage, "openPositions": s.Positions, "pendingOrders": s.Orders,
		"createdAt": a.CreatedAt,
	}
}

// startingBalance is what an account is funded with on a reset: the seeded
// logins keep their documented amounts, everyone else the sign-up funding.
func startingBalance(a Account) float64 {
	for _, seed := range seedAccounts {
		if seed.Login == a.Login {
			return seed.Balance
		}
	}
	return demoStartBalance
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
		var crypto []*instrument
		for _, ins := range instruments {
			if ins.Binance != "" {
				crypto = append(crypto, ins)
			}
		}
		bn := newBinanceProvider(crypto)
		bn.Start(context.Background())
		provider = compositeProvider{binance: bn, yahoo: y}
	default:
		log.Fatalf("unknown -source %q (live|synthetic)", *source)
	}
	// User management: PostgreSQL when USERS_DSN is set, otherwise in-memory
	// with the same seed (a laptop without a database still signs in).
	var users UserStore
	if dsn := os.Getenv("USERS_DSN"); dsn != "" {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		pg, err := openPGStore(ctx, dsn)
		cancel()
		if err != nil {
			log.Fatalf("users: cannot open USERS_DSN: %v", err)
		}
		users = pg
	} else {
		users = newMemStore()
	}
	adminToken := os.Getenv("ADMIN_TOKEN")

	// The execution engine. BROKER_STATE_FILE keeps positions, orders and
	// history across restarts; without it the book starts empty each run.
	broker := newDemoBroker(provider, users, os.Getenv("BROKER_STATE_FILE"))
	go broker.Run(context.Background())

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

	// ── Demo broker: positions, orders, deals, account ───────────────────────
	q := func(r *http.Request, name string) string { return r.URL.Query().Get(name) }
	qi := func(r *http.Request, name string) int64 {
		v, _ := strconv.ParseInt(q(r, name), 10, 64)
		return v
	}
	qf := func(r *http.Request, name string) float64 {
		v, _ := strconv.ParseFloat(q(r, name), 64)
		return v
	}
	loginOf := func(r *http.Request) int64 { return qi(r, "login") }
	readBody := func(w http.ResponseWriter, r *http.Request) []byte {
		body, _ := io.ReadAll(http.MaxBytesReader(w, r.Body, 64<<10))
		return body
	}
	mux.HandleFunc("/api/position/get", func(w http.ResponseWriter, r *http.Request) {
		j(w, broker.Position(loginOf(r), q(r, "symbol")))
	})
	mux.HandleFunc("/api/position/get_page", func(w http.ResponseWriter, r *http.Request) {
		j(w, broker.Positions(loginOf(r), int(qi(r, "offset")), int(qi(r, "total"))))
	})
	mux.HandleFunc("/api/position/get_total", func(w http.ResponseWriter, r *http.Request) {
		j(w, fmt.Sprintf(`{"retcode":"0 Done","answer":{"total":%d}}`, broker.PositionCount(loginOf(r))))
	})
	mux.HandleFunc("/api/order/get", func(w http.ResponseWriter, r *http.Request) {
		j(w, broker.Order(qi(r, "ticket")))
	})
	mux.HandleFunc("/api/order/get_page", func(w http.ResponseWriter, r *http.Request) {
		j(w, broker.Orders(loginOf(r), int(qi(r, "offset")), int(qi(r, "total"))))
	})
	mux.HandleFunc("/api/order/get_total", func(w http.ResponseWriter, r *http.Request) {
		j(w, fmt.Sprintf(`{"retcode":"0 Done","answer":{"total":%d}}`, broker.OrderCount(loginOf(r))))
	})
	mux.HandleFunc("/api/history/get_page", func(w http.ResponseWriter, r *http.Request) {
		j(w, broker.History(loginOf(r), qi(r, "from"), qi(r, "to"), int(qi(r, "offset")), int(qi(r, "total"))))
	})
	mux.HandleFunc("/api/deal/get_page", func(w http.ResponseWriter, r *http.Request) {
		j(w, broker.Deals(loginOf(r), qi(r, "from"), qi(r, "to"), int(qi(r, "offset")), int(qi(r, "total"))))
	})
	mux.HandleFunc("/api/user/get", func(w http.ResponseWriter, r *http.Request) {
		login := loginOf(r)
		name := "Demo Trader"
		if a, ok := users.AccountByLogin(r.Context(), login); ok {
			if u, ok := users.UserByID(r.Context(), a.UserID); ok && u.Name != "" {
				name = u.Name
			}
		}
		j(w, broker.User(login, name))
	})
	mux.HandleFunc("/api/user/update", func(w http.ResponseWriter, r *http.Request) {
		j(w, broker.UpdateUser(readBody(w, r)))
	})
	mux.HandleFunc("/api/user/account/get", func(w http.ResponseWriter, r *http.Request) {
		j(w, broker.Account(loginOf(r)))
	})
	mux.HandleFunc("/api/trade/check_margin", func(w http.ResponseWriter, r *http.Request) {
		j(w, broker.CheckMargin(loginOf(r), q(r, "symbol"), int(qi(r, "type")), qi(r, "volume"), qf(r, "price")))
	})
	mux.HandleFunc("/api/trade/calc_profit", func(w http.ResponseWriter, r *http.Request) {
		j(w, broker.CalcProfit(q(r, "symbol"), int(qi(r, "type")), qi(r, "volume"), qf(r, "price_open"), qf(r, "price_close")))
	})
	mux.HandleFunc("/api/trade/balance", func(w http.ResponseWriter, r *http.Request) {
		j(w, broker.Balance(loginOf(r), qf(r, "balance"), q(r, "comment")))
	})
	// The dealer: a request gets an id, and its result is polled by that id —
	// the two-step MT5 contract the gateway's TradeService implements.
	mux.HandleFunc("/api/dealer/send_request", func(w http.ResponseWriter, r *http.Request) {
		id, retcode := broker.Submit(readBody(w, r))
		if retcode != "" {
			j(w, fmt.Sprintf(`{"retcode":%q}`, retcode))
			return
		}
		j(w, fmt.Sprintf(`{"retcode":"0 Done","answer":{"Id":%d}}`, id))
	})
	mux.HandleFunc("/api/dealer/get_request_result", func(w http.ResponseWriter, r *http.Request) {
		id := qi(r, "id")
		result, ok := broker.Result(id)
		if !ok {
			j(w, `{"retcode":"13 Not found","answer":null}`)
			return
		}
		j(w, fmt.Sprintf(`{"retcode":"0 Done","answer":{"%d":[{"result":"0"},{"result":"0","answer":%s}]}}`, id, result))
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
			// MT5 masks are a comma-separated list of globs ("*EUR*,XAU*");
			// the gateway substitutes its default symbol list for an empty
			// search. Only real matches are returned — never an invented one.
			var rows []string
			for _, ins := range instruments {
				if matchesMask(mask, ins.Symbol) {
					rows = append(rows, symbolJSON(ins))
				}
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

	// ── CRM: users, sessions, accounts ───────────────────────────────────────
	writeJSON := func(w http.ResponseWriter, status int, v any) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(v)
	}
	mux.HandleFunc("/client-api/login", func(w http.ResponseWriter, r *http.Request) {
		var req struct{ Email, Password string }
		_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req)
		_, token, err := users.Authenticate(r.Context(), req.Email, req.Password)
		switch {
		case err == nil:
			writeJSON(w, http.StatusOK, map[string]string{"accessToken": token})
		case errors.Is(err, errBadCredentials), errors.Is(err, errDisabled):
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid credentials"})
		default:
			log.Printf("users: login: %v", err)
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "user store unavailable"})
		}
	})
	// Self-service registration: a new user with one funded demo account.
	mux.HandleFunc("/client-api/register", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		var req struct {
			Email, Password string
			Profile
		}
		_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req)
		u, err := users.Register(r.Context(), req.Email, req.Password, req.Profile)
		switch {
		case err == nil:
			accounts, _ := users.Accounts(r.Context(), u.ID)
			logins := make([]int64, 0, len(accounts))
			for _, a := range accounts {
				logins = append(logins, a.Login)
			}
			writeJSON(w, http.StatusCreated, map[string]any{"id": u.ID, "email": u.Email, "name": u.Name, "accounts": logins, "user": userDTO(u)})
		case errors.Is(err, errEmailTaken):
			writeJSON(w, http.StatusConflict, map[string]string{"error": "email already registered"})
		case errors.Is(err, errInvalidInput):
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		default:
			log.Printf("users: register: %v", err)
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "user store unavailable"})
		}
	})
	bearer := func(r *http.Request) string {
		return strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	}
	mux.HandleFunc("/client-api/accounts", func(w http.ResponseWriter, r *http.Request) {
		u, ok := users.UserBySession(r.Context(), bearer(r))
		if !ok {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		accounts, err := users.Accounts(r.Context(), u.ID)
		if err != nil {
			log.Printf("users: accounts: %v", err)
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		out := make([]map[string]any, 0, len(accounts))
		for _, a := range accounts {
			row := accountDTO(a, broker)
			row["isEnabled"] = true
			out = append(out, row)
		}
		writeJSON(w, http.StatusOK, out)
	})
	// The user's own profile: GET reads it, PUT/PATCH replaces the editable
	// fields (name, phone, country, city, language, timezone).
	mux.HandleFunc("/client-api/me", func(w http.ResponseWriter, r *http.Request) {
		u, ok := users.UserBySession(r.Context(), bearer(r))
		if !ok {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		switch r.Method {
		case http.MethodGet:
			writeJSON(w, http.StatusOK, userDTO(u))
		case http.MethodPut, http.MethodPatch:
			var p Profile
			if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&p); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
				return
			}
			updated, err := users.UpdateProfile(r.Context(), u.ID, p)
			switch {
			case err == nil:
				writeJSON(w, http.StatusOK, userDTO(updated))
			case errors.Is(err, errInvalidInput):
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			default:
				log.Printf("users: update profile: %v", err)
				writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "user store unavailable"})
			}
		default:
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
	})
	// POST {currentPassword, newPassword}: other sessions are revoked.
	mux.HandleFunc("/client-api/password", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		u, ok := users.UserBySession(r.Context(), bearer(r))
		if !ok {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		var req struct{ CurrentPassword, NewPassword string }
		_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req)
		err := users.ChangePassword(r.Context(), u.ID, req.CurrentPassword, req.NewPassword)
		switch {
		case err == nil:
			writeJSON(w, http.StatusOK, map[string]bool{"changed": true})
		case errors.Is(err, errBadCredentials):
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "current password is wrong"})
		case errors.Is(err, errInvalidInput):
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		default:
			log.Printf("users: change password: %v", err)
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "user store unavailable"})
		}
	})

	// ── Admin (ADMIN_TOKEN): list users, enable/disable ──────────────────────
	adminOnly := func(next http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			if adminToken == "" || bearer(r) != adminToken {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			next(w, r)
		}
	}
	mux.HandleFunc("/admin/users", adminOnly(func(w http.ResponseWriter, r *http.Request) {
		list, err := users.ListUsers(r.Context())
		if err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		out := make([]map[string]any, 0, len(list))
		for _, u := range list {
			u := u
			row := userDTO(&u)
			row["enabled"] = u.Enabled
			row["lastLoginAt"] = u.LastLoginAt
			accounts, _ := users.Accounts(r.Context(), u.ID)
			rows := make([]map[string]any, 0, len(accounts))
			for _, a := range accounts {
				rows = append(rows, accountDTO(a, broker))
			}
			row["accounts"] = rows
			out = append(out, row)
		}
		writeJSON(w, http.StatusOK, out)
	}))
	mux.HandleFunc("/admin/users/", adminOnly(func(w http.ResponseWriter, r *http.Request) {
		// POST /admin/users/{id}/enabled {"enabled": false}
		// POST /admin/users/{id}/kyc     {"status": "verified"}
		// POST /admin/users/{id}/reset   — the user's accounts back to their
		//                                   funded, empty starting state
		parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/admin/users/"), "/")
		id, err := strconv.ParseInt(parts[0], 10, 64)
		if err != nil || len(parts) != 2 || r.Method != http.MethodPost {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		switch parts[1] {
		case "enabled":
			var req struct{ Enabled bool }
			_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024)).Decode(&req)
			if err := users.SetEnabled(r.Context(), id, req.Enabled); err != nil {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{"id": id, "enabled": req.Enabled})
		case "kyc":
			var req struct{ Status string }
			_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024)).Decode(&req)
			switch err := users.SetKYC(r.Context(), id, req.Status); {
			case err == nil:
				writeJSON(w, http.StatusOK, map[string]any{"id": id, "kycStatus": req.Status})
			case errors.Is(err, errInvalidInput):
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "status must be unverified, pending or verified"})
			default:
				w.WriteHeader(http.StatusNotFound)
			}
		case "reset":
			accounts, err := users.Accounts(r.Context(), id)
			if err != nil || len(accounts) == 0 {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			rows := make([]map[string]any, 0, len(accounts))
			for _, a := range accounts {
				balance := startingBalance(a)
				broker.Reset(a.Login, balance)
				a.Balance = balance
				rows = append(rows, accountDTO(a, broker))
			}
			log.Printf("admin: user %d reset (%d accounts)", id, len(accounts))
			writeJSON(w, http.StatusOK, map[string]any{"id": id, "accounts": rows})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))

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
	log.Printf("demo market + CRM listening on %s — prices: %s, %d instruments; users: %s; admin API: %v", *addr, provider.Name(), len(instruments), users.Name(), adminToken != "")
	log.Fatal(http.ListenAndServe(*addr, logged))
}
