package transform

import (
	"math"
	"strconv"
)

// ptr returns a pointer to v (for nullable JSON fields that ARE assigned).
func ptr[T any](v T) *T { return &v }

// ── Orders ───────────────────────────────────────────────────────────────────

// OrdersToTVStd reproduces the GetPage / History.ClosedOrderPageByPage TV block:
// side = Type%2, status = MT5ToTVStatus(State). brokerOffset (broker_clock −
// UTC, seconds) restates MT5's broker-stamped times in UTC; 0 passes them
// through.
func OrdersToTVStd(answer []OrderHistoryAnswer, brokerOffset int64) []TVOrderHistory {
	out := make([]TVOrderHistory, 0, len(answer))
	for _, item := range answer {
		ts := shiftEpoch(int64(item.TimeSetup), brokerOffset)
		done, final := finalTime(item, brokerOffset, ts)
		o := TVOrderHistory{
			ID:         item.Order,
			Symbol:     item.Symbol,
			Type:       MT5ToTVType(int(item.Type)),
			Side:       SideFromType(int(item.Type)),
			Qty:        float64(item.VolumeInitial),
			LimitPrice: float64(item.PriceOrder),
			StopPrice:  float64(item.PriceOrder),
			StopLoss:   float64(item.PriceSL),
			TakeProfit: float64(item.PriceTP),
			Status:     MT5ToTVStatus(int(item.State)),
			FilledQty:  filledVolume(item),
			Message:    item.Comment,
			UpdateTime: int(final),
			TimeSetup:  &ts,
			TimeDone:   done,
		}
		applyOrderVolumeAndDuration(&o, item, brokerOffset)
		out = append(out, o)
	}
	return out
}

// OrdersToTVV2 reproduces the GetPagebyPageOrder TV block. Status uses
// MT5ToTVStatus — the same status table as the REST path.
//
// It used to use MT5ToTVType, an ORDER-TYPE table, which collapsed distinct
// states onto one number: status 1 meant CANCELED *or* PARTIALLY FILLED and
// status 3 meant FILLED *or* REJECTED, so over the WebSocket a filled order and
// a rejected one were indistinguishable.
//
// Side is derived from Type, exactly as OrdersToTVStd does. The .NET original
// copied the record's raw `side` field, and this port followed it — but a real
// MT5 order record has no such field (every other field it sends is
// PascalCase), so it decoded to 0 on every live order. 0 is not a TV side; the
// frontend reads `side >= 0` as BUY, so every order this endpoint pushed
// arrived as a BUY. A resting Sell Stop showed as a Buy Stop in the orders
// table, on its chart line and in the modify and cancel dialogs, and cancelling
// it re-derived MT5 type 4 (Buy Stop) from that side and was refused with 10023
// "Order state changed" — an order the trader could not remove. MT5's Type
// already encodes the side unambiguously (even=buy, odd=sell), and the two
// endpoints must never answer differently about the same order.
func OrdersToTVV2(answer []OrderHistoryAnswer, brokerOffset int64) []TVOrderHistory {
	out := make([]TVOrderHistory, 0, len(answer))
	for _, order := range answer {
		ts := shiftEpoch(int64(order.TimeSetup), brokerOffset)
		done, final := finalTime(order, brokerOffset, ts)
		o := TVOrderHistory{
			ID:         order.Order,
			Symbol:     order.Symbol,
			Type:       MT5ToTVType(int(order.Type)),
			Side:       SideFromType(int(order.Type)),
			Qty:        float64(order.VolumeInitial),
			LimitPrice: float64(order.PriceOrder),
			StopPrice:  float64(order.PriceOrder),
			StopLoss:   float64(order.PriceSL),
			TakeProfit: float64(order.PriceTP),
			Status:     MT5ToTVStatus(int(order.State)),
			FilledQty:  filledVolume(order),
			Message:    order.Comment,
			UpdateTime: int(final),
			TimeSetup:  &ts,
			TimeDone:   done,
		}
		applyOrderVolumeAndDuration(&o, order, brokerOffset)
		out = append(out, o)
	}
	return out
}

