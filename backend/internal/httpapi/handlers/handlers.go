package handlers

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"reflect"
	"strconv"
	"strings"
	"time"

	"github.com/nimadorostkar/TradePlatformDemo/backend/internal/domain"
	"github.com/nimadorostkar/TradePlatformDemo/backend/internal/httpapi/response"
)

// write applies the success→200 / failure→400 convention.
func write(w http.ResponseWriter, env response.GlobalResponse) { response.Write(w, env) }

// ── Authentication (anonymous) ───────────────────────────────────────────────

// tokenResponse marshals as {"token": ...} — the .NET service returned
// Ok(new { Token = ... }), which ASP.NET Core camel-cases on the wire, and the
// CRM/frontend reads the lowercase key.
type tokenResponse struct {
	Token string `json:"token"`
}

type userLoginBody struct {
	Username string `json:"Username"`
	Password string `json:"Password"`
	CRMToken string `json:"CRMToken"`
	// Remember opts into the long-lived (SESSION_RESTORE_TTL) cookies; absent
	// or false issues browser-session cookies only (MED-02).
	Remember bool `json:"Remember"`
}

type crmLoginBody struct {
	Email    string `json:"email"`
	Password string `json:"password"`
	// Remember is the same "keep me signed in" choice the /login exchange
	// receives, and it has to arrive HERE too: this is the request that mints
	// the CRM token every later restore re-presents, so a long cookie holding
	// a short CRM token is a session that ends whenever the CRM says so.
	Remember bool `json:"Remember"`
}

// Login → POST /api/Authentication/login.
func (a *API) Login(w http.ResponseWriter, r *http.Request) {
	var in userLoginBody
	_ = json.Unmarshal(bodyBytes(r), &in)

	// Only CRM-backed auth issues tokens (a CRMToken here, or /crmlogin).
	// The legacy path that minted a token from a bare username is removed:
	// it let anyone obtain a valid JWT without any credentials.
	if in.CRMToken == "" {
		response.WriteStatus(w, http.StatusUnauthorized, response.Failure("Unauthorized"))
		return
	}
	token, err := a.d.Login.GenerateTokenWithCRMAccounts(r.Context(), in.CRMToken, in.Username)
	if err != nil || token == "" {
		response.WriteStatus(w, http.StatusUnauthorized, response.Failure("Unauthorized"))
		return
	}
	// Leave the session in HttpOnly cookies so a page reload can restore it
	// through GET /session instead of forcing a fresh sign-in (AUTH-001).
	a.setSessionCookies(w, r, token, in.CRMToken, in.Username, in.Remember)
	response.WriteStatus(w, http.StatusOK, tokenResponse{Token: token})
}

// CRMLogin → POST /api/Authentication/crmlogin.
func (a *API) CRMLogin(w http.ResponseWriter, r *http.Request) {
	var in crmLoginBody
	_ = json.Unmarshal(bodyBytes(r), &in)
	token, err := a.d.Login.GetLoginDetails(r.Context(), in.Email, in.Password, in.Remember)
	if err != nil || token == "" {
		response.WriteStatus(w, http.StatusUnauthorized, response.Failure("Unauthorized"))
		return
	}
	response.WriteStatus(w, http.StatusOK, tokenResponse{Token: token})
}

// Accounts → POST /api/Authentication/accounts.
//
// Returns the tradable accounts for a CRM token, each with the symbol suffix
// its group uses. Without this the client had to infer the suffix from the
// account type, and an account type whose suffix is unknown would send wrong
// symbol names to MT5 — so `suffixKnown` is part of the contract, not a hint.
func (a *API) Accounts(w http.ResponseWriter, r *http.Request) {
	var in struct {
		CRMToken string `json:"CRMToken"`
	}
	_ = json.Unmarshal(bodyBytes(r), &in)
	if in.CRMToken == "" {
		response.WriteStatus(w, http.StatusUnauthorized, response.Failure("Unauthorized"))
		return
	}
	accounts, err := a.d.Login.Accounts(r.Context(), in.CRMToken)
	if err != nil {
		response.WriteStatus(w, http.StatusUnauthorized, response.Failure("Unauthorized"))
		return
	}
	write(w, response.Success(accounts, "Success: Action performed successfully."))
}

// ── Order ────────────────────────────────────────────────────────────────────

