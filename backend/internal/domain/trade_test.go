package domain

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/nimadorostkar/TradePlatformDemo/backend/internal/httpapi/response"
	"github.com/nimadorostkar/TradePlatformDemo/backend/internal/transform"
)

// The retry loop in getRequestResult and the settle delay in SendRequest must
// not block once the request context is cancelled (client disconnect or app
// shutdown) — sleeping goroutines pile up under trade load otherwise.

func TestGetRequestResult_StopsRetryingOnCancel(t *testing.T) {
	svc := NewTradeService(&fakeClient{err: errors.New("mt5 unreachable")})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	start := time.Now()
	env := svc.GetRequestResult(ctx, 42)
	if elapsed := time.Since(start); elapsed > 50*time.Millisecond {
		t.Errorf("retry loop blocked %v after cancel; want immediate return", elapsed)
	}
	if env.Success {
		t.Error("expected the {order:0,status:5} fallback failure envelope")
	}
}

func TestSendRequest_SettleDelayRespectsCancel(t *testing.T) {
	// send_request succeeds; the 200ms settle sleep before polling must abort
	// as soon as the context is cancelled.
	svc := NewTradeService(&fakeClient{body: []byte(`{"retcode":"0 Done","answer":{"Id":7}}`)})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	start := time.Now()
	env := svc.SendRequest(ctx, []byte(`{}`), "")
	if elapsed := time.Since(start); elapsed > 100*time.Millisecond {
		t.Errorf("SendRequest blocked %v after cancel; want < 100ms (no 200ms settle sleep)", elapsed)
	}
	if env.Success {
		t.Error("expected fallback failure envelope on cancelled context")
	}
}

func TestSendRequest_HappyPathStillPolls(t *testing.T) {
	// With a live context the settle delay elapses and the result poll runs.
	// The GET must answer with a real get_request_result payload: success now
	// means "a trade result came back", not merely "the calls returned".
	svc := NewTradeService(&routedMT5{
		postBody: []byte(okSendRequest),
		getBody:  []byte(`{"retcode":"0 Done","answer":{"777":[{"result":"0"},{"result":"0","answer":` + placeOrderAnswer + `}]}}`),
	})

	env := svc.SendRequest(context.Background(), []byte(`{}`), "")
	if !env.Success {
		t.Errorf("expected success on happy path, got %+v", env)
	}
	if _, ok := env.Data.(transform.PlaceOrderAnswer); !ok {
		t.Errorf("data = %T, want transform.PlaceOrderAnswer", env.Data)
	}
}

// ── The result of a submission is either a trade result or "unknown" ─────────

// routedMT5 answers the POST (send_request) and the GET (get_request_result)
// separately, so a test can break exactly one leg of a submission.
type routedMT5 struct {
	postBody, getBody []byte
	postErr, getErr   error
}

func (r *routedMT5) Get(_ context.Context, _ string) ([]byte, error) { return r.getBody, r.getErr }
func (r *routedMT5) Post(_ context.Context, _ string, _ []byte) ([]byte, error) {
	return r.postBody, r.postErr
}

const okSendRequest = `{"retcode":"0 Done","answer":{"Id":777}}`

// fastPoll returns a TradeService whose result-poll budget is a few
// milliseconds, so tests of the not-ready paths exhaust the budget instantly
// instead of waiting out the production 3s window.
func fastPoll(c MT5Client) *TradeService {
	svc := NewTradeService(c)
	svc.resultPollBudget = 5 * time.Millisecond
	return svc
}

// placeOrderAnswer is one accepted EURUSD fill as MT5 reports it.
const placeOrderAnswer = `{"Order":"100002","Symbol":"EURUSD","Type":"0","Volume":10000,` +
	`"ResultRetcode":"10009 Done","ResultPrice":1.085,"ResultVolume":10000}`

// fallbackData is the {order,status,outcome,message} object the gateway returns
// when it has no trade result.
type fallbackData struct {
	Order   int    `json:"order"`
	Status  int    `json:"status"`
	Outcome string `json:"outcome"`
	Message string `json:"message"`
}

func decodeFallback(t *testing.T, data any) fallbackData {
	t.Helper()
	b, err := json.Marshal(data)
	if err != nil {
		t.Fatalf("marshal data: %v", err)
	}
	var f fallbackData
	if err := json.Unmarshal(b, &f); err != nil {
		t.Fatalf("data is not a fallback object: %s", b)
	}
	return f
}