// finalTime states when an order reached its FINAL state — filled, cancelled,
// rejected or expired — in UTC unix seconds, alongside the value `updateTime`
// should carry.
//
// Both mappings used to publish TimeSetup as `updateTime`, so every row in the
// order history reported that it had been completed at the instant it was
// placed: a buy stop placed at 19:08:50 and filled at 19:23:10 showed 19:08:50
// in both columns, and there was no way to tell from that table when anything
// had actually executed (2026-08-20 retest, BUG-F).
//
// MT5 leaves TimeDone at 0 for an order that is still working, and `updateTime`
// is a plain int that TradingView renders unconditionally — so it falls back to
// the setup time, which is the best true statement available about a row that
// has not finished. `timeDone` stays null there, so the two cases remain
// distinguishable to anything that looks.
func finalTime(a OrderHistoryAnswer, brokerOffset, setup int64) (*int64, int64) {
	if a.TimeDone <= 0 {
		return nil, setup
	}
	done := shiftEpoch(int64(a.TimeDone), brokerOffset)
	return &done, done
}

// applyOrderVolumeAndDuration fills the additive fields shared by both order
// mappings: volumes restated in lots, and the expiration/duration block that
// lets the order ticket offer GTC/DAY/GTD instead of assuming GTC. The GTD
// deadline is broker-stamped like every other MT5 time, so it is restated in
// UTC with the same offset (zero = "no expiry" and is never shifted).
func applyOrderVolumeAndDuration(o *TVOrderHistory, a OrderHistoryAnswer, brokerOffset int64) {
	o.QtyLots = LotsPreferExt(float64(a.VolumeInitial), float64(a.VolumeInitialExt))
	o.FilledQtyLots = filledLots(a)
	o.TypeTime = int(a.TypeTime)
	o.Expiration = shiftEpoch(int64(a.TimeExpiration), brokerOffset)
	o.Duration = DurationFromMT5(int(a.TypeTime), o.Expiration)
}

// filledVolume and filledLots state how much of an order has EXECUTED.
//
// MT5's VolumeCurrent is the order's REMAINING volume: it starts equal to
// VolumeInitial and reaches 0 on full execution. The .NET service mapped it
// straight onto `filledQty`, and this port followed — which inverted the
// meaning on every order. A working pending order reported itself fully
// filled, so TradingView drew its chart line with nothing left to fill (the
// "0 | Sell Stop" label), and a genuinely filled order reported 0 filled.
//
// Executed volume is therefore initial − remaining, floored at zero so a
// broker that reports the two inconsistently cannot produce a negative fill.
func filledVolume(a OrderHistoryAnswer) float64 {
	return math.Max(0, float64(a.VolumeInitial)-float64(a.VolumeCurrent))
}

func filledLots(a OrderHistoryAnswer) float64 {
	initial := LotsPreferExt(float64(a.VolumeInitial), float64(a.VolumeInitialExt))
	remaining := LotsPreferExt(float64(a.VolumeCurrent), float64(a.VolumeCurrentExt))
	return roundLots(math.Max(0, initial-remaining))
}

// shiftEpoch restates a broker-stamped unix-seconds value in UTC. Zero and
// negative values mean "not set" and pass through untouched.
func shiftEpoch(v, brokerOffset int64) int64 {
	if v <= 0 {
		return v
	}
	return v - brokerOffset
}

// ── Positions ────────────────────────────────────────────────────────────────

// positionBase builds the fields every position mapping shares, including the
// cost columns (swap/commission) that no shape carried before — a trader
// reconciling costs could not see them at all.
func positionBase(p PositionAnswer) TVPositionResponse {
	return TVPositionResponse{
		ID:         int(p.Position),
		Profit:     float64(p.Profit),
		Qty:        int(p.Volume),
		Side:       SideFromType(int(p.Action)),
		Symbol:     p.Symbol,
		Type:       0,
		Last:       float64(p.PriceCurrent),
		Price:      float64(p.PriceOpen),
		QtyLots:    LotsPreferExt(float64(p.Volume), float64(p.VolumeExt)),
		Swap:       floatPtr(p.Storage),
		Commission: floatPtr(p.Commission),
	}
}

