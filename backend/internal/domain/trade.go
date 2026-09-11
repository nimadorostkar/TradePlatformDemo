package domain

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"github.com/nimadorostkar/TradePlatformDemo/backend/internal/httpapi/response"
	"github.com/nimadorostkar/TradePlatformDemo/backend/internal/mt5"
	"github.com/nimadorostkar/TradePlatformDemo/backend/internal/transform"
)

// TradeService ports TradeService.cs.
type TradeService struct {
	c    MT5Client
	idem IdempotencyStore
	// idemTTL is how long a submission's result is replayable. Long enough to
	// cover a client's retry of a timed-out request, short enough that a key
	// reused hours later for a different order is not answered from cache.
	idemTTL time.Duration
	// resultPollBudget bounds how long getRequestResult keeps polling for a
	// trade result. Tests shrink it so the not-ready paths exhaust instantly.
	resultPollBudget time.Duration
	// clock restates a client's UTC GTD expiration on the broker's clock before
	// the request reaches the dealer (TIME-001). Nil = no conversion.
	clock BrokerClock
}

// WithTradeBrokerClock wires the broker-clock resolver (see BrokerClock).
func WithTradeBrokerClock(clock BrokerClock) TradeOption {
	return func(s *TradeService) { s.clock = clock }
}

// TradeOption customizes a TradeService.
type TradeOption func(*TradeService)

// WithIdempotency enables replay of trade submissions carrying a client key.
func WithIdempotency(store IdempotencyStore, ttl time.Duration) TradeOption {
	return func(s *TradeService) {
		s.idem = store
		if ttl > 0 {
			s.idemTTL = ttl
		}
	}
}

// NewTradeService constructs a TradeService.
func NewTradeService(c MT5Client, opts ...TradeOption) *TradeService {
	s := &TradeService{c: c, idemTTL: 10 * time.Minute, resultPollBudget: defaultResultPollBudget}
	for _, opt := range opts {
		opt(s)
	}
	return s
}

// The five calc/balance/margin endpoints are RAW_STRING passthrough; query
// values are forwarded as the raw strings the client sent.

// GetBalance → GET /api/trade/balance.
func (s *TradeService) GetBalance(ctx context.Context, login, typ, balance, comment string) response.GlobalResponse {
	env, _, _ := fetchGet(ctx, s.c, fmt.Sprintf(mt5.PathTradeBalance, login, typ, balance, comment))
	return env
}

// CalculateBuyRate → GET /api/trade/calc_rate_buy.
func (s *TradeService) CalculateBuyRate(ctx context.Context, base, currency, group, symbol, price string) response.GlobalResponse {
	env, _, _ := fetchGet(ctx, s.c, fmt.Sprintf(mt5.PathTradeCalcRateBuy, base, currency, group, symbol, price))
	return env
}

// CalculateSellRate → GET /api/trade/calc_rate_sell.
func (s *TradeService) CalculateSellRate(ctx context.Context, base, currency, group, symbol, price string) response.GlobalResponse {
	env, _, _ := fetchGet(ctx, s.c, fmt.Sprintf(mt5.PathTradeCalcRateSell, base, currency, group, symbol, price))
	return env
}

// CheckMargin → GET /api/trade/check_margin.
func (s *TradeService) CheckMargin(ctx context.Context, login, symbol, typ, volume, price string) response.GlobalResponse {
	env, _, _ := fetchGet(ctx, s.c, fmt.Sprintf(mt5.PathTradeCheckMargin, login, symbol, typ, volume, price))
	return env
}

// CalculateProfit → GET /api/trade/calc_profit.
func (s *TradeService) CalculateProfit(ctx context.Context, group, symbol, typ, volume, priceOpen, priceClose string) response.GlobalResponse {
	env, _, _ := fetchGet(ctx, s.c, fmt.Sprintf(mt5.PathTradeCalcProfit, group, symbol, typ, volume, priceOpen, priceClose))
	return env
}