// Once send_request has reached MT5 the order may be live, so a response the
// gateway cannot turn into a trade result must say so — never success:true with
// a null/empty/raw `data` a client cannot tell from a real result.
func TestSubmit_UnreadableResultIsAlwaysUnknown(t *testing.T) {
	cases := []struct {
		name string
		up   *routedMT5
	}{
		{
			name: "send_request returns an empty body",
			up:   &routedMT5{postBody: nil},
		},
		{
			name: "send_request body is not a FinalAnswer",
			up:   &routedMT5{postBody: []byte(`<html>gateway timeout</html>`)},
		},
		{
			name: "get_request_result is not a RootObject",
			up:   &routedMT5{postBody: []byte(okSendRequest), getBody: []byte(`{"retcode":"0 Done","answer":[1,2,3]}`)},
		},
		{
			name: "get_request_result has no answer map",
			up:   &routedMT5{postBody: []byte(okSendRequest), getBody: []byte(`{"retcode":"0 Done"}`)},
		},
		{
			name: "no entry in the answer map carries a result",
			up: &routedMT5{postBody: []byte(okSendRequest),
				getBody: []byte(`{"retcode":"0 Done","answer":{"777":[{"result":"0"},{"result":"0"}]}}`)},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			for _, source := range []string{"tv", ""} {
				env := fastPoll(tc.up).SendRequest(context.Background(), []byte(`{}`), source)
				if env.Success {
					t.Errorf("source=%q: success:true without a trade result: %+v", source, env)
				}
				got := decodeFallback(t, env.Data)
				if got.Outcome != string(transform.OutcomeUnknown) {
					t.Errorf("source=%q: outcome = %q, want unknown", source, got.Outcome)
				}
				if got.Message == "" {
					t.Errorf("source=%q: fallback carries no message", source)
				}
				assertEnvelopeMessage(t, env, got.Message)
			}
		})
	}
}

// The sentence explaining what happened must be on the envelope too: a client
// that reports errors from `message`/`errorMessage` alone was being handed two
// nulls and had nothing to show the trader.
func assertEnvelopeMessage(t *testing.T, env response.GlobalResponse, want string) {
	t.Helper()
	if env.Message == nil || *env.Message != want {
		t.Errorf("envelope message = %v, want %q", env.Message, want)
	}
	if env.ErrorMessage == nil || *env.ErrorMessage != want {
		t.Errorf("envelope errorMessage = %v, want %q", env.ErrorMessage, want)
	}
}

// The unreadable-result fallbacks name the order id they were polling, so an
// operator can find the submission in the MT5 logs.
func TestSubmit_UnknownFallbackNamesTheOrderID(t *testing.T) {
	up := &routedMT5{postBody: []byte(okSendRequest), getBody: []byte(`{"retcode":"0 Done","answer":{"777":[{"result":"0"}]}}`)}
	env := fastPoll(up).SendRequest(context.Background(), []byte(`{}`), "tv")
	if msg := decodeFallback(t, env.Data).Message; !strings.Contains(msg, "777") {
		t.Errorf("message %q does not name the order id", msg)
	}
}

// A transport failure on get_request_result already had its own fallback; it
// must keep it, envelope message included.
func TestSubmit_ResultPollFailureIsUnknown(t *testing.T) {
	up := &routedMT5{postBody: []byte(okSendRequest), getErr: errors.New("mt5 unreachable")}
	env := fastPoll(up).SendRequest(context.Background(), []byte(`{}`), "tv")
	if env.Success {
		t.Fatalf("expected failure, got %+v", env)
	}
	got := decodeFallback(t, env.Data)
	if got.Outcome != string(transform.OutcomeUnknown) {
		t.Errorf("outcome = %q, want unknown", got.Outcome)
	}
	assertEnvelopeMessage(t, env, got.Message)
}

// pollCountingMT5 records how many result polls happened.
type pollCountingMT5 struct {
	routedMT5
	gets int
}

func (c *pollCountingMT5) Get(ctx context.Context, path string) ([]byte, error) {
	c.gets++
	return c.routedMT5.Get(ctx, path)
}

// The dealer can refuse a submission outright: send_request itself answers a
// rejection retcode and never issues a request id (observed live:
// {"retcode":"10013 Invalid request"}). That is a final verdict — polling id 0
// yields "13 Not found" forever — so it must be reported as a rejection, not
// as an unknown outcome, and without a single pointless poll.
func TestSubmit_DirectDealerRefusalIsARejection(t *testing.T) {
	up := &pollCountingMT5{routedMT5: routedMT5{postBody: []byte(`{ "retcode" : "10013 Invalid request" }`)}}

	env := NewTradeService(up).SendRequest(context.Background(), []byte(`{}`), "tv")
	if !env.Success {
		t.Fatalf("a rejection is a readable trade result; envelope must be success: %+v", env)
	}
	placed, ok := env.Data.(transform.PlacedOrder)
	if !ok {
		t.Fatalf("data = %T, want transform.PlacedOrder", env.Data)
	}
	if placed.Outcome != transform.OutcomeRejected {
		t.Errorf("outcome = %q, want rejected", placed.Outcome)
	}
	if placed.ResultRetcode != "10013 Invalid request" {
		t.Errorf("resultRetcode = %q, want the dealer's verbatim retcode", placed.ResultRetcode)
	}
	if up.gets != 0 {
		t.Errorf("polled %d time(s) for a request MT5 never queued, want 0", up.gets)
	}
}

