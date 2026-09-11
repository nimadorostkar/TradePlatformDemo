package domain

import (
	"context"
	"errors"
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/nimadorostkar/TradePlatformDemo/backend/internal/httpapi/response"
)

// AlertService owns price alerts. The alerts live on the server rather than in
// a browser tab: an alert that stops working when the tab closes is worse than
// no alert at all, because the trader believes they are being watched.

// AlertService is the price-alert service.
type AlertService struct {
	store AlertStore
	// maxPerLogin caps how many alerts one account may hold, so a runaway
	// client cannot turn the evaluator's per-tick work into an outage.
	maxPerLogin int
}

// DefaultMaxAlertsPerLogin bounds a single account's alert count.
const DefaultMaxAlertsPerLogin = 200

// alertsUnavailable is the response when no store is configured. It states the
// reason rather than returning an empty list, which would look like "you have
// no alerts" and invite the trader to create one that would be silently lost.
const alertsUnavailable = "Price alerts are unavailable: no alert store is configured on this gateway."

// NewAlertService constructs an AlertService. store may be nil, in which case
// every endpoint reports the feature as unavailable.
func NewAlertService(store AlertStore) *AlertService {
	return &AlertService{store: store, maxPerLogin: DefaultMaxAlertsPerLogin}
}

// Enabled reports whether alerts are backed by a store.
func (s *AlertService) Enabled() bool { return s != nil && s.store != nil }

// List → GET /api/Alert/list?login=
func (s *AlertService) List(ctx context.Context, login string) response.GlobalResponse {
	if !s.Enabled() {
		return failWith(alertsUnavailable)
	}
	if login == "" {
		return failWith("login is required.")
	}
	alerts, err := s.store.ListAlerts(ctx, login)
	if err != nil {
		return catchError(err)
	}
	return response.Success(alerts, SuccessMessage)
}

// TriggeredSince → the alerts that fired after ts (the WS delivery feed).
func (s *AlertService) TriggeredSince(ctx context.Context, login string, since int64) response.GlobalResponse {
	if !s.Enabled() {
		return failWith(alertsUnavailable)
	}
	if login == "" {
		return failWith("login is required.")
	}
	// since=0 means "everything so far", not "since 1970 in local time".
	ts := time.Unix(0, 0).UTC()
	if since > 0 {
		ts = time.Unix(since, 0).UTC()
	}
	alerts, err := s.store.ListAlertsTriggeredSince(ctx, login, ts)
	if err != nil {
		return catchError(err)
	}
	return response.Success(alerts, SuccessMessage)
}

// AlertRequest is the create body: { login, symbol, condition, price, note }.
type AlertRequest struct {
	Login     string  `json:"login"`
	Symbol    string  `json:"symbol"`
	Condition string  `json:"condition"`
	Price     float64 `json:"price"`
	Note      string  `json:"note"`
}

// Create → POST /api/Alert/create
func (s *AlertService) Create(ctx context.Context, req AlertRequest) response.GlobalResponse {
	if !s.Enabled() {
		return failWith(alertsUnavailable)
	}
	a, err := validateAlert(req)
	if err != nil {
		return failWith(err.Error())
	}
	existing, err := s.store.ListAlerts(ctx, a.Login)
	if err != nil {
		return catchError(err)
	}
	active := 0
	for _, e := range existing {
		if e.Status == AlertActive {
			active++
		}
	}
	if active >= s.maxPerLogin {
		return failWith("Alert limit reached (" + strconv.Itoa(s.maxPerLogin) + " active alerts per account).")
	}
	created, err := s.store.CreateAlert(ctx, a)
	if err != nil {
		return catchError(err)
	}
	return response.Success(created, SuccessMessage)
}

// Delete → DELETE /api/Alert/delete?id=&login=
//
// login is required and is matched in the DELETE itself: an id alone would let
// any authenticated trader delete any other trader's alert.
func (s *AlertService) Delete(ctx context.Context, id int64, login string) response.GlobalResponse {
	if !s.Enabled() {
		return failWith(alertsUnavailable)
	}
	if id <= 0 {
		return failWith("A valid alert id is required.")
	}
	if login == "" {
		return failWith("login is required.")
	}
	deleted, err := s.store.DeleteAlert(ctx, id, login)
	if err != nil {
		return catchError(err)
	}
	if !deleted {
		return failWith(NoDataFoundMessage)
	}
	return response.Success(map[string]any{"id": id, "deleted": true}, SuccessMessage)
}

// validateAlert normalizes and checks a create request. Validation happens here
// rather than in the database so the trader gets a reason, not a constraint
// violation.
func validateAlert(req AlertRequest) (Alert, error) {
	login := strings.TrimSpace(req.Login)
	symbol := strings.TrimSpace(req.Symbol)
	condition := strings.ToLower(strings.TrimSpace(req.Condition))

	switch {
	case login == "":
		return Alert{}, errors.New("login is required.")
	case symbol == "":
		return Alert{}, errors.New("symbol is required.")
	case condition != AlertAbove && condition != AlertBelow:
		return Alert{}, errors.New(`condition must be "above" or "below".`)
	case math.IsNaN(req.Price) || math.IsInf(req.Price, 0) || req.Price <= 0:
		return Alert{}, errors.New("price must be a positive number.")
	}

	note := req.Note
	const maxNote = 500
	if len(note) > maxNote {
		note = note[:maxNote]
	}
	return Alert{
		Login:     login,
		Symbol:    symbol,
		Condition: condition,
		Price:     req.Price,
		Note:      note,
		Status:    AlertActive,
	}, nil
}

// AlertCrossed reports whether a quote satisfies an alert's condition. The
// comparison is inclusive: a quote landing exactly on the level has reached it,
// and a trader who asked to be told at 1.1000 means at 1.1000.
func AlertCrossed(condition string, level, quote float64) bool {
	switch condition {
	case AlertAbove:
		return quote >= level
	case AlertBelow:
		return quote <= level
	default:
		return false
	}
}