func (a *API) OrderGet(w http.ResponseWriter, r *http.Request) {
	write(w, a.d.Order.OpenOrder(r.Context(), quint64(r, "ticket")))
}
func (a *API) OrderGetTotal(w http.ResponseWriter, r *http.Request) {
	write(w, a.d.Order.NoOfOpenOrder(r.Context(), qint(r, "login")))
}
func (a *API) OrderGetPage(w http.ResponseWriter, r *http.Request) {
	write(w, a.d.Order.GetPage(r.Context(), qint(r, "login"), qint(r, "offset"), qint(r, "total"), qsource(r)))
}
func (a *API) OrderGetBatch(w http.ResponseWriter, r *http.Request) {
	write(w, a.d.Order.GetBatch(r.Context(), qint(r, "login"), qstr(r, "group"), qstr(r, "ticket"), qstr(r, "symbol")))
}
func (a *API) OrderDelete(w http.ResponseWriter, r *http.Request) {
	write(w, a.d.Order.Delete(r.Context(), qstr(r, "ticket")))
}
func (a *API) OrderUpdate(w http.ResponseWriter, r *http.Request) {
	write(w, a.d.Order.UpdateOrder(r.Context(), bodyBytes(r)))
}
func (a *API) OrderCancel(w http.ResponseWriter, r *http.Request) {
	write(w, a.d.Order.Cancel(r.Context(), qstr(r, "ticket")))
}
func (a *API) OrderList(w http.ResponseWriter, r *http.Request) {
	write(w, a.d.Order.ListofBackup(r.Context(), quint64(r, "from"), quint64(r, "to"), qstr(r, "server")))
}
func (a *API) OrderGetBackup(w http.ResponseWriter, r *http.Request) {
	write(w, a.d.Order.OrdersFromBackup(r.Context(), qstr(r, "backup"), qint64(r, "login"), qint64(r, "ticket"), quint64(r, "from"), quint64(r, "to"), qstr(r, "server")))
}
func (a *API) OrderRestore(w http.ResponseWriter, r *http.Request) {
	write(w, a.d.Order.RestoreOrder(r.Context(), bodyBytes(r)))
}
func (a *API) OrderReopen(w http.ResponseWriter, r *http.Request) {
	write(w, a.d.Order.ReopenOrder(r.Context(), quint64(r, "ticket")))
}

// ── Position ─────────────────────────────────────────────────────────────────

func (a *API) PositionGet(w http.ResponseWriter, r *http.Request) {
	write(w, a.d.Position.GetPosition(r.Context(), qint64(r, "login"), qstr(r, "symbol"), qsource(r)))
}
func (a *API) PositionGetTotal(w http.ResponseWriter, r *http.Request) {
	write(w, a.d.Position.GetTotalPosition(r.Context(), qint64(r, "login")))
}
func (a *API) PositionGetPage(w http.ResponseWriter, r *http.Request) {
	write(w, a.d.Position.GetPagebyPagePosition(r.Context(), qint64(r, "login"), qint(r, "offset"), qint(r, "total"), qsource(r)))
}
func (a *API) PositionGetBatch(w http.ResponseWriter, r *http.Request) {
	write(w, a.d.Position.GetPositionBatch(r.Context(), qint64(r, "login"), qstr(r, "group"), quint64(r, "ticket"), qstr(r, "symbol")))
}
func (a *API) PositionUpdate(w http.ResponseWriter, r *http.Request) {
	write(w, a.d.Position.UpdatePosition(r.Context(), bodyBytes(r)))
}
func (a *API) PositionDelete(w http.ResponseWriter, r *http.Request) {
	write(w, a.d.Position.DeletePosition(r.Context(), quint64(r, "ticket")))
}
func (a *API) PositionBackupList(w http.ResponseWriter, r *http.Request) {
	write(w, a.d.Position.PositionbackupList(r.Context(), qint64(r, "from"), qint64(r, "end"), qstr(r, "server")))
}
func (a *API) PositionBackupGet(w http.ResponseWriter, r *http.Request) {
	write(w, a.d.Position.GetPositionFromBackup(r.Context(), qstr(r, "backup"), qint64(r, "login"), qint64(r, "from"), qint64(r, "end"), qstr(r, "server")))
}
func (a *API) PositionRestore(w http.ResponseWriter, r *http.Request) {
	write(w, a.d.Position.RestorePosition(r.Context(), bodyBytes(r)))
}
func (a *API) PositionCheck(w http.ResponseWriter, r *http.Request) {
	write(w, a.d.Position.CheckPosition(r.Context(), qint64(r, "login")))
}
func (a *API) PositionFix(w http.ResponseWriter, r *http.Request) {
	write(w, a.d.Position.FixPosition(r.Context(), qint64(r, "login")))
}

