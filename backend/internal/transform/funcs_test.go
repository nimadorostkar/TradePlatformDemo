package transform

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestMappingTables(t *testing.T) {
	typeCases := map[int]int{0: 2, 1: 2, 2: 1, 3: 1, 4: 3, 5: 3, 6: 4, 7: 4, 99: 0}
	for in, want := range typeCases {
		if got := MT5ToTVType(in); got != want {
			t.Errorf("MT5ToTVType(%d)=%d want %d", in, got, want)
		}
	}
	statusCases := map[int]int{0: 4, 1: 6, 2: 1, 3: 6, 4: 2, 5: 5, 6: 1, 99: 0}
	for in, want := range statusCases {
		if got := MT5ToTVStatus(in); got != want {
			t.Errorf("MT5ToTVStatus(%d)=%d want %d", in, got, want)
		}
	}
	for _, in := range []string{"0", "2", "4", "6"} {
		if GetSideType(in) != 1 {
			t.Errorf("GetSideType(%s) want 1", in)
		}
	}
	for _, in := range []string{"1", "3", "5", "7"} {
		if GetSideType(in) != -1 {
			t.Errorf("GetSideType(%s) want -1", in)
		}
	}
	orderTypeCases := map[string]int{"0": 2, "2": 1, "4": 3, "6": 4, "x": 0}
	for in, want := range orderTypeCases {
		if got := GetOrderType(in); got != want {
			t.Errorf("GetOrderType(%s)=%d want %d", in, got, want)
		}
	}
	statusTypeCases := map[string]int{"10001": 4, "10006": 5, "10007": 1, "10008": 6, "10009": 2, "10010": 6, "x": 5}
	for in, want := range statusTypeCases {
		if got := GetStatusType(in); got != want {
			t.Errorf("GetStatusType(%s)=%d want %d", in, got, want)
		}
	}
}

func TestOrdersToTV(t *testing.T) {
	// Side: -1 contradicts Type 4 (Buy Stop) on purpose — MT5 does not send a
	// `side` field, and Type is the authority on both paths.
	ans := []OrderHistoryAnswer{{Order: "1", Symbol: "EURUSD", Type: 4, State: 4, VolumeInitial: 20000, PriceOrder: 1.1, PriceSL: 1.0, PriceTP: 1.2, VolumeCurrent: 10000, Comment: "c", TimeSetup: 9, Side: -1}}
	std := OrdersToTVStd(ans, 0)[0]
	if std.Type != 3 || std.Side != 1 || std.Status != 2 { // Type4->Stop(3); side=4%2==0->1; State4(FILLED)->2
		t.Errorf("std mapping wrong: %+v", std)
	}
	v2 := OrdersToTVV2(ans, 0)[0]
	// Both paths must use the STATUS table. Using the order-TYPE table here is
	// what once made FILLED and REJECTED indistinguishable over the WebSocket.
	// And both must agree on side: one order cannot be a buy over REST and a
	// sell over the WebSocket.
	if v2.Side != std.Side || v2.Status != std.Status {
		t.Errorf("v2 must match the REST side and status tables: %+v", v2)
	}
	if v2.QtyLots != 2 || v2.FilledQtyLots != 1 {
		t.Errorf("volumes must be restated in lots: qty=%v filled=%v", v2.QtyLots, v2.FilledQtyLots)
	}
}

// A rejected order and a filled one must map to different WS statuses. This is
// the exact confusion the old order-TYPE table produced.
func TestWSOrderStatusDistinguishesFilledFromRejected(t *testing.T) {
	const filled, rejected = 4, 5
	orders := OrdersToTVV2([]OrderHistoryAnswer{{Order: "1", State: filled}, {Order: "2", State: rejected}}, 0)
	if orders[0].Status == orders[1].Status {
		t.Fatalf("filled and rejected collapsed onto status %d", orders[0].Status)
	}
	if orders[0].Status != MT5ToTVStatus(filled) || orders[1].Status != MT5ToTVStatus(rejected) {
		t.Errorf("statuses = %d,%d", orders[0].Status, orders[1].Status)
	}
}

