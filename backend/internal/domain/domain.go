// Package domain implements the per-MT5-domain services (order, position, deal,
// history, symbol, tick, trade, user, login). Each method reproduces the .NET
// service's exact behavior: URL construction, the GlobalResponse envelope, and
// the per-endpoint `data` shape (raw passthrough string, typed object, or TV
// transform). See docs/ANALYSIS.md §7 and the per-method port specs.
package domain

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/nimadorostkar/TradePlatformDemo/backend/internal/httpapi/response"
	"github.com/nimadorostkar/TradePlatformDemo/backend/internal/mt5"
)

// AppConstants literals (OpoMTSocket.Core/Helpers/AppConstants.cs).
const (
	SuccessMessage       = "Success: Action performed successfully."
	ErrorMessageTemplate = "Error: Action performed while processing is: {0}."
	NoDataFoundMessage   = "No data found."
	SourceMT5            = "mt5"
	SourceTV             = "tv"
	DefaultChartData     = "dhloc"
	DefaultResolution    = "1D"
)

// MT5Client is the upstream dependency the services need (satisfied by
// *mt5.Manager). Interface at the boundary keeps services unit-testable.
type MT5Client interface {
	Get(ctx context.Context, path string) ([]byte, error)
	Post(ctx context.Context, path string, body []byte) ([]byte, error)
}

// fetchGet reproduces AuthenticateServices.GlobalMT5RequestProcess (GET):
//   - success (2xx + non-empty body) → env{success:true, message:SuccessMessage,
//     data:string(body)}, ok=true.
//   - upstream failure (non-2xx / empty) → env{success:false, message:<literal
//     ErrorMessage template>, data:string(body)}, ok=false.
//   - transport error → env{success:false, message:Format(ErrorMessage, err),
//     data:nil}, ok=false.
func fetchGet(ctx context.Context, c MT5Client, path string) (response.GlobalResponse, []byte, bool) {
	body, err := c.Get(ctx, path)
	return toEnvelope(body, err)
}

// fetchPost reproduces GlobalMT5RequestProcess_Post.
func fetchPost(ctx context.Context, c MT5Client, path string, reqBody []byte) (response.GlobalResponse, []byte, bool) {
	body, err := c.Post(ctx, path, reqBody)
	return toEnvelope(body, err)
}

func toEnvelope(body []byte, err error) (response.GlobalResponse, []byte, bool) {
	if err == nil {
		msg := SuccessMessage
		return response.GlobalResponse{Success: true, Message: &msg, Data: string(body)}, body, true
	}
	var ue *mt5.UpstreamError
	if errors.As(err, &ue) {
		// Upstream non-success: data carries the (possibly empty) error body
		// string; message is the un-substituted .NET template literal.
		msg := ErrorMessageTemplate
		return response.GlobalResponse{Success: false, Message: &msg, Data: string(ue.Body)}, ue.Body, false
	}
	// Transport/context error: data=null, message substituted with the error.
	return catchError(err), nil, false
}

// upstreamFailureDetail is what a client is told when a call fails below the
// business layer. The error itself carries the upstream MT5 base URL, the full
// request path, and — for the store-backed features — the Postgres host, user,
// and database from the DSN. That is internal topology: an authenticated
// trader could map the broker's Manager API and the gateway's database from
// ordinary error responses. Operators get the real error in the log instead.
const upstreamFailureDetail = "the request could not be completed"

// How often a continuing breaker-open episode is re-logged. The first refusal
// of an episode is always logged; recovery is implicit in the log going quiet.
const breakerLogInterval = 30 * time.Second

var breakerLogState struct {
	mu         sync.Mutex
	lastLog    time.Time
	suppressed int
}

// logBreakerOpen rate-limits the breaker-open ERROR. During the 2026-08-24
// upstream stall this line repeated hundreds of times a minute, saying the
// identical thing each time — the storm buried the two lines that explained
// the episode (the slow requests that tripped the breaker). One summary line
// per interval carries the same information plus how many refusals it stands
// for.
func logBreakerOpen(err error) {
	breakerLogState.mu.Lock()
	defer breakerLogState.mu.Unlock()
	now := time.Now()
	if now.Sub(breakerLogState.lastLog) < breakerLogInterval {
		breakerLogState.suppressed++
		return
	}
	suppressed := breakerLogState.suppressed
	breakerLogState.suppressed = 0
	breakerLogState.lastLog = now
	slog.Error("mt5 circuit breaker is refusing requests",
		slog.Any("error", err),
		slog.Int("refusals_since_last_log", suppressed))
}

// catchError reproduces the service-level catch block: success=false,
// errorMessage=Format(ErrorMessage, …), data=null. The envelope shape and the
// message template are unchanged; only the substituted detail is redacted.
func catchError(err error) response.GlobalResponse {
	switch {
	// A cancelled context is the client hanging up, not a fault worth an
	// ERROR line on a busy gateway.
	case errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded):
		slog.Debug("request aborted before completion", slog.Any("error", err))
	case mt5.IsBreakerOpen(err):
		logBreakerOpen(err)
	default:
		slog.Error("request failed below the business layer", slog.Any("error", err))
	}
	msg := fmt.Sprintf("Error: Action performed while processing is: %s.", upstreamFailureDetail)
	return response.GlobalResponse{Success: false, ErrorMessage: &msg}
}

// failWith builds a failure envelope with a fixed errorMessage and null data
// (used for the deserialize-guard branches, e.g. "Failed to deserialize ...").
func failWith(message string) response.GlobalResponse {
	return response.GlobalResponse{Success: false, ErrorMessage: &message}
}

// ptr returns a pointer to v.
func ptr[T any](v T) *T { return &v }