// reqResultFallback is the .NET "13 not found" fallback object {order:0,status:5},
// with the outcome stated explicitly.
//
// `status:5` is the .NET literal and is preserved, but on its own it reads as
// "rejected" — and a submission whose result could not be read is NOT a
// rejection: the order may well be live. `outcome:"unknown"` is the field to
// branch on; it tells the client to reconcile against Positions rather than
// report a failure or resubmit.
type reqResultFallback struct {
	Order         int                    `json:"order"`
	Status        int                    `json:"status"`
	Outcome       transform.TradeOutcome `json:"outcome"`
	ResultRetcode string                 `json:"resultRetcode"`
	Message       string                 `json:"message"`
}

// unknownOutcome builds the fallback for a submission whose result is not known.
func unknownOutcome(message string) reqResultFallback {
	return reqResultFallback{
		Order:   0,
		Status:  5,
		Outcome: transform.OutcomeUnknown,
		Message: message,
	}
}

// notSubmittedOutcome builds the fallback for a request the gateway refused
// before sending anything to the dealer. Distinct from unknownOutcome: no order
// can exist, so the client may retry rather than reconcile.
func notSubmittedOutcome(message string) reqResultFallback {
	return reqResultFallback{
		Order:   0,
		Status:  5,
		Outcome: transform.OutcomeNotSubmitted,
		Message: message,
	}
}

// fallbackResponse wraps a fallback object in a failure envelope, repeating the
// sentence at the envelope level. Without it the one useful sentence sits only
// in data.message while `message`/`errorMessage` are null, so anything that
// reports errors from the envelope alone has nothing to show.
func fallbackResponse(data reqResultFallback) response.GlobalResponse {
	msg := data.Message
	return response.GlobalResponse{
		Success:      false,
		Data:         data,
		Message:      &msg,
		ErrorMessage: &msg,
	}
}

// sleepCtx waits for d or until ctx is cancelled, whichever comes first.
// It reports whether the full duration elapsed. Unlike time.Sleep it never
// holds a request goroutine hostage past client disconnect/shutdown.
func sleepCtx(ctx context.Context, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C:
		return true
	case <-ctx.Done():
		return false
	}
}

// Result-poll schedule, ported from the .NET service (TradeService.cs). The
// dealer routinely needs more than half a second to settle a result (a
// requote, thin liquidity, maintenance), and until it has one MT5 answers
// "not found" — sometimes as an upstream error, sometimes as an HTTP 200 whose
// answer is empty. Both are PENDING, never a verdict: a genuine rejection
// arrives as a populated answer carrying a rejection retcode and flows through
// unchanged. The bounded budget is also what makes retrying an error-with-body
// safe here — the .NET infinite-loop pathology was unbounded retry, not retry
// itself.
var resultPollBackoff = [...]time.Duration{
	100 * time.Millisecond, 150 * time.Millisecond, 200 * time.Millisecond,
	300 * time.Millisecond, 400 * time.Millisecond, 500 * time.Millisecond,
	600 * time.Millisecond,
}

// defaultResultPollBudget mirrors RequestResultMaxWaitMs in the .NET service.
const defaultResultPollBudget = 3 * time.Second

// logSnippet bounds an upstream body for debug logs.
func logSnippet(b []byte) string {
	const max = 600
	if len(b) > max {
		return string(b[:max]) + "…"
	}
	return string(b)
}

// resultReady reports whether body is a populated trade result — a RootObject
// carrying at least one non-nil answer. MT5's not-yet-processed reply can
// parse cleanly with an empty answer, so parsing alone is not readiness.
func resultReady(body []byte) bool {
	var root transform.RootObject
	if err := json.Unmarshal(body, &root); err != nil || root.Answer == nil {
		return false
	}
	return firstPlaceOrderAnswer(root) != nil
}