func TestOrderExpiration(t *testing.T) {
	const deadline = int64(1800000000)
	gtd := OrdersToTVStd([]OrderHistoryAnswer{{TypeTime: OrderTimeSpecified, TimeExpiration: Int64(deadline)}}, 0)[0]
	if gtd.Expiration != deadline || gtd.TypeTime != OrderTimeSpecified {
		t.Errorf("expiration not carried: %+v", gtd)
	}
	if gtd.Duration == nil || *gtd.Duration.Type != DurationGTD || gtd.Duration.Datetime == nil {
		t.Errorf("GTD duration block wrong: %+v", gtd.Duration)
	}
	gtc := OrdersToTVStd([]OrderHistoryAnswer{{TypeTime: OrderTimeGTC}}, 0)[0]
	if gtc.Expiration != 0 || gtc.Duration == nil || *gtc.Duration.Type != DurationGTC {
		t.Errorf("GTC duration block wrong: %+v", gtc.Duration)
	}
	if gtc.Duration.Datetime != nil {
		t.Error("GTC must not claim a deadline")
	}
}

func TestPositionsToTV(t *testing.T) {
	swap := Float(-2.5)
	a := PositionAnswer{Position: 5, Symbol: "X", Action: 1, Volume: 30000, Profit: 2, PriceOpen: 1, PriceCurrent: 1.1, PriceSL: 0.9, PriceTP: 1.2, TimeCreate: 7, Storage: &swap}
	single := PositionToTV(a)
	if single.Side != -1 || single.TimeCreate != nil || single.PriceSL != nil {
		t.Errorf("single position should omit timeCreate/priceSL: %+v", single)
	}
	if single.QtyLots != 3 {
		t.Errorf("qtyLots = %v, want 3", single.QtyLots)
	}
	if single.Swap == nil || *single.Swap != -2.5 {
		t.Errorf("swap should come from Storage: %v", single.Swap)
	}
	// Commission was not sent, so it must be null — not 0. A trader
	// reconciling costs reads those as different facts.
	if single.Commission != nil {
		t.Errorf("absent commission must be null, got %v", *single.Commission)
	}
	page := PositionsToTVPage([]PositionAnswer{a}, 0)[0]
	if page.TimeCreate == nil || page.PriceSL == nil || page.PriceTP == nil {
		t.Errorf("page position should include timeCreate/priceSL/priceTP")
	}
	// The WS shape must not report less than the snapshot it interleaves with.
	ws := PositionsToTVWs([]PositionAnswer{a}, 0)[0]
	if ws.TimeCreate == nil || ws.PriceSL == nil || ws.PriceTP == nil {
		t.Errorf("ws position must carry timeCreate/priceSL/priceTP: %+v", ws)
	}
	upd := UpdatePositionToTV(a)
	if upd.Position != 5 || upd.VolumeInitial != 30000 {
		t.Errorf("update position wrong: %+v", upd)
	}
}

func TestUserAndAccountAndModify(t *testing.T) {
	if _, err := UserToTV(MT5UserAnswer{ID: "notnum"}); err == nil {
		t.Error("non-numeric ID should error")
	}
	u, err := UserToTV(MT5UserAnswer{ID: "42", Name: "A"})
	if err != nil || u.ID != 42 || u.Currency != nil {
		t.Errorf("user tv wrong: %+v %v", u, err)
	}
	acc := AccountToTV(AccountSummaryAnswer{Login: "L", Balance: 1, Equity: 2, Profit: 3})
	if acc.Title != "L" || acc.PL != 3 {
		t.Errorf("account tv wrong: %+v", acc)
	}
	mod := ModifyOrderToTV(MT5ModifyOrderResponse{Order: 9, Symbol: "S", VolumeInitial: 4})
	if mod.Order != 9 || mod.VolumeInitial != 4 {
		t.Errorf("modify tv wrong: %+v", mod)
	}
}

func TestChartAndPlacedOrder(t *testing.T) {
	bars := ChartToTV([][]Float{{100, 1, 2, 0.5, 1.5}, {101}}) // second row skipped (len<5)
	if len(bars) != 1 || bars[0].Time != 100 || bars[0].Volume == nil || *bars[0].Volume != 0 {
		t.Errorf("chart tv wrong: %+v", bars)
	}
	po := PlacedOrderFromAnswer(PlaceOrderAnswer{Order: "7", Symbol: "S", Type: "1", Volume: 2, PriceOrder: 1.1, PriceSL: 1, PriceTP: 1.2, ResultRetcode: "10009", ResultPrice: 1.05, ResultVolume: 2}, 1000)
	if po.Side != -1 || po.Status != 2 || po.Type != 2 { // Type1->side-1,market2; retcode10009->2
		t.Errorf("placed order mapping wrong: %+v", po)
	}
	// TIME-001: updateTime is plain UTC milliseconds. The +3h the .NET service
	// baked in here was the broker's timezone leaking into a public timestamp.
	if *po.UpdateTime != float64(1000*1000) {
		t.Errorf("updateTime not UTC ms: %v", *po.UpdateTime)
	}
}