// ── Deal ─────────────────────────────────────────────────────────────────────

func (a *API) DealGet(w http.ResponseWriter, r *http.Request) {
	write(w, a.d.Deal.GetdealByTicket(r.Context(), quint64(r, "ticket")))
}
func (a *API) DealGetTotal(w http.ResponseWriter, r *http.Request) {
	write(w, a.d.Deal.GetNoofDeals(r.Context(), qint64(r, "login"), qstr(r, "from"), qstr(r, "to")))
}
func (a *API) DealGetPage(w http.ResponseWriter, r *http.Request) {
	index := qint(r, "index")
	if index == 0 {
		index = qint(r, "total")
	}
	write(w, a.d.Deal.GetDealPagebyPage(r.Context(), qint64(r, "login"), qstr(r, "from"), qstr(r, "to"), qint(r, "offset"), index))
}
func (a *API) DealGetBatch(w http.ResponseWriter, r *http.Request) {
	write(w, a.d.Deal.Getmultipledeals(r.Context(), qint64(r, "login"), qstr(r, "group"), quint64(r, "ticket"), qstr(r, "from"), qstr(r, "to"), qstr(r, "symbol")))
}
func (a *API) DealUpdate(w http.ResponseWriter, r *http.Request) {
	write(w, a.d.Deal.Updatedeal(r.Context(), bodyBytes(r)))
}
func (a *API) DealDelete(w http.ResponseWriter, r *http.Request) {
	write(w, a.d.Deal.Deletedeal(r.Context(), quint64(r, "ticket")))
}
func (a *API) DealBackupList(w http.ResponseWriter, r *http.Request) {
	write(w, a.d.Deal.Dealbackuplist(r.Context(), qint64(r, "from"), qint64(r, "to"), qstr(r, "server")))
}
func (a *API) DealBackupGet(w http.ResponseWriter, r *http.Request) {
	write(w, a.d.Deal.Getdealfrombackuplist(r.Context(), qstr(r, "backup"), qint64(r, "login"), qint64(r, "from"), qint64(r, "to"), qstr(r, "server")))
}
func (a *API) DealRestore(w http.ResponseWriter, r *http.Request) {
	write(w, a.d.Deal.RestoreDeal(r.Context(), bodyBytes(r)))
}

// ── History ──────────────────────────────────────────────────────────────────

func (a *API) HistoryGet(w http.ResponseWriter, r *http.Request) {
	write(w, a.d.History.ClosedOrderByTicket(r.Context(), quint64(r, "ticket")))
}
func (a *API) HistoryGetTotal(w http.ResponseWriter, r *http.Request) {
	write(w, a.d.History.NoClosedOrderByTicket(r.Context(), qint64(r, "login"), qstr(r, "from"), qstr(r, "to")))
}
func (a *API) HistoryGetPage(w http.ResponseWriter, r *http.Request) {
	write(w, a.d.History.ClosedOrderPageByPage(r.Context(), qint64(r, "login"), qint64(r, "from"), qint64(r, "to"), qint(r, "offset"), qint(r, "total"), qsource(r)))
}
func (a *API) HistoryGetBatch(w http.ResponseWriter, r *http.Request) {
	write(w, a.d.History.GetMultipleCloseOrder(r.Context(), qint64(r, "login"), qstr(r, "groups"), qstr(r, "tickets"), qstr(r, "from"), qstr(r, "to"), qstr(r, "symbol")))
}
func (a *API) HistoryDelete(w http.ResponseWriter, r *http.Request) {
	write(w, a.d.History.DeleteClosedOrder(r.Context(), quint64(r, "ticket")))
}
func (a *API) HistoryUpdate(w http.ResponseWriter, r *http.Request) {
	write(w, a.d.History.UpdateHistory(r.Context(), bodyBytes(r)))
}

