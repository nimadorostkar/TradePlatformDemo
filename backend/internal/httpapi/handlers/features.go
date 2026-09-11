package handlers

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"

	"github.com/nimadorostkar/TradePlatformDemo/backend/internal/domain"
	"github.com/nimadorostkar/TradePlatformDemo/backend/internal/httpapi/response"
)

// Handlers for the capabilities the terminal previously had to gate off:
// price alerts, the per-fill execution feed, workspace persistence, and the
// news / economic-calendar feeds.

// ── Alerts ───────────────────────────────────────────────────────────────────

// AlertList → GET /api/Alert/list?login=
func (a *API) AlertList(w http.ResponseWriter, r *http.Request) {
	write(w, a.d.Alert.List(r.Context(), qstr(r, "login")))
}

// AlertCreate → POST /api/Alert/create
func (a *API) AlertCreate(w http.ResponseWriter, r *http.Request) {
	var in domain.AlertRequest
	if err := json.Unmarshal(bodyBytes(r), &in); err != nil {
		write(w, response.Failure("Request body must be valid JSON."))
		return
	}
	write(w, a.d.Alert.Create(r.Context(), in))
}

// AlertDelete → DELETE /api/Alert/delete?id=&login=
//
// login is required (and enforced by AccountsAuthorize as well as in the
// DELETE itself): an id alone would let any authenticated trader delete
// another trader's alert.
func (a *API) AlertDelete(w http.ResponseWriter, r *http.Request) {
	write(w, a.d.Alert.Delete(r.Context(), qint64(r, "id"), qstr(r, "login")))
}

// ── Executions ───────────────────────────────────────────────────────────────

// ExecutionsSince → GET /api/Deal/since?login=&after=[&limit=]
func (a *API) ExecutionsSince(w http.ResponseWriter, r *http.Request) {
	write(w, a.d.Deal.ExecutionsSince(r.Context(), qint64(r, "login"), qint64(r, "after"), qint(r, "limit")))
}

// ── Workspace ────────────────────────────────────────────────────────────────

// WorkspaceGet → GET /api/Workspace/get?login=
func (a *API) WorkspaceGet(w http.ResponseWriter, r *http.Request) {
	write(w, a.d.Workspace.Get(r.Context(), qstr(r, "login")))
}

// WorkspaceSave → POST /api/Workspace/save
func (a *API) WorkspaceSave(w http.ResponseWriter, r *http.Request) {
	var in domain.WorkspaceRequest
	if err := json.Unmarshal(bodyBytes(r), &in); err != nil {
		write(w, response.Failure("Request body must be valid JSON."))
		return
	}
	write(w, a.d.Workspace.Save(r.Context(), in))
}

// ── Leverage ─────────────────────────────────────────────────────────────────

// LeverageGet → GET /api/Account/leverage?login=
func (a *API) LeverageGet(w http.ResponseWriter, r *http.Request) {
	write(w, a.d.Leverage.Get(r.Context(), qint64(r, "login")))
}

// LeverageSet → POST /api/Account/leverage
//
// Both the account filter and the value allow-list gate this: it rewrites a
// property of a real trading account, and the blast radius of the wrong login
// or an unsanctioned value is somebody's margin terms.
func (a *API) LeverageSet(w http.ResponseWriter, r *http.Request) {
	// `login` arrives as a JSON string from the terminal and as a number from
	// other callers, so it is decoded leniently — the account middleware's own
	// body probe already reads it as a RawMessage for exactly this reason.
	// Declaring it int64 here made a perfectly well-formed request fail as
	// "must be valid JSON", which reads like a transport fault rather than a
	// type mismatch.
	var in struct {
		Login    json.RawMessage `json:"login"`
		Leverage json.RawMessage `json:"leverage"`
	}
	if err := json.Unmarshal(bodyBytes(r), &in); err != nil {
		write(w, response.Failure("Request body must be valid JSON."))
		return
	}
	login, ok := jsonNumber(in.Login)
	if !ok {
		write(w, response.Failure("login is required."))
		return
	}
	leverage, ok := jsonNumber(in.Leverage)
	if !ok {
		write(w, response.Failure("leverage must be a number."))
		return
	}
	write(w, a.d.Leverage.Set(r.Context(), login, int(leverage)))
}

// jsonNumber reads an integer that may have been sent quoted or bare.
func jsonNumber(raw json.RawMessage) (int64, bool) {
	text := strings.TrimSpace(strings.Trim(string(raw), `"`))
	if text == "" {
		return 0, false
	}
	value, err := strconv.ParseInt(text, 10, 64)
	return value, err == nil
}

