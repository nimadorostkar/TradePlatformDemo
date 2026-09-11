package domain

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/nimadorostkar/TradePlatformDemo/backend/internal/httpapi/response"
	"github.com/nimadorostkar/TradePlatformDemo/backend/internal/mt5"
	"github.com/nimadorostkar/TradePlatformDemo/backend/internal/transform"
)

// HistoryService ports HistoryService.cs (MT5 "history" = closed orders).
//
// Time contract (TIME-001): windows in and closed-order times out are converted
// between UTC and the broker's clock when a BrokerClock is wired — see
// DealService for why.
type HistoryService struct {
	c     MT5Client
	clock BrokerClock
}

// HistoryOption customizes a HistoryService.
type HistoryOption func(*HistoryService)

// WithHistoryBrokerClock wires the broker-clock resolver (see BrokerClock).
func WithHistoryBrokerClock(clock BrokerClock) HistoryOption {
	return func(s *HistoryService) { s.clock = clock }
}

// NewHistoryService constructs a HistoryService.
func NewHistoryService(c MT5Client, opts ...HistoryOption) *HistoryService {
	s := &HistoryService{c: c}
	for _, opt := range opts {
		opt(s)
	}
	return s
}

// ClosedOrderByTicket → GET /api/history/get (RAW_STRING).
func (s *HistoryService) ClosedOrderByTicket(ctx context.Context, ticket uint64) response.GlobalResponse {
	env, _, _ := fetchGet(ctx, s.c, fmt.Sprintf(mt5.PathHistoryGet, ticket))
	return env
}

// NoClosedOrderByTicket → GET /api/history/get_total (RAW_STRING).
func (s *HistoryService) NoClosedOrderByTicket(ctx context.Context, login int64, from, to string) response.GlobalResponse {
	brokerOff := brokerOffset(ctx, s.clock)
	from = transform.ShiftEpochParam(from, brokerOff)
	to = transform.ShiftEpochParam(to, brokerOff)
	env, _, _ := fetchGet(ctx, s.c, fmt.Sprintf(mt5.PathHistoryGetTotal, login, from, to))
	return env
}

// ClosedOrderPageByPage → GET /api/history/get_page. tv → []TVOrderHistory
// (Std mapping); else → OBJECT<OrderHistory>.
func (s *HistoryService) ClosedOrderPageByPage(ctx context.Context, login, from, to int64, offset, total int, source string) response.GlobalResponse {
	brokerOff := brokerOffset(ctx, s.clock)
	if from > 0 {
		from += brokerOff
	}
	if to > 0 {
		to += brokerOff
	}
	env, body, ok := fetchGet(ctx, s.c, fmt.Sprintf(mt5.PathHistoryGetPage, login, from, to, offset, total))
	if !ok {
		return env
	}
	if len(body) == 0 {
		return failWith("Response data is null or empty.")
	}
	var oh transform.OrderHistory
	if err := json.Unmarshal(body, &oh); err != nil {
		return failWith("Failed to deserialize the response data.")
	}
	if strings.EqualFold(source, SourceTV) {
		env.Data = transform.OrdersToTVStd(oh.Answer, brokerOff)
	} else {
		env.Data = json.RawMessage(transform.ShiftEpochsInAnswerBody(body, brokerOff,
			transform.OrderTimeSecondFields, transform.OrderTimeMillisecondFields))
	}
	return env
}

// GetMultipleCloseOrder → GET /api/history/get_batch (RAW_STRING).
func (s *HistoryService) GetMultipleCloseOrder(ctx context.Context, login int64, groups, tickets, from, to, symbol string) response.GlobalResponse {
	brokerOff := brokerOffset(ctx, s.clock)
	from = transform.ShiftEpochParam(from, brokerOff)
	to = transform.ShiftEpochParam(to, brokerOff)
	env, body, ok := fetchGet(ctx, s.c, fmt.Sprintf(mt5.PathHistoryGetBatch, login, groups, tickets, from, to, symbol))
	if ok {
		env.Data = string(transform.ShiftEpochsInAnswerBody(body, brokerOff,
			transform.OrderTimeSecondFields, transform.OrderTimeMillisecondFields))
	}
	return env
}

// DeleteClosedOrder → GET /api/history/delete (RAW_STRING). QUIRK: the path is
// the literal "?ticket=tickets" and the ticket argument is ignored (ANALYSIS §3.5).
func (s *HistoryService) DeleteClosedOrder(ctx context.Context, _ uint64) response.GlobalResponse {
	env, _, _ := fetchGet(ctx, s.c, mt5.PathHistoryDelete)
	return env
}

// UpdateHistory → POST /api/history/update (RAW_STRING).
func (s *HistoryService) UpdateHistory(ctx context.Context, reqBody []byte) response.GlobalResponse {
	env, _, _ := fetchPost(ctx, s.c, mt5.PathHistoryUpdate, reqBody)
	return env
}