func TestSymbolTransforms(t *testing.T) {
	a := SymbolByNameAnswer{Symbol: "EURUSD", Path: `Forex\Majors\EURUSD`, Description: "d", CurrencyBase: "EUR", Multiply: 100000, VolumeMin: 1000, VolumeMinExt: 2, Sector: "s", Industry: "i", SessionsTrades: [][]Session{{{Open: 0, Close: 60}}}}
	byName := SymbolByNameToTV(a)
	if byName.Type != "Majors" || byName.CurrencyCode != "EUR" || byName.Session != "0000-0100:1" {
		t.Errorf("byName wrong: %+v", byName)
	}
	byMask := SymbolByMaskToTV(a)
	if byMask.CurrencyCode != "EUR" && byMask.CurrencyCode != a.Symbol {
		t.Errorf("byMask currency should be Symbol: %s", byMask.CurrencyCode)
	}
	byGroup := SymbolByGroupToTV(a)
	if byGroup.Session != "" || byGroup.PriceScale != 2 || byGroup.BaseName != "EUR" {
		t.Errorf("byGroup wrong: %+v", byGroup)
	}
	// constant defaults must serialize
	b, _ := json.Marshal(byName)
	for _, want := range []string{`"timezone":"Europe/Istanbul"`, `"exchange":"Opofinance"`, `"volume":1000`} {
		if !strings.Contains(string(b), want) {
			t.Errorf("missing default %s", want)
		}
	}
}

func TestBucketStart(t *testing.T) {
	// 2023-11-15 12:00:00 UTC = 1700049600
	const ts = int64(1700049600)
	day := BucketStart(ts, "1D")
	if day != 1700006400 { // 2023-11-15 00:00 UTC
		t.Errorf("daily bucket = %d", day)
	}
	month := BucketStart(ts, "1M")
	if month != 1698796800 { // 2023-11-01 00:00 UTC
		t.Errorf("monthly bucket = %d", month)
	}
	week := BucketStart(ts, "1W") // Monday of that week
	if week >= day {
		t.Errorf("weekly bucket should be <= day start")
	}
}

// A real MT5 order record carries no `side` field — the side lives in `Type`
// (even=buy, odd=sell). The WS transform used to copy the raw field, so every
// order it pushed arrived as side 0, which the frontend reads as BUY: a resting
// Sell Stop rendered as a Buy Stop in the orders table, on the chart line, and
// in the modify/cancel dialogs, and cancelling it re-derived MT5 type 4 from
// that wrong side and was rejected 10023.
func TestWSOrderSideIsDerivedFromTypeNotARawField(t *testing.T) {
	for _, mt5Type := range []Int{2, 3, 4, 5} {
		// No Side: exactly what MT5 sends.
		ans := []OrderHistoryAnswer{{Order: "1", Symbol: "EURUSD", Type: mt5Type, State: 1}}
		v2 := OrdersToTVV2(ans, 0)[0]
		std := OrdersToTVStd(ans, 0)[0]

		if v2.Side == 0 {
			t.Errorf("type %d: WS side 0 is not a TV side; the frontend reads it as BUY", mt5Type)
		}
		if v2.Side != std.Side {
			t.Errorf("type %d: WS side %d contradicts REST side %d for the SAME order",
				mt5Type, v2.Side, std.Side)
		}
		if want := SideFromType(int(mt5Type)); v2.Side != want {
			t.Errorf("type %d: side = %d, want %d", mt5Type, v2.Side, want)
		}
	}
}

