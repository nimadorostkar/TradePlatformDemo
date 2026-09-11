package domain

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"time"

	"github.com/nimadorostkar/TradePlatformDemo/backend/internal/httpapi/response"
	"github.com/nimadorostkar/TradePlatformDemo/backend/internal/mt5"
	"github.com/nimadorostkar/TradePlatformDemo/backend/internal/transform"
)

// DealService ports DealService.cs. Every method is RAW_STRING passthrough.
//
// Time contract (TIME-001): MT5 stamps deals and interprets from/to windows on
// the broker's clock. With a BrokerClock wired, windows the client sends in
// UTC are shifted onto the broker's clock before they reach MT5, and deal
// times are restated in UTC before they leave the gateway — without it, a
// trade stayed invisible to "today" queries for exactly the broker offset,
// because its broker-stamped time sat in the client's future.
type DealService struct {
	c     MT5Client
	clock BrokerClock
}

// DealOption customizes a DealService.
type DealOption func(*DealService)

// WithDealBrokerClock wires the broker-clock resolver (see BrokerClock).
func WithDealBrokerClock(clock BrokerClock) DealOption {
	return func(s *DealService) { s.clock = clock }
}

// NewDealService constructs a DealService.
func NewDealService(c MT5Client, opts ...DealOption) *DealService {
	s := &DealService{c: c}
	for _, opt := range opts {
		opt(s)
	}
	return s
}

// GetdealByTicket → GET /api/deal/get.
func (s *DealService) GetdealByTicket(ctx context.Context, ticket uint64) response.GlobalResponse {
	env, _, _ := fetchGet(ctx, s.c, fmt.Sprintf(mt5.PathDealGet, ticket))
	return env
}

// GetNoofDeals → GET /api/deal/get_total.
func (s *DealService) GetNoofDeals(ctx context.Context, login int64, from, to string) response.GlobalResponse {
	offset := brokerOffset(ctx, s.clock)
	from = transform.ShiftEpochParam(from, offset)
	to = transform.ShiftEpochParam(to, offset)
	env, _, _ := fetchGet(ctx, s.c, fmt.Sprintf(mt5.PathDealGetTotal, login, from, to))
	return env
}

// GetDealPagebyPage → GET /api/deal/get_page (index maps to the total param).
func (s *DealService) GetDealPagebyPage(ctx context.Context, login int64, from, to string, offset, index int) response.GlobalResponse {
	brokerOff := brokerOffset(ctx, s.clock)
	from = transform.ShiftEpochParam(from, brokerOff)
	to = transform.ShiftEpochParam(to, brokerOff)
	env, body, ok := fetchGet(ctx, s.c, fmt.Sprintf(mt5.PathDealGetPage, login, from, to, offset, index))
	if !ok {
		return env
	}
	var root struct {
		Answer json.RawMessage `json:"answer"`
	}
	if err := json.Unmarshal(body, &root); err != nil {
		return env
	}
	if len(root.Answer) == 0 || string(root.Answer) == "null" {
		env.Data = []any{}
	} else {
		answer, _ := transform.ShiftEpochsInObjectArray(root.Answer, brokerOff,
			transform.DealTimeSecondFields, transform.DealTimeMillisecondFields)
		env.Data = answer
	}
	env.Success = true
	return env
}

// Executions since a cursor — the per-fill feed. Without it TradingView's
// execution markers are always empty, and synthesising them from the deal page
// would misreport the fill price of a partially-filled order (a page row is the
// order; the deals are the fills that made it).

// DefaultExecutionWindow bounds a cursorless first call. Asking MT5 for a
// login's entire deal history to render chart markers is a needless load spike.
const DefaultExecutionWindow = 24 * time.Hour

// MaxExecutionPage caps one response, so a busy account cannot pull an
// unbounded page through the gateway in a single request.
const MaxExecutionPage = 500