// floatPtr converts an optional upstream number to an optional float64,
// preserving "not sent" as nil instead of flattening it to 0.
func floatPtr(v *Float) *float64 {
	if v == nil {
		return nil
	}
	return ptr(float64(*v))
}

// PositionToTV reproduces GetPosition (single, no timeCreate/priceSL/priceTP).
func PositionToTV(a PositionAnswer) TVPositionResponse { return positionBase(a) }

// PositionsToTVPage reproduces GetPagebyPagePosition (adds timeCreate/priceSL/priceTP).
// brokerOffset restates the broker-stamped open time in UTC; 0 passes it through.
func PositionsToTVPage(answer []PositionAnswer, brokerOffset int64) []TVPositionResponse {
	out := make([]TVPositionResponse, 0, len(answer))
	for _, p := range answer {
		tv := positionBase(p)
		tv.TimeCreate = ptr(shiftEpoch(int64(p.TimeCreate), brokerOffset))
		tv.PriceSL = ptr(float64(p.PriceSL))
		tv.PriceTP = ptr(float64(p.PriceTP))
		out = append(out, tv)
	}
	return out
}

// PositionsToTVWs reproduces GetPagebyPagePositionWs. It is deliberately
// identical to the REST page shape: it previously omitted priceSL/priceTP,
// which left the WebSocket stream unable to say whether a protective level
// existed at all between REST snapshots. A stream that reports less than the
// snapshot it interleaves with makes the two disagree.
func PositionsToTVWs(answer []PositionAnswer, brokerOffset int64) []TVPositionResponse {
	return PositionsToTVPage(answer, brokerOffset)
}

// UpdatePositionToTV reproduces UpdatePosition's success object.
func UpdatePositionToTV(a PositionAnswer) UpdatePositionResponse {
	return UpdatePositionResponse{
		Position:      int(a.Position),
		ExternalID:    a.ExternalID,
		Login:         int(a.Login),
		Symbol:        a.Symbol,
		PriceSL:       float64(a.PriceSL),
		PriceTP:       float64(a.PriceTP),
		VolumeInitial: int(a.Volume),
	}
}

// ── User ─────────────────────────────────────────────────────────────────────

// UserToTV reproduces Getbylogin TV (id = int.Parse(ID)); returns an error if
// ID is non-numeric.
func UserToTV(a MT5UserAnswer) (TVUserResponse, error) {
	id, err := strconv.Atoi(a.ID)
	if err != nil {
		return TVUserResponse{}, err
	}
	return TVUserResponse{ID: id, Name: a.Name}, nil
}

// AccountToTV reproduces GetTradeState TV.
func AccountToTV(a AccountSummaryAnswer) TVAccountSummary {
	return TVAccountSummary{Title: a.Login, Balance: float64(a.Balance), Equity: float64(a.Equity), PL: float64(a.Profit)}
}

// ── Modify order ─────────────────────────────────────────────────────────────

// ModifyOrderToTV reproduces UpdateOrder's TVResponseModifyOrder.
func ModifyOrderToTV(a MT5ModifyOrderResponse) TVResponseModifyOrder {
	return TVResponseModifyOrder{
		Order:         int(a.Order),
		ExternalID:    a.ExternalID,
		Login:         int(a.Login),
		Symbol:        a.Symbol,
		PriceOrder:    float64(a.PriceOrder),
		PriceSL:       float64(a.PriceSL),
		PriceTP:       float64(a.PriceTP),
		VolumeInitial: int(a.VolumeInitial),
	}
}

// ── Quotes / chart ───────────────────────────────────────────────────────────

