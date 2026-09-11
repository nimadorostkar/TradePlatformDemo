package domain

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/nimadorostkar/TradePlatformDemo/backend/internal/httpapi/response"
	"github.com/nimadorostkar/TradePlatformDemo/backend/internal/mt5"
	"github.com/nimadorostkar/TradePlatformDemo/backend/internal/transform"
)

// PositionService ports PositionService.cs.
//
// Time contract (TIME-001): position open/update times leave the gateway in
// UTC when a BrokerClock is wired — see DealService for why.
type PositionService struct {
	c     MT5Client
	clock BrokerClock
}

// PositionOption customizes a PositionService.
type PositionOption func(*PositionService)

// WithPositionBrokerClock wires the broker-clock resolver (see BrokerClock).
func WithPositionBrokerClock(clock BrokerClock) PositionOption {
	return func(s *PositionService) { s.clock = clock }
}

// NewPositionService constructs a PositionService.
func NewPositionService(c MT5Client, opts ...PositionOption) *PositionService {
	s := &PositionService{c: c}
	for _, opt := range opts {
		opt(s)
	}
	return s
}

// hasAnswer reports whether the body has a non-null "answer".
func hasAnswer(body []byte) bool {
	a := rawAnswer(body)
	return len(a) > 0 && string(a) != "null"
}

// GetPosition → GET /api/position/get. tv → TVPositionResponse object; else →
// OBJECT<PositiongetResponse>. (success forced true on the transform path.)
func (s *PositionService) GetPosition(ctx context.Context, login int64, symbol, source string) response.GlobalResponse {
	env, body, ok := fetchGet(ctx, s.c, fmt.Sprintf(mt5.PathPositionGet, login, symbol))
	if !ok {
		return env
	}
	if !hasAnswer(body) {
		return env // raw string passes through (matches early-return)
	}
	var root transform.PositiongetResponse
	if err := json.Unmarshal(body, &root); err != nil {
		return env
	}
	if strings.EqualFold(source, SourceTV) {
		env.Data = transform.PositionToTV(root.Answer)
	} else {
		env.Data = json.RawMessage(body)
	}
	env.Success = true
	return env
}

// shiftedPositions applies the broker→UTC restatement to a TV position page.
func (s *PositionService) shiftedPositions(ctx context.Context, answer []transform.PositionAnswer) []transform.TVPositionResponse {
	return transform.PositionsToTVPage(answer, brokerOffset(ctx, s.clock))
}

// GetTotalPosition → GET /api/position/get_total (RAW_STRING).
func (s *PositionService) GetTotalPosition(ctx context.Context, login int64) response.GlobalResponse {
	env, _, _ := fetchGet(ctx, s.c, fmt.Sprintf(mt5.PathPositionGetTotal, login))
	return env
}

// GetPagebyPagePosition → GET /api/position/get_page. tv → []TVPositionResponse
// (object); else → OBJECT<PositionResponse>.
func (s *PositionService) GetPagebyPagePosition(ctx context.Context, login int64, offset, total int, source string) response.GlobalResponse {
	env, body, ok := fetchGet(ctx, s.c, fmt.Sprintf(mt5.PathPositionGetPage, login, offset, total))
	if !ok {
		return env
	}
	if len(body) == 0 {
		return failWith("No data received from MT5 API.")
	}
	var root transform.PositionResponse
	if err := json.Unmarshal(body, &root); err != nil || root.Answer == nil {
		return failWith("Failed to parse response data.")
	}
	if strings.EqualFold(source, SourceTV) {
		env.Data = s.shiftedPositions(ctx, root.Answer)
	} else {
		env.Data = json.RawMessage(transform.ShiftEpochsInAnswerBody(body, brokerOffset(ctx, s.clock),
			transform.PositionTimeSecondFields, transform.PositionTimeMillisecondFields))
	}
	return env
}