// ── Symbol ───────────────────────────────────────────────────────────────────

func (a *API) SymbolGetList(w http.ResponseWriter, r *http.Request) {
	write(w, a.d.Symbol.GetSymbolList(r.Context()))
}
func (a *API) SymbolGetByName(w http.ResponseWriter, r *http.Request) {
	write(w, a.d.Symbol.GetSymbolsByName(r.Context(), qstr(r, "symbol"), qsource(r)))
}
func (a *API) SymbolGetByMask(w http.ResponseWriter, r *http.Request) {
	write(w, a.d.Symbol.GetSymbolsByMask(r.Context(), qstr(r, "mask"), qsource(r)))
}
func (a *API) SymbolGetByGroup(w http.ResponseWriter, r *http.Request) {
	write(w, a.d.Symbol.GetSymbolsByGroup(r.Context(), qstr(r, "symbol"), qstr(r, "group"), qsource(r)))
}
func (a *API) SymbolGetGroup(w http.ResponseWriter, r *http.Request) {
	write(w, a.d.Symbol.GetGroup(r.Context(), qstr(r, "group")))
}

// ── Tick ─────────────────────────────────────────────────────────────────────

func (a *API) TickLast(w http.ResponseWriter, r *http.Request) {
	write(w, a.d.Tick.GetQuotes(r.Context(), qstr(r, "symbol"), qint64(r, "Id"), qsource(r)))
}
func (a *API) TickLastGroup(w http.ResponseWriter, r *http.Request) {
	write(w, a.d.Tick.GetQuotesByGroup(r.Context(), qstr(r, "symbol"), qstr(r, "group"), qint64(r, "Id")))
}
func (a *API) TickStat(w http.ResponseWriter, r *http.Request) {
	write(w, a.d.Tick.GetStatistics(r.Context(), qstr(r, "symbol"), qint64(r, "Id")))
}
func (a *API) TickHistory(w http.ResponseWriter, r *http.Request) {
	write(w, a.d.Tick.GetTickHistory(r.Context(), qstr(r, "symbol"), qint64(r, "from"), qint64(r, "to"), qstr(r, "data")))
}

// TickGet serves intraday chart history. `resolution` is optional: absent or
// "1" returns raw M1 (the shape every existing client depends on); a minute
// count ("5", "60", "120", …) returns bars already aggregated server-side.
func (a *API) TickGet(w http.ResponseWriter, r *http.Request) {
	env := a.d.Tick.GetIntradayHistory(r.Context(), qstr(r, "symbol"), qint64(r, "from"), qint64(r, "to"), qstr(r, "data"), qstrDef(r, "resolution", "1"))
	markClosedHistoryCacheable(w, env, qint64(r, "to"), qstrDef(r, "resolution", "1"))
	write(w, env)
}
func (a *API) TickHistory1D(w http.ResponseWriter, r *http.Request) {
	env := a.d.Tick.GetHistoryBy1DResolution(r.Context(), qstr(r, "symbol"), qint64(r, "from"), qint64(r, "to"), qstrDef(r, "resolution", "1D"))
	markClosedHistoryCacheable(w, env, qint64(r, "to"), qstrDef(r, "resolution", "1D"))
	write(w, env)
}

// markClosedHistoryCacheable lets the browser cache history answers whose
// whole window is in the past. The chart pages BACKWARD from its first
// request, so most of a symbol switch is windows that ended weeks to years
// ago — bars that no longer change — yet every response shipped uncacheable
// and re-rode the serialized MT5 socket on every revisit. Cacheable means:
// the window's `to` predates the current forming period by at least two
// period lengths (the margin absorbs the broker's clock offset — the trade
// server cuts buckets on its own clock, up to 14 h from UTC). The FIRST page
// always includes "now" and is never cached; `private` keeps shared caches
// out of an authenticated route; no `immutable`, because brokers do
// occasionally patch history.
func markClosedHistoryCacheable(w http.ResponseWriter, env response.GlobalResponse, to int64, resolution string) {
	if !env.Success || to <= 0 {
		return
	}
	// A successful-but-EMPTY answer is never cacheable. It can be legitimate
	// (a window before the symbol existed) — but it is also exactly what a
	// degraded upstream serves, and caching one pins a blank page into every
	// browser for the full max-age (observed 2026-08-24: empty closed-window
	// answers cached during a broker flap kept serving ∅ after the flap
	// ended). Empty answers are tiny; re-asking costs nothing.
	if !historyDataHasBars(env.Data) {
		return
	}
	period := resolutionSeconds(resolution)
	if period == 0 {
		return
	}
	if time.Now().Unix()-to > 2*period+14*3600 {
		w.Header().Set("Cache-Control", "private, max-age=604800")
	}
}