// QuotesToTV reproduces GetQuotes TV: lastprice = Last>0 ? Last : Bid.
//
// brokerOffset is broker_clock − utc; the broker stamps its ticks on its own
// clock and the quote goes out in UTC, so a client can place a tick on the same
// axis as the bars without knowing the broker's timezone.
func QuotesToTV(answer []TicklastAnswer, brokerOffset int64) []Quote {
	out := make([]Quote, 0, len(answer))
	for _, item := range answer {
		last := float64(item.Bid)
		if float64(item.Last) > 0 {
			last = float64(item.Last)
		}
		out = append(out, Quote{
			SymbolName: item.Symbol,
			Status:     "Ok",
			Bid:        float64(item.Bid),
			Ask:        float64(item.Ask),
			LastPrice:  last,
			Volume:     float64(item.Volume),
			Time:       TickTimeUTC(item, brokerOffset),
		})
	}
	return out
}

// TickTimeUTC reads a tick's broker-stamped time and restates it in UTC.
// DatetimeMsc is preferred when the broker publishes it. Zero when the tick
// carries no usable time — better an absent timestamp than a fabricated one,
// since a client uses this to decide whether a quote is fresh.
func TickTimeUTC(t TicklastAnswer, brokerOffset int64) int64 {
	if msc, err := strconv.ParseInt(t.DatetimeMsc, 10, 64); err == nil && msc > 0 {
		return msc/1000 - brokerOffset
	}
	if secs, err := strconv.ParseInt(t.Datetime, 10, 64); err == nil && secs > 0 {
		return secs - brokerOffset
	}
	return 0
}

// ChartToTV reproduces GetM1History (API branch): [time,open,high,low,close],
// with tick volume mapped from index 5 when the broker publishes it (the .NET
// port pinned volume to 0, which is why TradingView drew a flat zero volume
// study over live bars — TV-001). Rows shorter than 5 are skipped.
func ChartToTV(rows [][]Float) []TVTickResponse {
	out := make([]TVTickResponse, 0, len(rows))
	for _, r := range rows {
		if len(r) < 5 {
			continue
		}
		volume := 0
		if len(r) >= 6 && float64(r[5]) > 0 {
			volume = int(r[5])
		}
		out = append(out, TVTickResponse{
			Time:   int64(r[0]),
			Open:   float64(r[1]),
			High:   float64(r[2]),
			Low:    float64(r[3]),
			Close:  float64(r[4]),
			Volume: ptr(volume),
		})
	}
	return out
}

// ── Symbols ──────────────────────────────────────────────────────────────────

// applyVolumeBounds fills the lot-denominated tradable-volume bounds every
// symbol block carries. MT5 populates the Ext fields only on brokers with
// extended volume precision, so LotsPreferExt picks whichever is authoritative.
func applyVolumeBounds(s *TVSymbolResponse, a SymbolByNameAnswer) {
	s.VolumeMinLots = LotsPreferExt(float64(a.VolumeMin), float64(a.VolumeMinExt))
	s.VolumeMaxLots = LotsPreferExt(float64(a.VolumeMax), float64(a.VolumeMaxExt))
	s.VolumeStepLots = LotsPreferExt(float64(a.VolumeStep), float64(a.VolumeStepExt))
}

// SymbolByNameToTV reproduces getsymbolsbyname TV (Block A: currency_code=CurrencyBase).
func SymbolByNameToTV(a SymbolByNameAnswer) TVSymbolResponse {
	s := NewTVSymbolResponse()
	s.Ticker = a.Symbol
	s.Name = a.Symbol
	s.Description = a.Description
	s.Type = PathToType(a.Path)
	s.Session = ConvertSessionsMt5ToTv(a.SessionsTrades)
	s.PriceScale = int(a.Multiply)
	s.VolumePrecision = int(a.VolumeMin)
	s.CurrencyCode = a.CurrencyBase
	s.BaseName = a.Symbol
	s.Legs = ""
	s.FullName = a.Symbol
	s.ProName = a.Symbol
	s.Sector = a.Sector
	s.Industry = a.Industry
	applyVolumeBounds(&s, a)
	return s
}

