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

// OrderService ports OrderServices.cs.
//
// Time contract (TIME-001): order setup/expiration times leave the gateway in
// UTC when a BrokerClock is wired — see DealService for why.
type OrderService struct {
	c     MT5Client
	clock BrokerClock
}

// OrderOption customizes an OrderService.
type OrderOption func(*OrderService)

// WithOrderBrokerClock wires the broker-clock resolver (see BrokerClock).
func WithOrderBrokerClock(clock BrokerClock) OrderOption {
	return func(s *OrderService) { s.clock = clock }
}

// NewOrderService constructs an OrderService.
func NewOrderService(c MT5Client, opts ...OrderOption) *OrderService {
	s := &OrderService{c: c}
	for _, opt := range opts {
		opt(s)
	}
	return s
}

// joinChars reproduces the .NET `string.Join(",", someString)` quirk, which
// joins a string's characters with commas ("ABC" → "A,B,C").
func joinChars(s string) string {
	if s == "" {
		return ""
	}
	parts := make([]string, 0, len(s))
	for _, r := range s {
		parts = append(parts, string(r))
	}
	return strings.Join(parts, ",")
}

// rawAnswer extracts the top-level "answer" subtree from an MT5 response body.
func rawAnswer(body []byte) json.RawMessage {
	var wrap struct {
		Answer json.RawMessage `json:"answer"`
	}
	_ = json.Unmarshal(body, &wrap)
	return wrap.Answer
}

// OpenOrder → GET /api/order/get?ticket={ticket} (RAW_STRING).
func (s *OrderService) OpenOrder(ctx context.Context, ticket uint64) response.GlobalResponse {
	env, _, _ := fetchGet(ctx, s.c, fmt.Sprintf(mt5.PathOrderGet, ticket))
	return env
}

// NoOfOpenOrder → GET /api/order/get_total?login={login} (RAW_STRING).
func (s *OrderService) NoOfOpenOrder(ctx context.Context, login int) response.GlobalResponse {
	env, _, _ := fetchGet(ctx, s.c, fmt.Sprintf(mt5.PathOrderGetTotal, login))
	return env
}

// GetPage → GET /api/order/get_page. source=tv → []TVOrderHistory (object);
// else → OBJECT<OrderHistory>.
func (s *OrderService) GetPage(ctx context.Context, login, offset, total int, source string) response.GlobalResponse {
	env, body, ok := fetchGet(ctx, s.c, fmt.Sprintf(mt5.PathOrderGetPage, login, offset, total))
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
		env.Data = transform.OrdersToTVStd(oh.Answer, brokerOffset(ctx, s.clock))
	} else {
		env.Data = json.RawMessage(transform.ShiftEpochsInAnswerBody(body, brokerOffset(ctx, s.clock),
			transform.OrderTimeSecondFields, transform.OrderTimeMillisecondFields))
	}
	return env
}

// GetPagebyPageOrder → GET /api/order/get_page. source=tv → JSON STRING of
// []TVOrderHistory (V2 mapping); else → OBJECT<answer array>.
func (s *OrderService) GetPagebyPageOrder(ctx context.Context, login int64, offset, total int, source string) response.GlobalResponse {
	env, body, ok := fetchGet(ctx, s.c, fmt.Sprintf(mt5.PathOrderGetPage, login, offset, total))
	if !ok {
		return env
	}
	if len(body) == 0 {
		return failWith("No data received from MT5 API.")
	}
	var oh transform.OrderHistory
	if err := json.Unmarshal(body, &oh); err != nil || oh.Answer == nil {
		return failWith("Failed to parse response data.")
	}
	if strings.EqualFold(source, SourceTV) {
		// WebSocket consumers expect an array after one JSON.parse, not a
		// JSON-encoded string containing an array.
		env.Data = transform.OrdersToTVV2(oh.Answer, brokerOffset(ctx, s.clock))
	} else {
		answer, _ := transform.ShiftEpochsInObjectArray(rawAnswer(body), brokerOffset(ctx, s.clock),
			transform.OrderTimeSecondFields, transform.OrderTimeMillisecondFields)
		env.Data = answer
	}
	return env
}

// GetBatch → GET /api/order/get_batch (RAW_STRING; ticket char-joined).
func (s *OrderService) GetBatch(ctx context.Context, login int, group, ticket, symbol string) response.GlobalResponse {
	env, _, _ := fetchGet(ctx, s.c, fmt.Sprintf(mt5.PathOrderGetBatch, login, group, joinChars(ticket), symbol))
	return env
}

// Delete → GET /api/order/delete (RAW_STRING; ticket char-joined).
func (s *OrderService) Delete(ctx context.Context, ticket string) response.GlobalResponse {
	env, _, _ := fetchGet(ctx, s.c, fmt.Sprintf(mt5.PathOrderDelete, joinChars(ticket)))
	return env
}

// Cancel → GET /api/order/cancel (RAW_STRING; ticket char-joined).
func (s *OrderService) Cancel(ctx context.Context, ticket string) response.GlobalResponse {
	env, _, _ := fetchGet(ctx, s.c, fmt.Sprintf(mt5.PathOrderCancel, joinChars(ticket)))
	return env
}

// UpdateOrder → POST /api/order/update → OBJECT<TVResponseModifyOrder>.
func (s *OrderService) UpdateOrder(ctx context.Context, reqBody []byte) response.GlobalResponse {
	env, body, ok := fetchPost(ctx, s.c, mt5.PathOrderUpdate, reqBody)
	if !ok {
		return env
	}
	var m transform.MT5ModifyOrder
	if err := json.Unmarshal(body, &m); err != nil {
		return env // leave data as the raw string when undeserializable
	}
	env.Data = transform.ModifyOrderToTV(m.Answer)
	env.Success = true
	return env
}

// ListofBackup → GET /api/order/backup/list (RAW_STRING).
func (s *OrderService) ListofBackup(ctx context.Context, from, to uint64, server string) response.GlobalResponse {
	env, _, _ := fetchGet(ctx, s.c, fmt.Sprintf(mt5.PathOrderBackupList, from, to, server))
	return env
}

// OrdersFromBackup → GET /api/order/backup/get (RAW_STRING; backup passed through).
func (s *OrderService) OrdersFromBackup(ctx context.Context, backup string, login, ticket int64, from, to uint64, server string) response.GlobalResponse {
	env, _, _ := fetchGet(ctx, s.c, fmt.Sprintf(mt5.PathOrderBackupGet, backup, login, ticket, from, to, server))
	return env
}

// RestoreOrder → POST /api/order/backup/restore (RAW_STRING).
func (s *OrderService) RestoreOrder(ctx context.Context, reqBody []byte) response.GlobalResponse {
	env, _, _ := fetchPost(ctx, s.c, mt5.PathOrderBackupRest, reqBody)
	return env
}

// ReopenOrder → GET /api/order/reopen (RAW_STRING).
func (s *OrderService) ReopenOrder(ctx context.Context, ticket uint64) response.GlobalResponse {
	env, _, _ := fetchGet(ctx, s.c, fmt.Sprintf(mt5.PathOrderReopen, ticket))
	return env
}

// GetOrderServiceData dispatches the WS order method (only GetPagebyPageOrder is
// wired; any other MethodType reproduces the .NET null-deref → error envelope).
func (s *OrderService) GetOrderServiceData(ctx context.Context, login int64, offset, total int, methodType, source string) response.GlobalResponse {
	switch methodType {
	case "GetPagebyPageOrder":
		return s.GetPagebyPageOrder(ctx, login, offset, total, source)
	default:
		return catchError(errors.New("Object reference not set to an instance of an object."))
	}
}