// getRequestResult polls /api/dealer/get_request_result until a populated
// trade result arrives or the poll budget is spent, backing off between
// attempts. On exhaustion it substitutes the {order:0,status:5} fallback.
// Returns the envelope and the raw data string (empty when the fallback applies).
func (s *TradeService) getRequestResult(ctx context.Context, id int64) (response.GlobalResponse, string) {
	path := fmt.Sprintf(mt5.PathDealerRequestReslt, id)
	var waited time.Duration
	for attempt := 0; ; attempt++ {
		body, err := s.c.Get(ctx, path)
		ready := err == nil && resultReady(body)
		if err != nil {
			slog.Debug("dealer result poll errored", slog.Int64("id", id),
				slog.Int("attempt", attempt), slog.Any("error", err))
		} else {
			slog.Debug("dealer result poll answered", slog.Int64("id", id),
				slog.Int("attempt", attempt), slog.Bool("ready", ready),
				slog.String("body", logSnippet(body)))
		}
		if ready {
			msg := SuccessMessage
			return response.GlobalResponse{Success: true, Message: &msg, Data: string(body)}, string(body)
		}
		if waited >= s.resultPollBudget {
			break
		}
		delay := resultPollBackoff[min(attempt, len(resultPollBackoff)-1)]
		if remaining := s.resultPollBudget - waited; delay > remaining {
			delay = remaining
		}
		if !sleepCtx(ctx, delay) {
			break // caller gone; stop polling
		}
		waited += delay
	}
	return fallbackResponse(unknownOutcome(fmt.Sprintf(
		"Trade result for Order ID : %d was not ready before the polling window closed; reconcile against Positions before retrying.", id))), ""
}

// GetRequestResult → GET /api/dealer/get_request_result (public endpoint).
func (s *TradeService) GetRequestResult(ctx context.Context, id int64) response.GlobalResponse {
	env, _ := s.getRequestResult(ctx, id)
	return env
}

// firstPlaceOrderAnswer extracts the trade result from a RootObject.
//
// The .NET original read answer.Values[0][1].answer — index 1 of whichever key
// happened to iterate first. Go map iteration is unordered, and MT5 does not
// promise that the result sits at index 1 of a two-element list under a single
// key: a one-element list, a result at another index, or a second key silently
// produced nil, which the caller can only report as an unreadable result. Scan
// every entry for the first non-nil answer instead.
func firstPlaceOrderAnswer(root transform.RootObject) *transform.PlaceOrderAnswer {
	for _, list := range root.Answer {
		for _, detail := range list {
			if detail.Answer != nil {
				return detail.Answer
			}
		}
	}
	return nil
}

// SendRequest → POST /api/dealer/send_request then poll the result.
// source=tv → PlacedOrder; else → OBJECT<PlaceOrderAnswer>. Both shapes carry
// MT5's ResultRetcode; see SendRequestWithKey for the full contract.
func (s *TradeService) SendRequest(ctx context.Context, reqBody []byte, source string) response.GlobalResponse {
	return s.SendRequestWithKey(ctx, reqBody, source, "").Response
}

// TradeResult is a submission's envelope plus how it was produced. Replayed
// marks a response served from the idempotency window rather than from a fresh
// dealer submission — the caller surfaces it as a response header so a client
// can tell "your retry was absorbed" from "your order was submitted again".
type TradeResult struct {
	Response response.GlobalResponse
	Replayed bool
}

