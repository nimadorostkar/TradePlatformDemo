package transform

import (
	"encoding/json"
	"slices"
	"sort"
	"strings"
)

// Market depth (DOM). `/api/book/get` was previously forwarded to the client
// raw, with neither a documented shape nor a stated volume unit — so the
// terminal gated the DOM off rather than risk misstating available liquidity.
// This file pins the contract down: one normalized ladder, volumes in lots,
// sides derived from an explicit book-side convention, and a crossed-book flag
// that makes a wrong convention visible instead of silently wrong.

// BookRoot is the `/api/book/get` envelope.
type BookRoot struct {
	Retcode string     `json:"retcode"`
	Answer  BookAnswer `json:"answer"`
}

// BookAnswer is the book payload. MT5 builds differ in how they wrap the
// entries — some return {"Symbol":…,"Items":[…]}, others the bare array — so the
// decoder accepts both rather than silently yielding an empty book.
type BookAnswer struct {
	Symbol string     `json:"Symbol"`
	Items  []BookItem `json:"Items"`
}

// UnmarshalJSON accepts either the object form or a bare array of entries.
func (b *BookAnswer) UnmarshalJSON(data []byte) error {
	if len(data) > 0 && data[0] == '[' {
		return json.Unmarshal(data, &b.Items)
	}
	type alias BookAnswer // avoid recursing into this method
	var a alias
	if err := json.Unmarshal(data, &a); err != nil {
		return err
	}
	*b = BookAnswer(a)
	return nil
}

// BookItem is one ladder entry. Volume is in 1/10000 lot, VolumeExt (when the
// broker populates it) in 1/100000000 lot.
type BookItem struct {
	Type      Int   `json:"Type"`
	Price     Float `json:"Price"`
	Volume    Float `json:"Volume"`
	VolumeExt Float `json:"VolumeExt"`
}

// bookSide is the classified side of one entry.
type bookSide int

const (
	sideUnknown bookSide = iota
	sideBid
	sideAsk
	sideBidMarket
	sideAskMarket
)

// BookConvention names the numbering of the upstream book-side codes. MT5
// exposes two different numberings depending on the build, and picking the
// wrong one flips every bid and ask — so it is configuration, not a guess
// baked into the mapping.
//
//	"mql5"    — MQL5 ENUM_BOOK_TYPE:      SELL=1, BUY=2, SELL_MARKET=3, BUY_MARKET=4
//	"manager" — Manager API EnBookSide:   SELL=0, BUY=1, SELL_MARKET=2, BUY_MARKET=3
//
// Default is "mql5". A misconfiguration shows up immediately as Crossed=true on
// any book with both sides quoted.
type BookConvention string

// Book side conventions.
const (
	BookConventionMQL5    BookConvention = "mql5"
	BookConventionManager BookConvention = "manager"
)

// ParseBookConvention resolves a configured convention name, falling back to
// mql5 for empty or unrecognized values.
func ParseBookConvention(s string) BookConvention {
	if strings.EqualFold(strings.TrimSpace(s), string(BookConventionManager)) {
		return BookConventionManager
	}
	return BookConventionMQL5
}

// classify maps an upstream type code to a side under the given convention.
func (c BookConvention) classify(code int) bookSide {
	base := 1
	if c == BookConventionManager {
		base = 0
	}
	switch code {
	case base:
		return sideAsk
	case base + 1:
		return sideBid
	case base + 2:
		return sideAskMarket
	case base + 3:
		return sideBidMarket
	default:
		return sideUnknown
	}
}

// DepthLevel is one price level of the normalized ladder. Volume is in LOTS.
type DepthLevel struct {
	Price  float64 `json:"price"`
	Volume float64 `json:"volume"`
	// Market is true for the market-order side of the book, which carries
	// liquidity but no meaningful limit price.
	Market bool `json:"market"`
}

