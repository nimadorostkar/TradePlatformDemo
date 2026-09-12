package main

// The client area ("personal area") API: what a trader manages outside the
// terminal — their trading accounts, deposits, withdrawals and transfers,
// the transaction history, and the verification steps that unlock limits.
// All routes take the CRM bearer token; every account is checked to belong
// to the caller. Money here is demo money: deposits are credited instantly
// from nowhere, withdrawals vanish, and both are recorded like the real
// thing so the history reads the way a trader expects.

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// accountType is one entry of the "Open account" catalogue.
type accountType struct {
	ID          int     `json:"id"`
	Title       string  `json:"title"`
	Platform    string  `json:"platform"`
	Description string  `json:"description"`
	MaxLeverage int     `json:"maxLeverage"`
	MinDeposit  float64 `json:"minDeposit"`
}

// accountTypes are the demo broker's offer. The ids are the CRM type ids
// the gateway already knows (CRM_ACCOUNT_TYPE_SUFFIXES).
var accountTypes = []accountType{
	{ID: 57, Title: "Standard", Platform: "MT5", Description: "Low spreads and no commission — the account most traders start with.", MaxLeverage: 2000, MinDeposit: 10},
	{ID: 58, Title: "Pro", Platform: "MT5", Description: "Instant execution and tighter spreads for experienced traders.", MaxLeverage: 2000, MinDeposit: 200},
	{ID: 11, Title: "Standard Cent", Platform: "MT5", Description: "Cent lots, for learning with small amounts.", MaxLeverage: 2000, MinDeposit: 10},
}

func accountTypeByID(id int) (accountType, bool) {
	for _, t := range accountTypes {
		if t.ID == id {
			return t, true
		}
	}
	return accountType{}, false
}

// leverageChoices mirrors the terminal's Adjust control.
var leverageChoices = []int{50, 100, 200, 500, 1000, 2000}

func validLeverage(lev int) bool {
	for _, c := range leverageChoices {
		if c == lev {
			return true
		}
	}
	return false
}

// depositMethods and withdrawalMethods are the "payment systems" the demo
// offers. Nothing moves anywhere; the names make the history readable.
var depositMethods = []string{"Bank card", "Bank transfer", "Skrill", "Neteller", "USDT (TRC20)", "Bitcoin"}
var withdrawalMethods = []string{"Bank card", "Bank transfer", "Skrill", "Neteller", "USDT (TRC20)", "Bitcoin"}

func validMethod(method string, choices []string) bool {
	for _, c := range choices {
		if c == method {
			return true
		}
	}
	return false
}

// ── Verification ────────────────────────────────────────────────────────────

// Verification levels and what each unlocks. The numbers are the demo's;
// the shape — profile, then identity, then address, each raising the
// deposit ceiling — is every regulated broker's onboarding.
const (
	verificationNone     = 0 // fresh sign-up
	verificationProfile  = 1 // email, phone and personal details in place
	verificationIdentity = 2 // identity document verified
	verificationAddress  = 3 // residential address verified
)

var depositLimitByLevel = map[int]float64{
	verificationNone:     0,
	verificationProfile:  2000,
	verificationIdentity: 20000,
	// verificationAddress: no limit (absent from the map)
}

// kycReviewDelay is how long the demo's "compliance team" takes: the
// identity step sits at pending for this long, then verifies itself. A real
// CRM would have people (or a vendor) here; the admin API can still move
// the status by hand.
const kycReviewDelay = 20 * time.Second

func profileComplete(u *User) bool {
	return u.Name != "" && u.Phone != "" && u.Country != "" && u.City != ""
}

func verificationLevel(u *User) int {
	if !profileComplete(u) {
		return verificationNone
	}
	if u.KYCStatus != kycVerified {
		return verificationProfile
	}
	if u.AddressStatus != kycVerified {
		return verificationIdentity
	}
	return verificationAddress
}