// MT5's VolumeCurrent is the order's REMAINING volume, not the filled amount:
// it starts equal to VolumeInitial and reaches 0 on full execution. Reporting
// it as filledQty inverted the meaning — a working order looked fully filled
// (which renders its chart line with 0 left to fill) and a filled order looked
// untouched.
func TestOrderFilledVolumeIsInitialMinusRemaining(t *testing.T) {
	cases := []struct {
		name                      string
		initial, current          Float
		wantQtyLots, wantFillLots float64
	}{
		{"working, nothing filled", 10000, 10000, 1, 0},
		{"partially filled", 10000, 4000, 1, 0.6},
		{"fully filled", 10000, 0, 1, 1},
	}
	for _, c := range cases {
		ans := []OrderHistoryAnswer{{Order: "1", VolumeInitial: c.initial, VolumeCurrent: c.current}}
		for name, got := range map[string]TVOrderHistory{
			"std": OrdersToTVStd(ans, 0)[0],
			"v2":  OrdersToTVV2(ans, 0)[0],
		} {
			if got.QtyLots != c.wantQtyLots || got.FilledQtyLots != c.wantFillLots {
				t.Errorf("%s/%s: qtyLots=%v filledLots=%v, want %v and %v",
					c.name, name, got.QtyLots, got.FilledQtyLots, c.wantQtyLots, c.wantFillLots)
			}
		}
	}
}

// A filled order must report WHEN it filled. Both mappings published TimeSetup
// as `updateTime`, so the order-history table showed a stop placed at 19:08:50
// and filled fifteen minutes later as completed at 19:08:50 — the placed time
// echoed into the final-state column, on every row.
func TestOrderFinalTimeIsTimeDoneNotTimeSetup(t *testing.T) {
	const setup, done = 1_755_710_930, 1_755_711_790 // placed, then filled
	ans := []OrderHistoryAnswer{{
		Order: "1", Symbol: "EURUSD", Type: 4, State: 4,
		VolumeInitial: 20000, VolumeCurrent: 0,
		TimeSetup: Int(setup), TimeDone: Int(done),
	}}

	for name, got := range map[string]TVOrderHistory{
		"std": OrdersToTVStd(ans, 0)[0],
		"v2":  OrdersToTVV2(ans, 0)[0],
	} {
		if got.UpdateTime != done {
			t.Errorf("%s: updateTime=%d want the fill time %d", name, got.UpdateTime, done)
		}
		if got.TimeDone == nil || *got.TimeDone != done {
			t.Errorf("%s: timeDone=%v want %d", name, got.TimeDone, done)
		}
		if got.TimeSetup == nil || *got.TimeSetup != setup {
			t.Errorf("%s: timeSetup=%v want %d", name, got.TimeSetup, setup)
		}
	}
}

// A working order has not reached a final state, so MT5 leaves TimeDone at 0.
// `timeDone` must stay null there rather than claiming the epoch, and
// `updateTime` — which TradingView renders unconditionally — falls back to the
// setup time, the only true statement available about that row.
func TestWorkingOrderHasNoFinalTime(t *testing.T) {
	const setup = 1_755_710_930
	ans := []OrderHistoryAnswer{{
		Order: "1", Symbol: "EURUSD", Type: 4, State: 1,
		VolumeInitial: 20000, VolumeCurrent: 20000, TimeSetup: Int(setup),
	}}
	got := OrdersToTVStd(ans, 0)[0]
	if got.TimeDone != nil {
		t.Errorf("timeDone=%v want null for a working order", *got.TimeDone)
	}
	if got.UpdateTime != setup {
		t.Errorf("updateTime=%d want the setup time %d", got.UpdateTime, setup)
	}
}

// Broker-stamped times are restated in UTC. TimeDone must be shifted by the
// same offset as TimeSetup, or the fill would be reported hours from the
// placement it followed by minutes.
func TestOrderFinalTimeIsShiftedToUTC(t *testing.T) {
	const setup, done, offset = 1_755_710_930, 1_755_711_790, int64(3 * 3600)
	ans := []OrderHistoryAnswer{{
		Order: "1", Symbol: "EURUSD", Type: 4, State: 4,
		VolumeInitial: 20000, TimeSetup: Int(setup), TimeDone: Int(done),
	}}
	got := OrdersToTVStd(ans, offset)[0]
	if got.TimeDone == nil || *got.TimeDone != done-offset {
		t.Errorf("timeDone=%v want %d", got.TimeDone, done-offset)
	}
	if int64(got.UpdateTime)-*got.TimeSetup != done-setup {
		t.Errorf("fill must stay %ds after placement: %+v", done-setup, got)
	}
}
