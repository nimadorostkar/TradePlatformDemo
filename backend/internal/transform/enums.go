// Package transform reproduces the .NET service's MT5→TradingView ("TV") data
// transformations exactly (see docs/ANALYSIS.md §7.6 and the per-method port
// specs). These are pure functions over upstream DTOs; the integer enum values
// and mapping tables are load-bearing and must match the .NET output bit-for-bit.
package transform

import "strings"

// MT5ToTVType maps an MT5 order type to a TradingView order-type int.
// {0,1→2 Market; 2,3→1 Limit; 4,5→3 Stop; 6,7→4 StopLimit}, default 0.
// (MappingHelper.mT5ToTVTypeMapping / mT5ToTVConversion.mT5ToTVType — identical.)
func MT5ToTVType(mt5Type int) int {
	switch mt5Type {
	case 0, 1:
		return 2
	case 2, 3:
		return 1
	case 4, 5:
		return 3
	case 6, 7:
		return 4
	default:
		return 0
	}
}

// MT5ToTVStatus maps an MT5 order state to a TradingView status int
// (OrderStateTradingView). MappingHelper.mT5TVStatusMapping.
// STARTED(0)→Placing(4), PLACED(1)→Working(6), CANCELED(2)→Canceled(1),
// PARTIAL(3)→Working(6), FILLED(4)→Filled(2), REJECTED(5)→Rejected(5),
// EXPIRED(6)→Canceled(1); default 0.
func MT5ToTVStatus(state int) int {
	switch state {
	case 0:
		return 4
	case 1:
		return 6
	case 2:
		return 1
	case 3:
		return 6
	case 4:
		return 2
	case 5:
		return 5
	case 6:
		return 1
	default:
		return 0
	}
}

// GetOrderType maps an MT5 order-type string to a TV order-type int, default 0.
// (TradeService.GetOrderType.)
func GetOrderType(t string) int {
	switch t {
	case "0", "1":
		return 2
	case "2", "3":
		return 1
	case "4", "5":
		return 3
	case "6", "7":
		return 4
	default:
		return 0
	}
}

// GetSideType maps an MT5 order-type string to a TV side int (Buy=1/Sell=-1),
// default 0. (TradeService.GetsideType.)
func GetSideType(t string) int {
	switch t {
	case "0", "2", "4", "6":
		return 1
	case "1", "3", "5", "7":
		return -1
	default:
		return 0
	}
}

// GetStatusType maps an MT5 trade retcode string to a TV status int, default 5.
// (TradeService.GetStatusType.)
//
// The retcode is parsed rather than matched literally: MT5 sends the code with
// its text appended ("10009 Done"), so an exact match on "10009" misses every
// real trade and the default (5 = Rejected) contradicts `outcome` on a filled
// order.
func GetStatusType(retcode string) int {
	code, ok := ParseRetcode(retcode)
	if !ok {
		return 5
	}
	switch code {
	case 10001, 10002, 10003:
		return 4
	case RetcodeReject:
		return 5
	case RetcodeCancel:
		return 1
	case RetcodePlaced, RetcodeDonePartial:
		return 6
	case RetcodeDone:
		return 2
	default:
		return 5
	}
}

// MT5 ORDER_TIME_* (TypeTime) values — how long a pending order lives.
const (
	OrderTimeGTC          = 0 // good till cancelled
	OrderTimeDay          = 1 // good till the end of the current trade day
	OrderTimeSpecified    = 2 // good till TimeExpiration
	OrderTimeSpecifiedDay = 3 // good till the end of TimeExpiration's day
)

// TradingView duration type names.
const (
	DurationGTC = "GTC"
	DurationDay = "DAY"
	DurationGTD = "GTD"
)

// DurationFromMT5 builds the TV `duration` block from an MT5 TypeTime and
// TimeExpiration (unix seconds, 0 = none). Without it the order ticket can only
// offer GTC, because nothing in the TV order shape carried an expiry.
func DurationFromMT5(typeTime int, expiration int64) *OrderDuration {
	d := &OrderDuration{}
	switch typeTime {
	case OrderTimeGTC:
		d.Type = ptr(DurationGTC)
	case OrderTimeDay:
		d.Type = ptr(DurationDay)
	case OrderTimeSpecified, OrderTimeSpecifiedDay:
		d.Type = ptr(DurationGTD)
	default:
		return nil
	}
	if expiration > 0 {
		d.Datetime = ptr(float64(expiration))
	}
	return d
}

// MT5TypeTimeFromDuration is the inverse used on trade submission: it maps a
// client duration name (case-insensitive) plus an expiry to the MT5 TypeTime /
// TimeExpiration pair. An unrecognized name falls back to GTC, and a GTD
// without a deadline is downgraded to GTC rather than sent as an expiry of
// 1970 — MT5 rejects that with INVALID_EXPIRATION.
func MT5TypeTimeFromDuration(durationType string, expiration int64) (typeTime int, expiry int64) {
	switch strings.ToUpper(strings.TrimSpace(durationType)) {
	case DurationDay:
		return OrderTimeDay, 0
	case DurationGTD, "SPECIFIED":
		if expiration > 0 {
			return OrderTimeSpecified, expiration
		}
		return OrderTimeGTC, 0
	default:
		return OrderTimeGTC, 0
	}
}

// SideFromType reproduces `Type % 2 == 0 ? 1 : -1` (even=Buy=1, odd=Sell=-1).
func SideFromType(mt5Type int) int {
	if mt5Type%2 == 0 {
		return 1
	}
	return -1
}