// verificationDTO is what the Verification page draws.
func verificationDTO(u *User, deposited float64) map[string]any {
	level := verificationLevel(u)
	limit, limited := depositLimitByLevel[level]
	var depositLimit any
	var remaining any
	if limited {
		depositLimit = limit
		remaining = maxf(limit-deposited, 0)
	}
	profile := profileComplete(u)
	steps := []map[string]any{
		{
			"id": "profile", "title": "Confirm email and phone number. Add personal details",
			"status":  boolStatus(profile),
			"missing": missingProfileFields(u),
			"unlocks": []string{"Withdrawals", "Deposits up to 2,000 USD"},
		},
		{
			"id": "identity", "title": "Identity verification",
			"status":  u.KYCStatus,
			"unlocks": []string{"Deposits up to 20,000 USD"},
			"submitted": map[string]any{
				"documentType": u.IdentityDocType, "documentNumber": maskDocument(u.IdentityDocNumber), "dateOfBirth": u.DateOfBirth,
			},
		},
		{
			"id": "address", "title": "Residential address verification",
			"status":  u.AddressStatus,
			"unlocks": []string{"Unlimited deposits"},
			"submitted": map[string]any{
				"address": u.Address, "city": u.City, "postalCode": u.PostalCode, "country": u.Country,
			},
		},
	}
	complete := 0
	for _, st := range steps {
		if st["status"] == kycVerified {
			complete++
		}
	}
	return map[string]any{
		"level":              level,
		"verified":           level == verificationAddress,
		"stepsComplete":      complete,
		"stepsTotal":         len(steps),
		"steps":              steps,
		"depositLimit":       depositLimit, // null = unlimited
		"depositRemaining":   remaining,
		"depositedTotal":     round2(deposited),
		"withdrawalsEnabled": level >= verificationProfile,
	}
}

func boolStatus(ok bool) string {
	if ok {
		return kycVerified
	}
	return kycUnverified
}

func missingProfileFields(u *User) []string {
	var missing []string
	if u.Name == "" {
		missing = append(missing, "name")
	}
	if u.Phone == "" {
		missing = append(missing, "phone")
	}
	if u.Country == "" {
		missing = append(missing, "country")
	}
	if u.City == "" {
		missing = append(missing, "city")
	}
	if missing == nil {
		missing = []string{}
	}
	return missing
}

func maskDocument(n string) string {
	if len(n) <= 4 {
		return strings.Repeat("*", len(n))
	}
	return strings.Repeat("*", len(n)-4) + n[len(n)-4:]
}

func maxf(a, b float64) float64 {
	if a > b {
		return a
	}
	return b
}

// depositedTotal sums the user's deposits into real accounts, which is what
// the verification limits cap. Demo top-ups do not count.
func depositedTotal(txs []Transaction, accounts map[int64]Account) float64 {
	var sum float64
	for _, t := range txs {
		if t.Kind != "deposit" {
			continue
		}
		if a, ok := accounts[t.Login]; ok && a.Kind == accountKindDemo {
			continue
		}
		sum += t.Amount
	}
	return sum
}

// ── Handlers ────────────────────────────────────────────────────────────────

type clientArea struct {
	users  UserStore
	broker *demoBroker
	write  func(w http.ResponseWriter, status int, v any)
	bearer func(r *http.Request) string
}

func transactionDTO(t Transaction) map[string]any {
	return map[string]any{
		"id": t.ID, "login": strconv.FormatInt(t.Login, 10), "kind": t.Kind, "amount": t.Amount, "currency": t.Currency,
		"method": t.Method, "status": t.Status, "counterpart": strconv.FormatInt(t.Counterpart, 10), "comment": t.Comment,
		"createdAt": t.CreatedAt,
	}
}

// accountsByLogin loads the caller's accounts into a map; the ownership
// check every money route needs.
func (c *clientArea) accountsByLogin(r *http.Request, userID int64) (map[int64]Account, error) {
	list, err := c.users.Accounts(r.Context(), userID)
	if err != nil {
		return nil, err
	}
	out := make(map[int64]Account, len(list))
	for _, a := range list {
		out[a.Login] = a
	}
	return out, nil
}

