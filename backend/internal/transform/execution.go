package transform

// Per-fill executions. There was no fill-level feed at all, so TradingView's
// execution markers were always empty; synthesising them from the deal page
// would misreport the fill price of a partially-filled order, because a page
// row is the order, not the fills that made it.

// MT5 DEAL_ACTION values. Only BUY and SELL are fills — the rest are balance
// operations (deposits, credits, corrections, commissions) that carry no price
// and must never reach a chart as an execution marker.
const (
	DealActionBuy  = 0
	DealActionSell = 1
)

// TVExecution is one fill, in TradingView's execution shape. Time is unix
// MILLISECONDS (TradingView's convention for execution markers); every other
// timestamp in this API is seconds.
type TVExecution struct {
	ID         string  `json:"id"`
	OrderID    string  `json:"orderId"`
	PositionID string  `json:"positionId"`
	Symbol     string  `json:"symbol"`
	Price      float64 `json:"price"`
	// Qty is the filled volume in LOTS; QtyMT5 is the same volume in MT5's
	// 1/10000 lot, kept so a reconciliation can compare like with like.
	Qty    float64 `json:"qty"`
	QtyMT5 float64 `json:"qtyMt5"`
	Side   int     `json:"side"`
	Time   int64   `json:"time"`
	// TimeSeconds is Time in unix seconds — the cursor to pass back as `after`.
	TimeSeconds int64   `json:"timeSeconds"`
	Commission  float64 `json:"commission"`
	Swap        float64 `json:"swap"`
	Profit      float64 `json:"profit"`
	// Entry is the raw MT5 DEAL_ENTRY (0=in, 1=out, 2=in/out, 3=out by).
	Entry   int    `json:"entry"`
	Comment string `json:"comment"`
}

// DealsToExecutions maps MT5 deals to TV executions, keeping only real fills
// and only those strictly after the cursor. Deals at exactly `after` are
// excluded so a client polling with the last seen timestamp never re-renders a
// marker it already has.
//
// brokerOffset (broker_clock − UTC, seconds) restates MT5's broker-stamped deal
// times in UTC BEFORE the cursor comparison, so `after` and `timeSeconds` live
// on one clock and a marker can sit on the same axis as the chart's UTC bars.
func DealsToExecutions(deals []DealAnswer, after, brokerOffset int64) []TVExecution {
	out := make([]TVExecution, 0, len(deals))
	for _, d := range deals {
		if int(d.Action) != DealActionBuy && int(d.Action) != DealActionSell {
			continue
		}
		seconds := shiftEpoch(int64(d.Time), brokerOffset)
		if seconds <= after {
			continue
		}
		millis := int64(d.TimeMsc)
		if millis > 0 {
			millis -= brokerOffset * 1000
		} else {
			millis = seconds * 1000
		}
		side := 1
		if int(d.Action) == DealActionSell {
			side = -1
		}
		out = append(out, TVExecution{
			ID:          d.Deal,
			OrderID:     d.Order,
			PositionID:  d.PositionID,
			Symbol:      d.Symbol,
			Price:       float64(d.Price),
			Qty:         LotsPreferExt(float64(d.Volume), float64(d.VolumeExt)),
			QtyMT5:      float64(d.Volume),
			Side:        side,
			Time:        millis,
			TimeSeconds: seconds,
			Commission:  float64(d.Commission),
			Swap:        float64(d.Storage),
			Profit:      float64(d.Profit),
			Entry:       int(d.Entry),
			Comment:     d.Comment,
		})
	}
	return out
}