// A send_request answer with no id and no readable verdict cannot be polled;
// it must resolve to unknown immediately instead of polling id 0.
func TestSubmit_MissingRequestIDIsUnknownWithoutPolling(t *testing.T) {
	up := &pollCountingMT5{routedMT5: routedMT5{postBody: []byte(`{"retcode":"0 Done"}`)}}

	env := NewTradeService(up).SendRequest(context.Background(), []byte(`{}`), "tv")
	if env.Success {
		t.Fatalf("expected the unknown fallback, got %+v", env)
	}
	if got := decodeFallback(t, env.Data); got.Outcome != string(transform.OutcomeUnknown) {
		t.Errorf("outcome = %q, want unknown", got.Outcome)
	}
	if up.gets != 0 {
		t.Errorf("polled %d time(s) with no request id, want 0", up.gets)
	}
}

// pendingThenReady serves send_request, then answers the result poll with the
// two pending shapes real MT5 produces — a transport error, then an HTTP 200
// whose answer is empty — before finally delivering the populated result.
type pendingThenReady struct {
	postBody []byte
	ready    []byte
	gets     int
}

func (p *pendingThenReady) Get(_ context.Context, _ string) ([]byte, error) {
	p.gets++
	switch p.gets {
	case 1:
		return nil, errors.New("mt5 upstream status 404")
	case 2:
		return []byte(`{"retcode":"13 Not found","answer":null}`), nil
	default:
		return p.ready, nil
	}
}

func (p *pendingThenReady) Post(_ context.Context, _ string, _ []byte) ([]byte, error) {
	return p.postBody, nil
}

// Against real MT5 the result is regularly not ready on the first poll: the
// dealer answers "not found" until the trade settles. Those replies are
// pending, not a verdict — the poll must ride them out and accept the
// populated answer that follows. (This is the exact production failure that
// reported every accepted order as an unknown outcome.)
func TestSubmit_PendingResultIsPolledThrough(t *testing.T) {
	up := &pendingThenReady{
		postBody: []byte(okSendRequest),
		ready: []byte(`{"retcode":"0 Done","answer":{"777":[{"result":"0"},{"result":"0","answer":` +
			placeOrderAnswer + `}]}}`),
	}
	env := NewTradeService(up).SendRequest(context.Background(), []byte(`{}`), "")
	if !env.Success {
		t.Fatalf("expected success once the pending polls resolve, got %+v", env)
	}
	if _, ok := env.Data.(transform.PlaceOrderAnswer); !ok {
		t.Errorf("data = %T, want transform.PlaceOrderAnswer", env.Data)
	}
	if up.gets != 3 {
		t.Errorf("polled %d time(s), want 3 (two pending replies, then the result)", up.gets)
	}
}

// ── Finding the trade result in get_request_result ──────────────────────────

// The .NET original took index 1 of whichever key iterated first. MT5 does not
// promise that layout, and every miss became an unreadable result.
func TestFirstPlaceOrderAnswer_ScansForTheResult(t *testing.T) {
	answer := &transform.PlaceOrderAnswer{Order: "100002"}
	cases := []struct {
		name string
		root transform.RootObject
		want bool
	}{
		{
			name: "the .NET layout: second element of a two-element list",
			root: transform.RootObject{Answer: map[string][]transform.AnswerDetail{
				"777": {{}, {Answer: answer}},
			}},
			want: true,
		},
		{
			name: "a single-element list",
			root: transform.RootObject{Answer: map[string][]transform.AnswerDetail{
				"777": {{Answer: answer}},
			}},
			want: true,
		},
		{
			name: "the result at a later index",
			root: transform.RootObject{Answer: map[string][]transform.AnswerDetail{
				"777": {{}, {}, {Answer: answer}},
			}},
			want: true,
		},
		{
			name: "a second key that iterates first",
			root: transform.RootObject{Answer: map[string][]transform.AnswerDetail{
				"776": {{}},
				"777": {{}, {Answer: answer}},
			}},
			want: true,
		},
		{
			name: "genuinely no result",
			root: transform.RootObject{Answer: map[string][]transform.AnswerDetail{
				"777": {{}, {}},
			}},
			want: false,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := firstPlaceOrderAnswer(tc.root)
			if (got != nil) != tc.want {
				t.Fatalf("firstPlaceOrderAnswer() = %v, want non-nil: %v", got, tc.want)
			}
			if tc.want && got.Order != "100002" {
				t.Errorf("returned the wrong answer: %+v", got)
			}
		})
	}
}

// A single-element result list used to yield nil and be reported as unreadable;
// end to end it must now produce the real, accepted order.
func TestSendRequest_SingleElementResultListStillResolves(t *testing.T) {
	up := &routedMT5{
		postBody: []byte(okSendRequest),
		getBody:  []byte(`{"retcode":"0 Done","answer":{"777":[{"result":"0","answer":` + placeOrderAnswer + `}]}}`),
	}
	env := NewTradeService(up).SendRequest(context.Background(), []byte(`{}`), SourceTV)
	if !env.Success {
		t.Fatalf("expected the trade result, got %+v", env)
	}
	placed, ok := env.Data.(transform.PlacedOrder)
	if !ok {
		t.Fatalf("data = %T, want transform.PlacedOrder", env.Data)
	}
	if placed.Outcome != transform.OutcomeAccepted || placed.ID != "100002" {
		t.Errorf("placed order = %+v, want accepted order 100002", placed)
	}
}