func (c *clientArea) auth(w http.ResponseWriter, r *http.Request) (*User, bool) {
	u, ok := c.users.UserBySession(r.Context(), c.bearer(r))
	if !ok {
		w.WriteHeader(http.StatusUnauthorized)
	}
	return u, ok
}

func (c *clientArea) fail(w http.ResponseWriter, err error, what string) {
	switch {
	case errors.Is(err, errInvalidInput):
		c.write(w, http.StatusBadRequest, map[string]string{"error": strings.TrimPrefix(err.Error(), "invalid input: ")})
	case errors.Is(err, errNotFound):
		c.write(w, http.StatusNotFound, map[string]string{"error": "not found"})
	default:
		log.Printf("client area: %s: %v", what, err)
		c.write(w, http.StatusInternalServerError, map[string]string{"error": "user store unavailable"})
	}
}

func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8192)).Decode(v); err != nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"error":"invalid JSON"}`))
		return false
	}
	return true
}

func (c *clientArea) mount(mux *http.ServeMux) {
	mux.HandleFunc("/client-api/account-types", func(w http.ResponseWriter, r *http.Request) {
		c.write(w, http.StatusOK, map[string]any{
			"types": accountTypes, "leverages": leverageChoices, "currencies": []string{"USD"},
			"demoStartBalance": demoStartBalance,
			"depositMethods":   depositMethods, "withdrawalMethods": withdrawalMethods,
		})
	})

	// POST {typeId, kind, currency, leverage} → the new account. A demo
	// account opens funded; a real one opens empty, for Deposit to fill.
	mux.HandleFunc("/client-api/accounts/open", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		u, ok := c.auth(w, r)
		if !ok {
			return
		}
		var req struct {
			TypeID   int    `json:"typeId"`
			Kind     string `json:"kind"`
			Currency string `json:"currency"`
			Leverage int    `json:"leverage"`
		}
		if !decode(w, r, &req) {
			return
		}
		typ, known := accountTypeByID(req.TypeID)
		if !known {
			c.write(w, http.StatusBadRequest, map[string]string{"error": "unknown account type"})
			return
		}
		if !validAccountKind(req.Kind) {
			c.write(w, http.StatusBadRequest, map[string]string{"error": "kind must be real or demo"})
			return
		}
		if req.Currency == "" {
			req.Currency = "USD"
		}
		if req.Currency != "USD" {
			c.write(w, http.StatusBadRequest, map[string]string{"error": "only USD accounts are offered"})
			return
		}
		if req.Leverage == 0 {
			req.Leverage = defaultLeverage
		}
		if !validLeverage(req.Leverage) || req.Leverage > typ.MaxLeverage {
			c.write(w, http.StatusBadRequest, map[string]string{"error": "leverage is not one of the offered values"})
			return
		}
		balance := 0.0
		if req.Kind == accountKindDemo {
			balance = demoStartBalance
		}
		a, err := c.users.OpenAccount(r.Context(), u.ID, req.TypeID, req.Kind, req.Currency, balance)
		if err != nil {
			c.fail(w, err, "open account")
			return
		}
		// A new login has no history by definition. Resetting the engine's
		// record guards against a stale book under a reissued login (a
		// state file from another user store, say) leaking into the account.
		c.broker.Reset(a.Login, balance)
		c.broker.SetLeverage(a.Login, req.Leverage)
		log.Printf("client area: user %d opened %s %s account %d (1:%d)", u.ID, a.Kind, typ.Title, a.Login, req.Leverage)
		row := accountDTO(*a, c.broker)
		row["isEnabled"] = true
		c.write(w, http.StatusCreated, row)
	})

	// POST /client-api/accounts/{login}/trading-password {password}
	mux.HandleFunc("/client-api/accounts/", func(w http.ResponseWriter, r *http.Request) {
		rest := strings.TrimPrefix(r.URL.Path, "/client-api/accounts/")
		parts := strings.Split(rest, "/")
		if len(parts) != 2 || parts[1] != "trading-password" || r.Method != http.MethodPost {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		login, err := strconv.ParseInt(parts[0], 10, 64)
		if err != nil {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		u, ok := c.auth(w, r)
		if !ok {
			return
		}
		var req struct {
			Password string `json:"password"`
		}
		if !decode(w, r, &req) {
			return
		}
		if err := c.users.SetTradingPassword(r.Context(), u.ID, login, req.Password); err != nil {
			c.fail(w, err, "trading password")
			return
		}
		c.write(w, http.StatusOK, map[string]bool{"changed": true})
	})

	mux.HandleFunc("/client-api/deposit", func(w http.ResponseWriter, r *http.Request) {
		c.money(w, r, "deposit")
	})
	mux.HandleFunc("/client-api/withdraw", func(w http.ResponseWriter, r *http.Request) {
		c.money(w, r, "withdrawal")
	})
	mux.HandleFunc("/client-api/transfer", func(w http.ResponseWriter, r *http.Request) {
		c.money(w, r, "transfer")
	})

	mux.HandleFunc("/client-api/transactions", func(w http.ResponseWriter, r *http.Request) {
		u, ok := c.auth(w, r)
		if !ok {
			return
		}
		limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
		if limit <= 0 || limit > 500 {
			limit = 200
		}
		txs, err := c.users.Transactions(r.Context(), u.ID, limit)
		if err != nil {
			c.fail(w, err, "transactions")
			return
		}
		out := make([]map[string]any, 0, len(txs))
		for _, t := range txs {
			out = append(out, transactionDTO(t))
		}
		c.write(w, http.StatusOK, out)
	})

	mux.HandleFunc("/client-api/verification", func(w http.ResponseWriter, r *http.Request) {
		u, ok := c.auth(w, r)
		if !ok {
			return
		}
		c.writeVerification(w, r, u)
	})
	mux.HandleFunc("/client-api/verification/identity", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		u, ok := c.auth(w, r)
		if !ok {
			return
		}
		var req struct {
			DocumentType   string `json:"documentType"`
			DocumentNumber string `json:"documentNumber"`
			DateOfBirth    string `json:"dateOfBirth"`
		}
		if !decode(w, r, &req) {
			return
		}
		if !profileComplete(u) {
			c.write(w, http.StatusConflict, map[string]string{"error": "complete your profile first"})
			return
		}
		updated, err := c.users.SubmitIdentity(r.Context(), u.ID, req.DocumentType, req.DocumentNumber, req.DateOfBirth)
		if err != nil {
			c.fail(w, err, "identity")
			return
		}
		if updated.KYCStatus == kycPending {
			// The demo's compliance review: verified after a short wait, so the
			// pending state is visible but nobody is stuck in it.
			id := u.ID
			time.AfterFunc(kycReviewDelay, func() {
				if err := c.users.SetKYC(contextBackground(), id, kycVerified); err != nil {
					log.Printf("client area: auto-verify user %d: %v", id, err)
				} else {
					log.Printf("client area: user %d identity verified (demo review)", id)
				}
			})
		}
		c.writeVerification(w, r, updated)
	})
	mux.HandleFunc("/client-api/verification/address", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		u, ok := c.auth(w, r)
		if !ok {
			return
		}
		var req struct {
			Address    string `json:"address"`
			City       string `json:"city"`
			PostalCode string `json:"postalCode"`
			Country    string `json:"country"`
		}
		if !decode(w, r, &req) {
			return
		}
		if u.KYCStatus != kycVerified {
			c.write(w, http.StatusConflict, map[string]string{"error": "verify your identity first"})
			return
		}
		updated, err := c.users.SubmitAddress(r.Context(), u.ID, req.Address, req.City, req.PostalCode, req.Country)
		if err != nil {
			c.fail(w, err, "address")
			return
		}
		c.writeVerification(w, r, updated)
	})
}

func (c *clientArea) writeVerification(w http.ResponseWriter, r *http.Request, u *User) {
	txs, err := c.users.Transactions(r.Context(), u.ID, 500)
	if err != nil {
		c.fail(w, err, "verification")
		return
	}
	accounts, err := c.accountsByLogin(r, u.ID)
	if err != nil {
		c.fail(w, err, "verification")
		return
	}
	c.write(w, http.StatusOK, map[string]any{"user": userDTO(u), "verification": verificationDTO(u, depositedTotal(txs, accounts))})
}

// money handles deposit, withdrawal and transfer: one shape of request,
// ownership and limit checks, then the broker moves the balance and the
// store records what happened.
func (c *clientArea) money(w http.ResponseWriter, r *http.Request, kind string) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	u, ok := c.auth(w, r)
	if !ok {
		return
	}
	var req struct {
		Login  json.Number `json:"login"`
		From   json.Number `json:"from"`
		To     json.Number `json:"to"`
		Amount float64     `json:"amount"`
		Method string      `json:"method"`
	}
	if !decode(w, r, &req) {
		return
	}
	amount := round2(req.Amount)
	if !(amount > 0) || amount > 1_000_000 {
		c.write(w, http.StatusBadRequest, map[string]string{"error": "amount must be between 0.01 and 1,000,000"})
		return
	}
	accounts, err := c.accountsByLogin(r, u.ID)
	if err != nil {
		c.fail(w, err, kind)
		return
	}
	own := func(n json.Number) (Account, bool) {
		login, err := n.Int64()
		if err != nil {
			return Account{}, false
		}
		a, ok := accounts[login]
		return a, ok
	}
	level := verificationLevel(u)

	switch kind {
	case "deposit":
		a, ok := own(req.Login)
		if !ok {
			c.write(w, http.StatusNotFound, map[string]string{"error": "no such account on this profile"})
			return
		}
		if !validMethod(req.Method, depositMethods) {
			c.write(w, http.StatusBadRequest, map[string]string{"error": "choose a payment method"})
			return
		}
		if a.Kind == accountKindReal {
			txs, err := c.users.Transactions(r.Context(), u.ID, 500)
			if err != nil {
				c.fail(w, err, kind)
				return
			}
			if limit, limited := depositLimitByLevel[level]; limited {
				remaining := maxf(limit-depositedTotal(txs, accounts), 0)
				if amount > remaining {
					c.write(w, http.StatusForbidden, map[string]any{
						"error": fmt.Sprintf("your verification level allows %.2f USD more in deposits — complete the next verification step to raise the limit", remaining),
						"code":  "deposit_limit", "remaining": remaining,
					})
					return
				}
			}
		}
		rc := c.broker.Balance(a.Login, amount, "Deposit · "+req.Method)
		if !strings.Contains(rc, `"0 Done"`) {
			c.write(w, http.StatusBadGateway, map[string]string{"error": "the trading server refused the deposit"})
			return
		}
		t, err := c.users.RecordTransaction(r.Context(), Transaction{UserID: u.ID, Login: a.Login, Kind: "deposit", Amount: amount, Currency: a.Currency, Method: req.Method, Comment: "Deposit"})
		if err != nil {
			c.fail(w, err, kind)
			return
		}
		log.Printf("client area: user %d deposited %.2f to %d via %s", u.ID, amount, a.Login, req.Method)
		c.write(w, http.StatusCreated, map[string]any{"transaction": transactionDTO(*t), "balance": c.balanceOf(a.Login)})

	case "withdrawal":
		a, ok := own(req.Login)
		if !ok {
			c.write(w, http.StatusNotFound, map[string]string{"error": "no such account on this profile"})
			return
		}
		if !validMethod(req.Method, withdrawalMethods) {
			c.write(w, http.StatusBadRequest, map[string]string{"error": "choose a payment method"})
			return
		}
		if a.Kind == accountKindDemo {
			c.write(w, http.StatusBadRequest, map[string]string{"error": "demo funds cannot be withdrawn"})
			return
		}
		if level < verificationProfile {
			c.write(w, http.StatusForbidden, map[string]any{"error": "complete your profile to enable withdrawals", "code": "verification_required"})
			return
		}
		rc := c.broker.Balance(a.Login, -amount, "Withdrawal · "+req.Method)
		if strings.Contains(rc, "10019") {
			c.write(w, http.StatusUnprocessableEntity, map[string]string{"error": "not enough free margin on the account"})
			return
		}
		if !strings.Contains(rc, `"0 Done"`) {
			c.write(w, http.StatusBadGateway, map[string]string{"error": "the trading server refused the withdrawal"})
			return
		}
		t, err := c.users.RecordTransaction(r.Context(), Transaction{UserID: u.ID, Login: a.Login, Kind: "withdrawal", Amount: amount, Currency: a.Currency, Method: req.Method, Comment: "Withdrawal"})
		if err != nil {
			c.fail(w, err, kind)
			return
		}
		log.Printf("client area: user %d withdrew %.2f from %d via %s", u.ID, amount, a.Login, req.Method)
		c.write(w, http.StatusCreated, map[string]any{"transaction": transactionDTO(*t), "balance": c.balanceOf(a.Login)})

	case "transfer":
		from, okFrom := own(req.From)
		to, okTo := own(req.To)
		if !okFrom || !okTo {
			c.write(w, http.StatusNotFound, map[string]string{"error": "both accounts must be on this profile"})
			return
		}
		if from.Login == to.Login {
			c.write(w, http.StatusBadRequest, map[string]string{"error": "choose two different accounts"})
			return
		}
		if from.Kind != to.Kind {
			c.write(w, http.StatusBadRequest, map[string]string{"error": "transfers stay within real accounts or within demo accounts"})
			return
		}
		rc := c.broker.Balance(from.Login, -amount, fmt.Sprintf("Transfer to %d", to.Login))
		if strings.Contains(rc, "10019") {
			c.write(w, http.StatusUnprocessableEntity, map[string]string{"error": "not enough free margin on the source account"})
			return
		}
		if !strings.Contains(rc, `"0 Done"`) {
			c.write(w, http.StatusBadGateway, map[string]string{"error": "the trading server refused the transfer"})
			return
		}
		if rc := c.broker.Balance(to.Login, amount, fmt.Sprintf("Transfer from %d", from.Login)); !strings.Contains(rc, `"0 Done"`) {
			// Put the money back rather than lose it between two accounts.
			c.broker.Balance(from.Login, amount, "Transfer reversal")
			c.write(w, http.StatusBadGateway, map[string]string{"error": "the trading server refused the transfer"})
			return
		}
		out, err := c.users.RecordTransaction(r.Context(), Transaction{UserID: u.ID, Login: from.Login, Kind: "transfer_out", Amount: amount, Currency: from.Currency, Method: "Internal transfer", Counterpart: to.Login, Comment: "Transfer"})
		if err != nil {
			c.fail(w, err, kind)
			return
		}
		in, err := c.users.RecordTransaction(r.Context(), Transaction{UserID: u.ID, Login: to.Login, Kind: "transfer_in", Amount: amount, Currency: to.Currency, Method: "Internal transfer", Counterpart: from.Login, Comment: "Transfer"})
		if err != nil {
			c.fail(w, err, kind)
			return
		}
		log.Printf("client area: user %d transferred %.2f from %d to %d", u.ID, amount, from.Login, to.Login)
		c.write(w, http.StatusCreated, map[string]any{
			"transactions": []map[string]any{transactionDTO(*out), transactionDTO(*in)},
			"balances":     map[string]float64{strconv.FormatInt(from.Login, 10): c.balanceOf(from.Login), strconv.FormatInt(to.Login, 10): c.balanceOf(to.Login)},
		})
	}
}

func (c *clientArea) balanceOf(login int64) float64 {
	if a, ok := c.users.AccountByLogin(contextBackground(), login); ok {
		return a.Balance
	}
	return 0
}
