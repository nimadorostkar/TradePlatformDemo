package transform

import (
	"encoding/json"
	"testing"
)

func TestBookToMarketDepth(t *testing.T) {
	// MQL5 ENUM_BOOK_TYPE: 1=sell(ask), 2=buy(bid), 3=sell market, 4=buy market.
	book := BookAnswer{Symbol: "EURUSD", Items: []BookItem{
		{Type: 2, Price: 1.0999, Volume: 50000},
		{Type: 1, Price: 1.1004, Volume: 250000},
		{Type: 2, Price: 1.1000, Volume: 100000},
		{Type: 1, Price: 1.1002, Volume: 120000},
		{Type: 9, Price: 1.5, Volume: 1},
	}}
	d := BookToMarketDepth(book, "ignored", BookConventionMQL5)

	if d.Symbol != "EURUSD" || d.VolumeUnit != "lots" {
		t.Errorf("header wrong: %+v", d)
	}
	// Best bid first (highest), best ask first (lowest).
	if d.Bids[0].Price != 1.1000 || d.Bids[1].Price != 1.0999 {
		t.Errorf("bids not best-first: %+v", d.Bids)
	}
	if d.Asks[0].Price != 1.1002 || d.Asks[1].Price != 1.1004 {
		t.Errorf("asks not best-first: %+v", d.Asks)
	}
	// 100000 / 10000 = 10 lots — the whole point of stating the unit.
	if d.Bids[0].Volume != 10 {
		t.Errorf("bid volume = %v lots, want 10", d.Bids[0].Volume)
	}
	if d.Crossed {
		t.Error("a book with bid < ask must not report crossed")
	}
	if d.Unclassified != 1 {
		t.Errorf("unknown side codes must be counted, got %d", d.Unclassified)
	}
	// A count says the book is partial; the codes say what to map.
	if len(d.UnknownSideCodes) != 1 || d.UnknownSideCodes[0] != 9 {
		t.Errorf("unknown side codes must be reported, got %v", d.UnknownSideCodes)
	}
}

// Applying the wrong side convention flips every level; the crossed flag is
// what makes that visible instead of shipping a plausible-looking wrong ladder.
func TestBookCrossedFlagsWrongConvention(t *testing.T) {
	book := BookAnswer{Items: []BookItem{
		{Type: 2, Price: 1.1000, Volume: 10000},
		{Type: 1, Price: 1.1002, Volume: 10000},
	}}
	if BookToMarketDepth(book, "EURUSD", BookConventionMQL5).Crossed {
		t.Error("correct convention should not be crossed")
	}
	if !BookToMarketDepth(book, "EURUSD", BookConventionManager).Crossed {
		t.Error("wrong convention should be reported as crossed")
	}
}

// MT5 builds differ in how they wrap book entries; an unrecognized wrapper must
// not silently decode as an empty book.
func TestBookAnswerAcceptsBothWrappers(t *testing.T) {
	var object BookRoot
	if err := json.Unmarshal([]byte(`{"answer":{"Symbol":"X","Items":[{"Type":2,"Price":1,"Volume":10000}]}}`), &object); err != nil {
		t.Fatal(err)
	}
	var array BookRoot
	if err := json.Unmarshal([]byte(`{"answer":[{"Type":2,"Price":1,"Volume":10000}]}`), &array); err != nil {
		t.Fatal(err)
	}
	if len(object.Answer.Items) != 1 || len(array.Answer.Items) != 1 {
		t.Errorf("both wrappers must decode: object=%d array=%d",
			len(object.Answer.Items), len(array.Answer.Items))
	}
}

func TestParseBookConvention(t *testing.T) {
	cases := map[string]BookConvention{
		"":         BookConventionMQL5,
		"mql5":     BookConventionMQL5,
		"Manager":  BookConventionManager,
		"nonsense": BookConventionMQL5,
	}
	for in, want := range cases {
		if got := ParseBookConvention(in); got != want {
			t.Errorf("ParseBookConvention(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestEmptyBookSerializesAsArrays(t *testing.T) {
	// A DOM widget must receive [] rather than null for an empty side.
	b, err := json.Marshal(BookToMarketDepth(BookAnswer{}, "EURUSD", BookConventionMQL5))
	if err != nil {
		t.Fatal(err)
	}
	var probe struct {
		Bids []DepthLevel `json:"bids"`
		Asks []DepthLevel `json:"asks"`
	}
	if err := json.Unmarshal(b, &probe); err != nil {
		t.Fatal(err)
	}
	if probe.Bids == nil || probe.Asks == nil {
		t.Errorf("empty sides must marshal as [], got %s", b)
	}
}

// MT5 answers an empty book with a single zero-filled row whose type is 0.
// Counting that as an unrecognised SIDE made the terminal tell traders "1 book
// entry could not be classified as bid or ask and is not shown" over a ladder
// with nothing in it — liquidity being withheld, rather than none existing.
func TestBookToMarketDepth_EmptyBookPlaceholderIsNotLiquidity(t *testing.T) {
	d := BookToMarketDepth(
		BookAnswer{Symbol: "GBPUSD", Items: []BookItem{{Type: 0, Price: 0, Volume: 0}}},
		"GBPUSD", BookConventionMQL5,
	)

	if d.Unclassified != 0 {
		t.Errorf("a zero row is padding, not an unclassified entry: got %d", d.Unclassified)
	}
	if len(d.UnknownSideCodes) != 0 {
		t.Errorf("no side code to report for padding: got %v", d.UnknownSideCodes)
	}
	if len(d.Bids) != 0 || len(d.Asks) != 0 {
		t.Errorf("padding must not become a level: bids=%v asks=%v", d.Bids, d.Asks)
	}
}

// A row that carries real volume but an unrecognised type IS worth reporting:
// it means liquidity exists that this gateway cannot place on a side.
func TestBookToMarketDepth_RealEntryWithUnknownSideIsStillReported(t *testing.T) {
	d := BookToMarketDepth(
		BookAnswer{Symbol: "GBPUSD", Items: []BookItem{{Type: 99, Price: 1.3, Volume: 10000}}},
		"GBPUSD", BookConventionMQL5,
	)

	if d.Unclassified != 1 {
		t.Errorf("a priced entry with an unknown side must be reported: got %d", d.Unclassified)
	}
	if len(d.UnknownSideCodes) != 1 || d.UnknownSideCodes[0] != 99 {
		t.Errorf("the code must be named so it can be diagnosed: %v", d.UnknownSideCodes)
	}
}
