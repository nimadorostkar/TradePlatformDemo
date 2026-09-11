package domain

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"github.com/nimadorostkar/TradePlatformDemo/backend/internal/httpapi/response"
	"github.com/nimadorostkar/TradePlatformDemo/backend/internal/mt5"
)

// LeverageService reads and writes the leverage on an MT5 user record.
//
// Leverage in MT5 is a property of the ACCOUNT, not of a symbol or an order:
// there is no per-symbol leverage to set, and brokers that advertise "dynamic
// leverage" enforce it server-side by volume or symbol tier. So this service
// answers one value per login and writes one value per login.
//
// It is disabled unless the deployment states which values a trader may pick.
// MT5 will not enumerate them — the permitted set is a broker policy — and a
// control that writes to a live trading account must not exist until the broker
// has said what it may write.
type LeverageService struct {
	c       MT5Client
	choices []int
}

// NewLeverageService parses the configured choice list. An empty or unparseable
// list leaves the service disabled rather than guessing a range.
func NewLeverageService(c MT5Client, choices string) *LeverageService {
	seen := map[int]bool{}
	var out []int
	for _, part := range strings.Split(choices, ",") {
		value, err := strconv.Atoi(strings.TrimSpace(part))
		if err != nil || value <= 0 || seen[value] {
			continue
		}
		seen[value] = true
		out = append(out, value)
	}
	sort.Ints(out)
	return &LeverageService{c: c, choices: out}
}

// Enabled reports whether this deployment permits leverage changes.
func (s *LeverageService) Enabled() bool { return s != nil && len(s.choices) > 0 }

// Choices are the selectable values, ascending.
func (s *LeverageService) Choices() []int { return s.choices }

type leveragePayload struct {
	Login    int64 `json:"login"`
	Leverage int   `json:"leverage"`
	Min      int   `json:"min"`
	Max      int   `json:"max"`
	Choices  []int `json:"choices"`
}

// Get reports the login's current leverage alongside what it may be changed to.
func (s *LeverageService) Get(ctx context.Context, login int64) response.GlobalResponse {
	if !s.Enabled() {
		return failWith("Leverage changes are not enabled on this gateway.")
	}
	current, env, ok := s.currentLeverage(ctx, login)
	if !ok {
		return env
	}
	env.Data = s.payload(login, current)
	env.Success = true
	return env
}

// Set writes a new leverage onto the user record.
//
// The value must be one the deployment listed: MT5 accepts whatever it is
// given, so an unlisted value would be a silent, broker-unsanctioned change to
// a real account's margin terms.
func (s *LeverageService) Set(ctx context.Context, login int64, leverage int) response.GlobalResponse {
	if !s.Enabled() {
		return failWith("Leverage changes are not enabled on this gateway.")
	}
	if !s.permits(leverage) {
		return failWith(fmt.Sprintf("Leverage 1:%d is not offered on this account.", leverage))
	}

	// MT5 REPLACES the user record with the body it is sent, so the current one
	// is read first and returned with a single field changed. Building a body
	// from scratch here would clear every property absent from it — name,
	// group, rights, balance limits — on a live trading account.
	env, body, ok := fetchGet(ctx, s.c, fmt.Sprintf(mt5.PathUserGet, login))
	if !ok {
		return env
	}
	var wrapper struct {
		Answer map[string]json.RawMessage `json:"answer"`
	}
	if err := json.Unmarshal(body, &wrapper); err != nil || wrapper.Answer == nil {
		return failWith("The trading server did not return a readable account record.")
	}

	encoded, err := json.Marshal(strconv.Itoa(leverage))
	if err != nil {
		return failWith("Could not encode the requested leverage.")
	}
	// The two MT5 endpoints spell this differently: the USER record calls it
	// `Leverage`, the account summary `MarginLeverage`. Writing the summary's
	// name onto a user record adds a field MT5 ignores and leaves the leverage
	// untouched — a change that reports success and does nothing. The name
	// already present on the record is the one that gets written; `Leverage` is
	// the fallback for a record that carries neither.
	field := leverageFieldName(wrapper.Answer)
	wrapper.Answer[field] = encoded
	updated, err := json.Marshal(wrapper.Answer)
	if err != nil {
		return failWith("Could not encode the account record.")
	}

	writeEnv, _, ok := fetchPost(ctx, s.c, mt5.PathUserUpdate, updated)
	if !ok {
		return writeEnv
	}

	// Answered from the record as re-read, never from what was requested: the
	// trader must see what the server actually holds.
	confirmed, readEnv, ok := s.currentLeverage(ctx, login)
	if !ok {
		return readEnv
	}
	writeEnv.Data = s.payload(login, confirmed)
	writeEnv.Success = true
	return writeEnv
}

func (s *LeverageService) permits(leverage int) bool {
	for _, choice := range s.choices {
		if choice == leverage {
			return true
		}
	}
	return false
}

func (s *LeverageService) payload(login int64, current int) leveragePayload {
	return leveragePayload{
		Login:    login,
		Leverage: current,
		Min:      s.choices[0],
		Max:      s.choices[len(s.choices)-1],
		Choices:  s.choices,
	}
}

// currentLeverage reads MarginLeverage off the user record. MT5 sends numbers
// as strings on this endpoint, so both encodings are accepted.
func (s *LeverageService) currentLeverage(ctx context.Context, login int64) (int, response.GlobalResponse, bool) {
	env, body, ok := fetchGet(ctx, s.c, fmt.Sprintf(mt5.PathUserGet, login))
	if !ok {
		return 0, env, false
	}
	var wrapper struct {
		Answer map[string]json.RawMessage `json:"answer"`
	}
	if err := json.Unmarshal(body, &wrapper); err != nil || wrapper.Answer == nil {
		return 0, failWith("The trading server did not return a readable account record."), false
	}
	raw := strings.Trim(string(wrapper.Answer[leverageFieldName(wrapper.Answer)]), `"`)
	value, err := strconv.Atoi(raw)
	if err != nil {
		return 0, failWith("The trading server did not report this account's leverage."), false
	}
	return value, env, true
}

// leverageFieldName picks whichever spelling this record actually uses.
//
// `/api/user/get` answers with `Leverage`; `/api/user/account/get` answers with
// `MarginLeverage`. Reading the wrong one made every leverage request fail —
// and, under the gateway's success/failure convention, fail as an HTTP 400 that
// looked like a malformed request rather than a missing field.
func leverageFieldName(record map[string]json.RawMessage) string {
	if _, ok := record["Leverage"]; ok {
		return "Leverage"
	}
	if _, ok := record["MarginLeverage"]; ok {
		return "MarginLeverage"
	}
	return "Leverage"
}