// ExecutionsSince → GET /api/Deal/since?login=&after=[&limit=].
//
// `after` is a unix-seconds cursor; deals at exactly that second are excluded,
// so polling with the newest timestamp seen never re-delivers a fill. Each
// execution carries `timeSeconds` — the value to send back as the next cursor.
func (s *DealService) ExecutionsSince(ctx context.Context, login, after int64, limit int) response.GlobalResponse {
	if login <= 0 {
		return failWith("login is required.")
	}
	if limit <= 0 || limit > MaxExecutionPage {
		limit = MaxExecutionPage
	}
	now := time.Now().UTC()
	from := after
	if from <= 0 {
		from = now.Add(-DefaultExecutionWindow).Unix()
	}
	// MT5's window is inclusive on both ends; the strict "after" filter is
	// applied in the transform, which is the only place that sees the deal
	// times. `after` and the window are UTC; MT5 selects on the broker's clock,
	// so the window is shifted onto it here and the transform shifts the deal
	// times back.
	to := now.Unix()
	brokerOff := brokerOffset(ctx, s.clock)

	env, body, ok := fetchGet(ctx, s.c, fmt.Sprintf(mt5.PathDealGetPage,
		login, strconv.FormatInt(from+brokerOff, 10), strconv.FormatInt(to+brokerOff, 10), 0, limit))
	if !ok {
		return env
	}
	var page transform.DealPageResponse
	if err := json.Unmarshal(body, &page); err != nil {
		return failWith("Failed to parse deal page response.")
	}
	env.Data = transform.DealsToExecutions(page.Answer, after, brokerOff)
	env.Success = true
	return env
}

// Getmultipledeals → GET /api/deal/get_batch.
func (s *DealService) Getmultipledeals(ctx context.Context, login int64, group string, ticket uint64, from, to, symbol string) response.GlobalResponse {
	brokerOff := brokerOffset(ctx, s.clock)
	from = transform.ShiftEpochParam(from, brokerOff)
	to = transform.ShiftEpochParam(to, brokerOff)
	env, body, ok := fetchGet(ctx, s.c, fmt.Sprintf(mt5.PathDealGetBatch, login, group, ticket, from, to, symbol))
	if ok {
		env.Data = string(transform.ShiftEpochsInAnswerBody(body, brokerOff,
			transform.DealTimeSecondFields, transform.DealTimeMillisecondFields))
	}
	return env
}

// Updatedeal → POST /api/deal/update.
func (s *DealService) Updatedeal(ctx context.Context, reqBody []byte) response.GlobalResponse {
	env, _, _ := fetchPost(ctx, s.c, mt5.PathDealUpdate, reqBody)
	return env
}

// Deletedeal → GET /api/deal/delete.
func (s *DealService) Deletedeal(ctx context.Context, ticket uint64) response.GlobalResponse {
	env, _, _ := fetchGet(ctx, s.c, fmt.Sprintf(mt5.PathDealDelete, ticket))
	return env
}

// Dealbackuplist → GET /api/deal/backup/list.
func (s *DealService) Dealbackuplist(ctx context.Context, from, to int64, server string) response.GlobalResponse {
	env, _, _ := fetchGet(ctx, s.c, fmt.Sprintf(mt5.PathDealBackupList, from, to, server))
	return env
}

// Getdealfrombackuplist → GET /api/deal/backup/get.
func (s *DealService) Getdealfrombackuplist(ctx context.Context, backup string, login, from, to int64, server string) response.GlobalResponse {
	env, _, _ := fetchGet(ctx, s.c, fmt.Sprintf(mt5.PathDealBackupGet, backup, login, from, to, server))
	return env
}

// RestoreDeal → POST /api/deal/backup/restore.
func (s *DealService) RestoreDeal(ctx context.Context, reqBody []byte) response.GlobalResponse {
	env, _, _ := fetchPost(ctx, s.c, mt5.PathDealBackupRest, reqBody)
	return env
}