// historyDataHasBars reports whether the envelope's data payload carries at
// least one bar. The tick handlers put either a raw JSON string or a slice
// here; anything unrecognized is treated as bar-less (and so uncacheable),
// which fails safe.
func historyDataHasBars(data any) bool {
	switch v := data.(type) {
	case string:
		trimmed := strings.TrimSpace(v)
		return len(trimmed) > 2 && trimmed != "null" && trimmed != "[]" && trimmed != "{}"
	case []byte:
		trimmed := strings.TrimSpace(string(v))
		return len(trimmed) > 2 && trimmed != "null" && trimmed != "[]" && trimmed != "{}"
	default:
		value := reflect.ValueOf(data)
		if value.Kind() == reflect.Slice || value.Kind() == reflect.Array {
			return value.Len() > 0
		}
		return false
	}
}

// resolutionSeconds maps a TradingView-style resolution ("1", "60", "1D",
// "1W", "1M") to its period length; 0 for anything unrecognized (which then
// simply stays uncacheable).
func resolutionSeconds(resolution string) int64 {
	switch resolution {
	case "1D", "D":
		return 24 * 3600
	case "1W", "W":
		return 7 * 24 * 3600
	case "1M", "M":
		return 31 * 24 * 3600
	}
	if minutes, err := strconv.ParseInt(resolution, 10, 64); err == nil && minutes > 0 && minutes <= 24*60 {
		return minutes * 60
	}
	return 0
}
func (a *API) TickMarketDepth(w http.ResponseWriter, r *http.Request) {
	write(w, a.d.Tick.GetMarketDepth(r.Context(), qstr(r, "symbol")))
}

// ── Trade ────────────────────────────────────────────────────────────────────

func (a *API) TradeBalance(w http.ResponseWriter, r *http.Request) {
	write(w, a.d.Trade.GetBalance(r.Context(), qstr(r, "login"), qstr(r, "type"), qstr(r, "balance"), qstr(r, "comment")))
}
func (a *API) TradeCalcBuy(w http.ResponseWriter, r *http.Request) {
	write(w, a.d.Trade.CalculateBuyRate(r.Context(), qstr(r, "basecurrency"), qstr(r, "currency"), qstr(r, "group"), qstr(r, "symbol"), qstr(r, "price")))
}
func (a *API) TradeCalcSell(w http.ResponseWriter, r *http.Request) {
	write(w, a.d.Trade.CalculateSellRate(r.Context(), qstr(r, "basecurrency"), qstr(r, "currency"), qstr(r, "group"), qstr(r, "symbol"), qstr(r, "price")))
}
func (a *API) TradeCheckMargin(w http.ResponseWriter, r *http.Request) {
	write(w, a.d.Trade.CheckMargin(r.Context(), qstr(r, "login"), qstr(r, "symbol"), qstr(r, "type"), qstr(r, "volume"), qstr(r, "price")))
}
func (a *API) TradeCalcProfit(w http.ResponseWriter, r *http.Request) {
	write(w, a.d.Trade.CalculateProfit(r.Context(), qstr(r, "group"), qstr(r, "symbol"), qstr(r, "type"), qstr(r, "volume"), qstr(r, "price_open"), qstr(r, "price_close")))
}