// ── News / calendar ──────────────────────────────────────────────────────────

// NewsList → GET /api/News/list
func (a *API) NewsList(w http.ResponseWriter, r *http.Request) {
	write(w, a.d.Content.News(r.Context(), r.URL.Query()))
}

// CalendarList → GET /api/Calendar/list
func (a *API) CalendarList(w http.ResponseWriter, r *http.Request) {
	write(w, a.d.Content.Calendar(r.Context(), r.URL.Query()))
}

// ── Capabilities ─────────────────────────────────────────────────────────────

// capabilities is the machine-readable answer to "what can this gateway do?".
// The terminal gates features on it instead of discovering a missing endpoint
// by calling it, and each disabled feature carries the reason so the UI can
// tell the trader something truer than "unavailable".
type capabilities struct {
	Alerts    capability `json:"alerts"`
	Workspace capability `json:"workspace"`
	News      capability `json:"news"`
	Calendar  capability `json:"calendar"`
	// These are always on; they are listed so a client can feature-detect one
	// gateway version against another without sniffing response shapes.
	Executions  capability `json:"executions"`
	MarketDepth capability `json:"marketDepth"`
	Idempotency capability `json:"tradeIdempotency"`
	// PositionSizing reports whether this gateway can supply the tick size and
	// tick value a position-size calculation needs. MT5 returns both as 0 for
	// every symbol on this feed, and the terminal normalises a non-positive
	// tick to null — so the Risk Calculator rendered an explanation of its own
	// failure on every instrument while looking like a working panel. Reported
	// honestly so the terminal can omit it instead. Flip this on in the same
	// change that starts populating those fields, never before.
	PositionSizing capability `json:"positionSizing"`
	// Leverage reports whether a trader may change their own account leverage
	// here. It is a broker policy, not a terminal one: MT5 will not enumerate
	// the permitted values, so the deployment states them (LEVERAGE_CHOICES)
	// and this stays off until it does.
	Leverage capability `json:"leverage"`
	// Environment is the trusted runtime identity of this deployment (ENV-001).
	// The terminal renders its live-money banner from THIS, not from build-time
	// variables — a bundle pointed at the wrong gateway then warns about the
	// gateway it actually reached. Contains no secret: environment name, money
	// mode, MT5 host (already public in every MT5 client), build revision.
	Environment EnvironmentInfo `json:"environment"`
	// SessionCookies signals that /api/Authentication/session exists, so a
	// client can restore a reloaded session instead of forcing re-login.
	SessionCookies capability `json:"sessionCookies"`
}

// EnvironmentInfo is the runtime metadata block (see capabilities.Environment).
type EnvironmentInfo struct {
	Name        string `json:"name"`        // e.g. "production"
	TradingMode string `json:"tradingMode"` // "live" | "demo"
	MT5Server   string `json:"mt5Server"`
	BuildSHA    string `json:"buildSha"`
	APIVersion  string `json:"apiVersion"`
}

type capability struct {
	Enabled bool   `json:"enabled"`
	Reason  string `json:"reason,omitempty"`
}

func enabledCap() capability { return capability{Enabled: true} }

func capFor(enabled bool, reason string) capability {
	if enabled {
		return enabledCap()
	}
	return capability{Enabled: false, Reason: reason}
}

// Capabilities → GET /api/Capabilities
func (a *API) Capabilities(w http.ResponseWriter, r *http.Request) {
	const noStore = "No database is configured on this gateway."
	response.WriteStatus(w, http.StatusOK, response.Success(capabilities{
		Alerts:         capFor(a.d.Alert.Enabled(), noStore),
		Workspace:      capFor(a.d.Workspace.Enabled(), noStore),
		News:           capFor(a.d.Content.NewsEnabled(), "No news provider is configured on this gateway."),
		Calendar:       capFor(a.d.Content.CalendarEnabled(), "No calendar provider is configured on this gateway."),
		Executions:     enabledCap(),
		MarketDepth:    enabledCap(),
		Idempotency:    enabledCap(),
		PositionSizing: capFor(false, "This trading server does not report tick size or tick value, so position size cannot be calculated."),
		Leverage: capFor(a.d.Leverage.Enabled(),
			"This broker does not offer trader-adjustable leverage on this gateway."),
		Environment:    a.d.Environment,
		SessionCookies: enabledCap(),
	}, domain.SuccessMessage))
}
