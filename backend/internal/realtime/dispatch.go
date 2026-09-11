package realtime

import (
	"context"
	"encoding/json"
	"strconv"

	"github.com/nimadorostkar/TradePlatformDemo/backend/internal/domain"
)

// Services holds the domain services the dispatcher needs (the same services
// the REST handlers use).
type Services struct {
	Tick     *domain.TickService
	Position *domain.PositionService
	User     *domain.UserService
	Order    *domain.OrderService
	// Alert and Deal back the two subscriptions added beyond the .NET contract
	// (TP 6 and 7). Either may be nil in a process that does not serve them.
	Alert *domain.AlertService
	Deal  *domain.DealService
}

// Dispatch reproduces the .NET /ws TP switch and returns the message bytes to
// push: the serialized GlobalResponse.data (NOT the whole envelope), matching
// `JsonConvert.SerializeObject(serviceresponse.data)`. Unknown TP → the literal
// "Invalid TP value".
func (s Services) Dispatch(ctx context.Context, p Params) []byte {
	source := p.sourceOrDefault()
	switch p.TP {
	case "1":
		env := s.Tick.GetTickServiceData(ctx, p.Symbol, p.ID, p.MethodType, p.Group, source,
			parseInt64(p.FromTime), parseInt64(p.ToTime), p.Data, "1D")
		return marshalData(env.Data)
	case "2":
		env := s.Position.GetPositionServiceData(ctx, p.Symbol, parseInt64(p.Login),
			p.Group, p.Offset, p.Total, p.Ticket, p.MethodType, source)
		return marshalData(env.Data)
	case "3":
		env := s.User.GetUserServiceData(ctx, parseInt64(p.Login), p.MethodType)
		return marshalData(env.Data)
	case "4":
		env := s.Order.GetOrderServiceData(ctx, parseInt64(p.Login),
			parseInt(p.Offset), parseInt(p.Total), p.MethodType, source)
		return marshalData(env.Data)
	case "5":
		env := s.Tick.GetTickServiceData(ctx, p.Symbol, p.ID, p.MethodType, p.Group, source,
			parseInt64(p.FromTime), parseInt64(p.ToTime), p.Data, "1D")
		return marshalData(env.Data)
	case "6":
		// Price alerts. `fromtime` is the delivery cursor: with it, only alerts
		// that fired after that second are pushed, so a client can render each
		// trigger exactly once; without it, the full alert list is pushed.
		if s.Alert == nil {
			return []byte("null")
		}
		if p.FromTime != "" {
			return marshalData(s.Alert.TriggeredSince(ctx, p.Login, parseInt64(p.FromTime)).Data)
		}
		return marshalData(s.Alert.List(ctx, p.Login).Data)
	case "7":
		// Per-fill executions since the `fromtime` cursor.
		if s.Deal == nil {
			return []byte("null")
		}
		env := s.Deal.ExecutionsSince(ctx, parseInt64(p.Login), parseInt64(p.FromTime), parseInt(p.Total))
		return marshalData(env.Data)
	default:
		return []byte("Invalid TP value")
	}
}

// marshalData serializes the data field; nil → "null" (matching Newtonsoft).
func marshalData(data any) []byte {
	b, err := json.Marshal(data)
	if err != nil {
		return []byte("null")
	}
	return b
}

func parseInt(s string) int {
	n, _ := strconv.Atoi(s)
	return n
}

func parseInt64(s string) int64 {
	n, _ := strconv.ParseInt(s, 10, 64)
	return n
}