// TradeSendRequest submits a trade. When the caller supplies an idempotency key
// — the `Idempotency-Key` header or a `clientRequestId` / `idempotencyKey` body
// field — a repeat of the same submission inside the window replays the
// original result instead of reaching the dealer again, which is what makes
// retrying a timed-out request safe. Replays are marked with the
// `Idempotent-Replay: true` response header.
func (a *API) TradeSendRequest(w http.ResponseWriter, r *http.Request) {
	body := bodyBytes(r)
	var probe struct {
		Source          string          `json:"source"`
		Login           json.RawMessage `json:"login"`
		Symbol          string          `json:"symbol"`
		ClientRequestID string          `json:"clientRequestId"`
		IdempotencyKey  string          `json:"idempotencyKey"`
	}
	_ = json.Unmarshal(body, &probe)

	key := firstNonEmpty(r.Header.Get("Idempotency-Key"), probe.ClientRequestID, probe.IdempotencyKey)
	startedAt := time.Now()
	result := a.d.Trade.SendRequestWithKey(r.Context(), body, probe.Source, scopedIdempotencyKey(probe.Login, key))
	if result.Replayed {
		w.Header().Set("Idempotent-Replay", "true")
	}
	a.recordTradeSubmission(probe.Login, probe.Symbol, key, result, time.Since(startedAt))
	write(w, result.Response)
}

// recordTradeSubmission emits the one audit line (and metric) every trade
// submission gets: who, what, the dealer's verdict, the ids to trace it with,
// and how long the dealer took (OBS-001). No credential or token appears here;
// the idempotency key is client-generated correlation, not a secret.
func (a *API) recordTradeSubmission(login json.RawMessage, symbol, key string, result domain.TradeResult, took time.Duration) {
	outcome, retcode, orderID := domain.SubmissionVerdict(result.Response)
	if a.d.OnTradeOutcome != nil {
		a.d.OnTradeOutcome(outcome, result.Replayed)
	}
	slog.Info("trade submission",
		slog.String("login", strings.Trim(string(login), `"`)),
		slog.String("symbol", symbol),
		slog.String("client_request_id", key),
		slog.String("outcome", outcome),
		slog.String("retcode", retcode),
		slog.String("order_id", orderID),
		slog.Bool("replayed", result.Replayed),
		slog.Int64("dealer_ms", took.Milliseconds()),
	)
}

// maxIdempotencyKeyLen bounds a client-supplied key. A UUID is 36 characters;
// anything past this is not a key, and storing it would be a free write
// amplifier.
const maxIdempotencyKeyLen = 128

// scopedIdempotencyKey namespaces a client key by account, so two traders
// picking the same key (or a client reusing one across accounts) can never be
// served each other's trade result. An over-long or blank key is ignored,
// leaving the submission non-idempotent rather than silently truncated —
// truncation could collide two genuinely different submissions.
func scopedIdempotencyKey(login json.RawMessage, key string) string {
	key = strings.TrimSpace(key)
	if key == "" || len(key) > maxIdempotencyKeyLen {
		return ""
	}
	account := strings.Trim(string(login), `"`)
	if account == "" || account == "null" {
		account = "-"
	}
	return account + ":" + key
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}
func (a *API) TradeGetRequestResult(w http.ResponseWriter, r *http.Request) {
	write(w, a.d.Trade.GetRequestResult(r.Context(), qint64(r, "id")))
}

// ── User ─────────────────────────────────────────────────────────────────────

func (a *API) UserGet(w http.ResponseWriter, r *http.Request) {
	write(w, a.d.User.Getbylogin(r.Context(), qint64(r, "login"), qsource(r)))
}
func (a *API) UserTradeState(w http.ResponseWriter, r *http.Request) {
	write(w, a.d.User.GetTradeState(r.Context(), qint64(r, "login"), qsource(r)))
}

// ── Test (200/500) ───────────────────────────────────────────────────────────

// TestServerTime also reports the broker's clock offset. Every epoch this
// gateway hands out is UTC, but the broker's TRADING DAY is cut on its own
// clock — a client that wants "today's" deals needs the boundary, and
// guessing the timezone client-side is a per-deployment landmine. The field
// is additive, so older clients that only read unixTimestamp are unaffected.
func (a *API) TestServerTime(w http.ResponseWriter, r *http.Request) {
	payload := map[string]string{"unixTimestamp": strconv.FormatInt(time.Now().Unix(), 10)}
	if a.d.Tick != nil {
		payload["brokerOffsetSeconds"] = strconv.FormatInt(a.d.Tick.BrokerOffset(r.Context()), 10)
	}
	response.WriteStatus(w, http.StatusOK, payload)
}
func (a *API) TestUTCTime(w http.ResponseWriter, r *http.Request) {
	response.WriteStatus(w, http.StatusOK, map[string]string{"unixTimestamp": strconv.FormatInt(time.Now().UTC().Unix(), 10)})
}