// SendRequestWithKey submits a trade and returns exactly one documented shape.
//
// Response contract (settled — every environment returns this):
//   - source=tv  → transform.PlacedOrder, with `resultRetcode` (MT5's raw
//     verdict) ALWAYS present alongside the derived `outcome`
//     (accepted/rejected/unknown) and `retcodeDescription`.
//   - otherwise  → the raw MT5 PlaceOrderAnswer, which carries ResultRetcode.
//   - result unreadable → {order,status,outcome:"unknown",…}, with the same
//     sentence on the envelope's message/errorMessage. `outcome` is the field
//     to branch on; never infer acceptance from the shape itself.
//   - refused before anything was sent → the same object with
//     outcome:"not_submitted", which is safe to retry rather than reconcile.
//
// When key is non-empty the submission is idempotent: the first result is
// replayed for repeats inside the window, and a repeat arriving while the
// original is still in flight is answered "unknown" instead of being submitted
// to the dealer a second time.
func (s *TradeService) SendRequestWithKey(ctx context.Context, reqBody []byte, source, key string) TradeResult {
	reqBody = normalizeTradeRequest(reqBody)
	// The client's GTD deadline is UTC; MT5 evaluates expirations on the
	// broker's clock. Convert exactly once, here at the boundary — otherwise a
	// "good till 18:00" order dies at 15:00 on a UTC+3 broker.
	reqBody = shiftExpirationToBroker(reqBody, brokerOffset(ctx, s.clock))

	if key == "" || s.idem == nil {
		return TradeResult{Response: s.submit(ctx, reqBody, source)}
	}

	if payload, found, err := s.idem.Load(ctx, key); err == nil && found {
		return TradeResult{Response: decodeStoredEnvelope(payload), Replayed: true}
	}
	claimed, err := s.idem.Claim(ctx, key, s.idemTTL)
	if err != nil {
		// The idempotency store is unavailable. Submitting anyway would risk a
		// duplicate position on a retry; refusing is the recoverable failure.
		// Nothing reached the dealer, so this is not an unknown outcome.
		return TradeResult{Response: fallbackResponse(notSubmittedOutcome(
			"Idempotency store unavailable; submission not attempted. Retry with the same key."))}
	}
	if !claimed {
		// An identical submission is already in flight (possibly on another
		// replica). Wait briefly for its result rather than double-submitting.
		if payload, found := s.awaitResult(ctx, key); found {
			return TradeResult{Response: decodeStoredEnvelope(payload), Replayed: true}
		}
		return TradeResult{Response: fallbackResponse(unknownOutcome(
			"A submission with this Idempotency-Key is still in flight; reconcile against Positions before retrying."))}
	}

	env := s.submit(ctx, reqBody, source)
	if payload, err := json.Marshal(env); err == nil {
		_ = s.idem.Store(ctx, key, payload, s.idemTTL)
	} else {
		// Nothing to replay — free the key so the client can retry at once.
		_ = s.idem.Release(ctx, key)
	}
	return TradeResult{Response: env}
}

// awaitResult polls for a concurrent submission's result for a bounded time.
func (s *TradeService) awaitResult(ctx context.Context, key string) ([]byte, bool) {
	const (
		attempts = 10
		interval = 200 * time.Millisecond
	)
	for i := 0; i < attempts; i++ {
		if !sleepCtx(ctx, interval) {
			return nil, false
		}
		if payload, found, err := s.idem.Load(ctx, key); err == nil && found {
			return payload, true
		}
	}
	return nil, false
}

// decodeStoredEnvelope restores a replayed envelope. Data is kept as raw JSON
// so the replay is byte-identical to the original response.
func decodeStoredEnvelope(payload []byte) response.GlobalResponse {
	var stored struct {
		Data         json.RawMessage `json:"data"`
		ErrorMessage *string         `json:"errorMessage"`
		Message      *string         `json:"message"`
		Success      bool            `json:"success"`
	}
	if err := json.Unmarshal(payload, &stored); err != nil {
		return fallbackResponse(unknownOutcome("Stored trade result could not be decoded; reconcile against Positions."))
	}
	env := response.GlobalResponse{ErrorMessage: stored.ErrorMessage, Message: stored.Message, Success: stored.Success}
	if len(stored.Data) > 0 && string(stored.Data) != "null" {
		env.Data = stored.Data
	}
	return env
}