// MarketDepth is the normalized DOM the client consumes:
//
//	{"symbol":"EURUSD","volumeUnit":"lots",
//	 "bids":[{"price":1.1000,"volume":10,"market":false}],
//	 "asks":[{"price":1.1002,"volume":25,"market":false}],
//	 "crossed":false,"unclassified":0}
//
// bids are ordered best (highest) first, asks best (lowest) first.
type MarketDepth struct {
	Symbol string `json:"symbol"`
	// VolumeUnit is always "lots" — stated on the wire so no consumer has to
	// infer the scale (see docs/VOLUME-UNITS.md).
	VolumeUnit string       `json:"volumeUnit"`
	Bids       []DepthLevel `json:"bids"`
	Asks       []DepthLevel `json:"asks"`
	// Crossed reports best bid >= best ask, which a healthy book never is. It
	// is surfaced rather than repaired: a crossed ladder means the configured
	// side convention does not match this broker, and a client showing
	// liquidity it cannot trade is worse than a client showing none.
	Crossed bool `json:"crossed"`
	// Unclassified counts entries whose type code fell outside the convention.
	// They are excluded from both sides; a non-zero count means a partial book.
	Unclassified int `json:"unclassified"`
	// UnknownSideCodes lists the distinct type codes that were not classified,
	// ascending. A bare count says the book is incomplete but not why; the
	// codes say exactly which value to account for, which is the difference
	// between a diagnosable gap and a standing mystery.
	UnknownSideCodes []int `json:"unknownSideCodes,omitempty"`
	// Subscribed reports whether this connection actually holds a book
	// subscription for the symbol. Depth is delivered to SUBSCRIBERS only, so
	// without one the ladder is empty for a reason that has nothing to do with
	// the instrument's liquidity.
	//
	// It is on the wire because the two cases are indistinguishable otherwise,
	// and a client that cannot tell them apart tells the trader the wrong one:
	// "this instrument publishes no depth" is a statement about the market,
	// while "we could not subscribe" is a statement about this gateway's link
	// to the trading server. Observed live 2026-08-21 — every symbol's
	// subscribe answered 504 and every ladder came back empty and successful.
	Subscribed bool `json:"subscribed"`
	// SubscribeError is why the subscription is absent, in one short phrase,
	// when the gateway knows. Never contains a secret: an upstream status and
	// the endpoint that produced it.
	SubscribeError string `json:"subscribeError,omitempty"`
}

// BookToMarketDepth normalizes an MT5 book into the documented ladder, with
// every volume converted to lots exactly once.
func BookToMarketDepth(a BookAnswer, symbol string, conv BookConvention) MarketDepth {
	if a.Symbol != "" {
		symbol = a.Symbol
	}
	d := MarketDepth{
		Symbol:     symbol,
		VolumeUnit: "lots",
		Bids:       []DepthLevel{},
		Asks:       []DepthLevel{},
	}
	for _, it := range a.Items {
		lvl := DepthLevel{
			Price:  float64(it.Price),
			Volume: LotsPreferExt(float64(it.Volume), float64(it.VolumeExt)),
		}
		// An entry with no price AND no volume is not liquidity — it is the
		// zero-filled row MT5 returns for an empty book. Counting it as
		// unclassified made the terminal report "1 book entry could not be
		// classified as bid or ask and is not shown" over a ladder that had
		// nothing in it, which reads as liquidity being withheld. Unclassified
		// must mean "something was here and its side was unrecognisable".
		if lvl.Price <= 0 && lvl.Volume <= 0 {
			continue
		}
		switch conv.classify(int(it.Type)) {
		case sideBid:
			d.Bids = append(d.Bids, lvl)
		case sideBidMarket:
			lvl.Market = true
			d.Bids = append(d.Bids, lvl)
		case sideAsk:
			d.Asks = append(d.Asks, lvl)
		case sideAskMarket:
			lvl.Market = true
			d.Asks = append(d.Asks, lvl)
		default:
			d.Unclassified++
			code := int(it.Type)
			if !slices.Contains(d.UnknownSideCodes, code) {
				d.UnknownSideCodes = append(d.UnknownSideCodes, code)
			}
		}
	}
	slices.Sort(d.UnknownSideCodes)
	sort.SliceStable(d.Bids, func(i, j int) bool { return d.Bids[i].Price > d.Bids[j].Price })
	sort.SliceStable(d.Asks, func(i, j int) bool { return d.Asks[i].Price < d.Asks[j].Price })
	bestBid, bestAsk := bestPrice(d.Bids), bestPrice(d.Asks)
	d.Crossed = bestBid > 0 && bestAsk > 0 && bestBid >= bestAsk
	return d
}

// bestPrice returns the best priced level on a side, or 0 when the side has
// none. Market entries are included: MT5 leaves them priced at 0 when they
// carry no limit, and when they do carry one it is still a real price that a
// crossed-book check must see — excluding them would let a flipped side
// convention slip through looking healthy.
func bestPrice(levels []DepthLevel) float64 {
	for _, l := range levels {
		if l.Price > 0 {
			return l.Price
		}
	}
	return 0
}