// SymbolByMaskToTV reproduces getsymbolsbyMask TV (Block B: currency_code=Symbol).
func SymbolByMaskToTV(a SymbolByNameAnswer) TVSymbolResponse {
	s := NewTVSymbolResponse()
	s.Ticker = a.Symbol
	s.Name = a.Symbol
	s.Description = a.Description
	s.Type = PathToType(a.Path)
	s.Session = ConvertSessionsMt5ToTv(a.SessionsTrades)
	s.PriceScale = int(a.Multiply)
	s.VolumePrecision = int(a.VolumeMin)
	s.CurrencyCode = a.Symbol
	s.BaseName = a.Symbol
	s.Legs = ""
	s.FullName = a.Symbol
	s.ProName = a.Symbol
	s.Sector = a.Sector
	s.Industry = a.Industry
	applyVolumeBounds(&s, a)
	return s
}

// SymbolByGroupToTV reproduces getsymbolsbyGroup TV (Block C: session="",
// pricescale=VolumeMinExt, volume_precision=0, base_name=CurrencyBase).
func SymbolByGroupToTV(a SymbolByNameAnswer) TVSymbolResponse {
	s := NewTVSymbolResponse()
	s.Ticker = a.Symbol
	s.Name = a.Symbol
	s.Description = a.Description
	s.Type = PathToType(a.Path)
	s.Session = ""
	s.PriceScale = int(a.VolumeMinExt)
	s.VolumePrecision = 0
	s.CurrencyCode = ""
	s.BaseName = a.CurrencyBase
	s.Legs = ""
	s.FullName = ""
	s.ProName = ""
	s.Sector = a.Sector
	s.Industry = a.Industry
	applyVolumeBounds(&s, a)
	return s
}

// ── Trade ────────────────────────────────────────────────────────────────────

// PlacedOrderFromAnswer reproduces Send_request(TradeRequest) TV PlacedOrder,
// plus the explicit verdict block: resultRetcode is passed through verbatim and
// outcome/retcodeDescription are derived from it, so a caller never has to
// reverse-engineer acceptance from `status` or from the presence of an id.
//
// updateTime = utcUnixSeconds * 1000 (ms, UTC). The .NET original added a
// hard-coded +3h here — the broker's timezone baked into a public timestamp —
// which is exactly the class of drift TIME-001 removed: every timestamp this
// API emits is UTC, and the display timezone is the client's concern.
func PlacedOrderFromAnswer(a PlaceOrderAnswer, utcUnixSeconds int64) PlacedOrder {
	updateTime := float64(utcUnixSeconds * 1000)
	return PlacedOrder{
		AvgPrice:   ptr(float64(a.ResultPrice)),
		FilledQty:  ptr(float64(a.ResultVolume)),
		ID:         a.Order,
		LimitPrice: ptr(float64(a.PriceOrder)),
		Message:    a.Comment,
		Qty:        float64(a.Volume),
		Side:       GetSideType(a.Type),
		Status:     GetStatusType(a.ResultRetcode),
		StopLoss:   ptr(float64(a.PriceSL)),
		StopPrice:  ptr(float64(a.PriceOrder)),
		StopType:   0, // TVStopType.StopLoss
		Symbol:     a.Symbol,
		TakeProfit: ptr(float64(a.PriceTP)),
		Type:       GetOrderType(a.Type),
		UpdateTime: &updateTime,

		ResultRetcode:      a.ResultRetcode,
		Outcome:            OutcomeFromRetcode(a.ResultRetcode),
		RetcodeDescription: RetcodeDescription(a.ResultRetcode),
		QtyLots:            Lots(float64(a.Volume)),
		FilledQtyLots:      ptr(Lots(float64(a.ResultVolume))),
		Expiration:         int64(a.TimeExpiration),
		TypeTime:           int(a.TypeTime),
		Duration:           DurationFromMT5(int(a.TypeTime), int64(a.TimeExpiration)),
	}
}