// GetPagebyPagePositionWs → GET /api/position/get_page. tv → JSON STRING of
// []TVPositionResponse (Ws mapping); else → OBJECT<PositionResponse>.
func (s *PositionService) GetPagebyPagePositionWs(ctx context.Context, login int64, offset, total int, source string) response.GlobalResponse {
	env, body, ok := fetchGet(ctx, s.c, fmt.Sprintf(mt5.PathPositionGetPage, login, offset, total))
	if !ok {
		return env
	}
	if len(body) == 0 {
		return failWith("No data received from MT5 API.")
	}
	var root transform.PositionResponse
	if err := json.Unmarshal(body, &root); err != nil || root.Answer == nil {
		return failWith("Failed to parse response data.")
	}
	if strings.EqualFold(source, SourceTV) {
		// WebSocket consumers expect an array after one JSON.parse, not a
		// JSON-encoded string containing an array.
		env.Data = s.shiftedPositions(ctx, root.Answer)
	} else {
		env.Data = json.RawMessage(transform.ShiftEpochsInAnswerBody(body, brokerOffset(ctx, s.clock),
			transform.PositionTimeSecondFields, transform.PositionTimeMillisecondFields))
	}
	return env
}

// GetPositionBatch → GET /api/position/get_batch (RAW_STRING).
func (s *PositionService) GetPositionBatch(ctx context.Context, login int64, group string, ticket uint64, symbol string) response.GlobalResponse {
	env, _, _ := fetchGet(ctx, s.c, fmt.Sprintf(mt5.PathPositionGetBatch, login, group, ticket, symbol))
	return env
}

// UpdatePosition → POST /api/position/update → OBJECT<UpdatePositionResponse>.
func (s *PositionService) UpdatePosition(ctx context.Context, reqBody []byte) response.GlobalResponse {
	env, body, ok := fetchPost(ctx, s.c, mt5.PathPositionUpdate, reqBody)
	if !ok {
		return env
	}
	var root transform.PositiongetResponse
	if err := json.Unmarshal(body, &root); err != nil {
		return env
	}
	env.Data = transform.UpdatePositionToTV(root.Answer)
	env.Success = true
	return env
}

// DeletePosition → GET /api/position/delete (RAW_STRING).
func (s *PositionService) DeletePosition(ctx context.Context, ticket uint64) response.GlobalResponse {
	env, _, _ := fetchGet(ctx, s.c, fmt.Sprintf(mt5.PathPositionDelete, ticket))
	return env
}

// PositionbackupList → GET /api/position/backup/list (RAW_STRING).
func (s *PositionService) PositionbackupList(ctx context.Context, from, end int64, server string) response.GlobalResponse {
	env, _, _ := fetchGet(ctx, s.c, fmt.Sprintf(mt5.PathPositionBackupList, from, end, server))
	return env
}

// GetPositionFromBackup → GET /api/position/backup/get (RAW_STRING).
func (s *PositionService) GetPositionFromBackup(ctx context.Context, backup string, login, from, end int64, server string) response.GlobalResponse {
	env, _, _ := fetchGet(ctx, s.c, fmt.Sprintf(mt5.PathPositionBackupGet, backup, login, from, end, server))
	return env
}

// RestorePosition → POST /api/position/backup/restore (RAW_STRING).
func (s *PositionService) RestorePosition(ctx context.Context, reqBody []byte) response.GlobalResponse {
	env, _, _ := fetchPost(ctx, s.c, mt5.PathPositionBackupRest, reqBody)
	return env
}

// CheckPosition → GET /api/position/check (RAW_STRING).
func (s *PositionService) CheckPosition(ctx context.Context, login int64) response.GlobalResponse {
	env, _, _ := fetchGet(ctx, s.c, fmt.Sprintf(mt5.PathPositionCheck, login))
	return env
}

// FixPosition → GET /api/position/fix (RAW_STRING).
func (s *PositionService) FixPosition(ctx context.Context, login int64) response.GlobalResponse {
	env, _, _ := fetchGet(ctx, s.c, fmt.Sprintf(mt5.PathPositionFix, login))
	return env
}

// GetPositionServiceData dispatches WS position methods.
func (s *PositionService) GetPositionServiceData(ctx context.Context, symbol string, login int64, group, offset, total, ticket, methodType, source string) response.GlobalResponse {
	switch methodType {
	case "GetPosition":
		return s.GetPosition(ctx, login, symbol, SourceMT5) // .NET does not forward source
	case "GetTotalPosition":
		return s.GetTotalPosition(ctx, login)
	case "GetPagebyPagePositionWs":
		return s.GetPagebyPagePositionWs(ctx, login, atoiDefault(offset), atoiDefault(total), source)
	case "GetPositionBatch":
		return s.GetPositionBatch(ctx, login, group, atou64(ticket), symbol)
	default:
		return catchError(errors.New("Object reference not set to an instance of an object."))
	}
}