// submit performs one dealer submission and resolves its result.
//
// Past the send_request POST, every failure to produce a trade result is an
// unknown outcome, never a success: the request reached MT5, so the order may
// be live. Answering success:true with a non-result (an empty data, a raw
// upstream body, a bare message) leaves a client unable to tell it from a real
// result, which is how an accepted order gets reported as understood-and-fine
// or as nothing at all.
func (s *TradeService) submit(ctx context.Context, reqBody []byte, source string) response.GlobalResponse {
	env, body, ok := fetchPost(ctx, s.c, mt5.PathDealerSendRequest, reqBody)
	if !ok {
		return env
	}
	if len(body) == 0 {
		return fallbackResponse(unknownOutcome("MT5 returned an empty response to the trade request; reconcile against Positions before retrying."))
	}
	var fa transform.FinalAnswer
	if err := json.Unmarshal(body, &fa); err != nil {
		slog.Debug("dealer send_request body did not parse as a FinalAnswer",
			slog.Any("error", err), slog.String("body", logSnippet(body)))
		return fallbackResponse(unknownOutcome("MT5's response to the trade request could not be parsed, so its result could not be polled; reconcile against Positions before retrying."))
	}
	slog.Debug("dealer send_request answered", slog.Int64("result_id", int64(fa.Answer.ID)),
		slog.String("body", logSnippet(body)))

	// No request id means there is nothing to poll — id 0 answers "13 Not
	// found" forever. When the refusal carries a definitive retcode (observed
	// live: {"retcode":"10013 Invalid request"}), that IS the trade result:
	// report the rejection exactly as a polled rejection would be reported,
	// not as an unknown outcome that sends the trader off to reconcile.
	if fa.Answer.ID == 0 {
		if code, ok := transform.ParseRetcode(fa.Retcode); ok && code != 0 {
			poa := transform.PlaceOrderAnswer{ResultRetcode: fa.Retcode}
			if equalsTV(source) {
				env.Data = transform.PlacedOrderFromAnswer(poa, time.Now().UTC().Unix())
			} else {
				env.Data = poa
			}
			env.Success = true
			return env
		}
		return fallbackResponse(unknownOutcome("MT5 issued no request id for the trade request; reconcile against Positions before retrying."))
	}

	// Settle delay before polling the result (matches .NET). If the caller is
	// gone, skip the poll and return the same fallback a dead poll would yield.
	if !sleepCtx(ctx, 200*time.Millisecond) {
		return fallbackResponse(unknownOutcome("Client disconnected before the trade result was read; reconcile against Positions."))
	}

	gr, grData := s.getRequestResult(ctx, int64(fa.Answer.ID))
	if !gr.Success {
		return gr
	}
	var root transform.RootObject
	if err := json.Unmarshal([]byte(grData), &root); err != nil || root.Answer == nil {
		return fallbackResponse(unknownOutcome(fmt.Sprintf(
			"The trade result for Order ID : %d was not in a recognized shape; reconcile against Positions before retrying.", int64(fa.Answer.ID))))
	}
	poa := firstPlaceOrderAnswer(root)
	if poa == nil {
		return fallbackResponse(unknownOutcome(fmt.Sprintf(
			"No data found with Order ID : %d; reconcile against Positions before retrying.", int64(fa.Answer.ID))))
	}
	if equalsTV(source) {
		env.Data = transform.PlacedOrderFromAnswer(*poa, time.Now().UTC().Unix())
	} else {
		env.Data = *poa
	}
	env.Success = true
	return env
}

func equalsTV(source string) bool {
	return source == SourceTV
}

// SubmissionVerdict extracts (outcome, retcode, orderID) from a trade
// submission envelope for the audit log and metrics, whatever shape the data
// took: the TV PlacedOrder, the raw MT5 answer, the unknown/not-submitted
// fallback, or a replayed raw envelope. Unrecognizable data — which the
// submit path only produces on a pre-dealer refusal — reports as such rather
// than guessing.
func SubmissionVerdict(env response.GlobalResponse) (outcome, retcode, orderID string) {
	switch d := env.Data.(type) {
	case transform.PlacedOrder:
		return string(d.Outcome), d.ResultRetcode, d.ID
	case transform.PlaceOrderAnswer:
		return string(transform.OutcomeFromRetcode(d.ResultRetcode)), d.ResultRetcode, d.Order
	case reqResultFallback:
		return string(d.Outcome), d.ResultRetcode, ""
	case json.RawMessage:
		var probe struct {
			Outcome       string `json:"outcome"`
			ResultRetcode string `json:"resultRetcode"`
			ID            string `json:"id"`
			Order         string `json:"order"`
		}
		if err := json.Unmarshal(d, &probe); err == nil && probe.Outcome != "" {
			id := probe.ID
			if id == "" {
				id = probe.Order
			}
			return probe.Outcome, probe.ResultRetcode, id
		}
	}
	if env.Success {
		return "accepted", "", ""
	}
	return string(transform.OutcomeNotSubmitted), "", ""
}
