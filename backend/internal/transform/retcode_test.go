package transform

import "testing"

func TestParseRetcode(t *testing.T) {
	cases := []struct {
		raw  string
		code int
		ok   bool
	}{
		{"10009 Done", 10009, true},
		{"10009", 10009, true},
		{"  10006 Reject ", 10006, true},
		{"", 0, false},
		{"Done", 0, false},
	}
	for _, tc := range cases {
		code, ok := ParseRetcode(tc.raw)
		if code != tc.code || ok != tc.ok {
			t.Errorf("ParseRetcode(%q) = (%d,%v), want (%d,%v)", tc.raw, code, ok, tc.code, tc.ok)
		}
	}
}

// The distinction this test guards is the whole point of the tri-state: an
// unreadable verdict must never be reported as a rejection, because the order
// may well be live and the trader would resubmit it.
func TestOutcomeFromRetcode(t *testing.T) {
	accepted := []string{"10008 Placed", "10009 Done", "10010 Done partially"}
	for _, raw := range accepted {
		if got := OutcomeFromRetcode(raw); got != OutcomeAccepted {
			t.Errorf("OutcomeFromRetcode(%q) = %q, want accepted", raw, got)
		}
	}
	rejected := []string{"10006 Reject", "10019 No money", "10014 Invalid volume", "10004 Requote"}
	for _, raw := range rejected {
		if got := OutcomeFromRetcode(raw); got != OutcomeRejected {
			t.Errorf("OutcomeFromRetcode(%q) = %q, want rejected", raw, got)
		}
	}
	unknown := []string{"", "garbage", "10012 Timeout"}
	for _, raw := range unknown {
		if got := OutcomeFromRetcode(raw); got != OutcomeUnknown {
			t.Errorf("OutcomeFromRetcode(%q) = %q, want unknown", raw, got)
		}
	}
}

// MT5 sends the retcode with its text appended. GetStatusType used to match the
// bare code literally, so every real trade fell through to the default (5 =
// Rejected) — a filled order arrived at the terminal as a rejection.
func TestGetStatusTypeParsesRetcodeText(t *testing.T) {
	cases := map[string]int{
		"10009 Done":            2, // Filled
		"10008 Placed":          6, // Working
		"10010 Done partially":  6,
		"10006 Reject":          5,
		"10007 Cancel":          1,
		"10001 Placing":         4,
		"  10009 Done ":         2,
		"10009":                 2, // the bare form still works
		"10019 No money":        5, // rejection
		"99999 Something newer": 5, // unrecognized code → default
		"":                      5,
		"Done":                  5, // unparseable → default
	}
	for raw, want := range cases {
		if got := GetStatusType(raw); got != want {
			t.Errorf("GetStatusType(%q) = %d, want %d", raw, got, want)
		}
	}
}

// status and outcome are derived from the same retcode and must never disagree:
// a client that reads status:5 next to outcome:"accepted" cannot tell what
// happened to the order.
func TestPlacedOrderStatusAgreesWithOutcome(t *testing.T) {
	cases := []struct {
		retcode     string
		wantStatus  int
		wantOutcome TradeOutcome
	}{
		{"10009 Done", 2, OutcomeAccepted},
		{"10008 Placed", 6, OutcomeAccepted},
		{"10010 Done partially", 6, OutcomeAccepted},
		{"10006 Reject", 5, OutcomeRejected},
		{"10019 No money", 5, OutcomeRejected},
	}
	for _, tc := range cases {
		po := PlacedOrderFromAnswer(PlaceOrderAnswer{Order: "7", ResultRetcode: tc.retcode}, 0)
		if po.Status != tc.wantStatus || po.Outcome != tc.wantOutcome {
			t.Errorf("retcode %q → status %d / outcome %q, want %d / %q",
				tc.retcode, po.Status, po.Outcome, tc.wantStatus, tc.wantOutcome)
		}
	}
}

func TestRetcodeDescription(t *testing.T) {
	if got := RetcodeDescription("10019 No money"); got != "Insufficient funds" {
		t.Errorf("description = %q", got)
	}
	if got := RetcodeDescription("99999"); got == "" {
		t.Error("an unrecognized numeric retcode should still describe itself")
	}
	if got := RetcodeDescription(""); got != "" {
		t.Errorf("an absent retcode has no description, got %q", got)
	}
}

// Every trade response must state MT5's own verdict; nothing downstream should
// have to infer acceptance from the presence of an order id.
func TestPlacedOrderCarriesVerdict(t *testing.T) {
	po := PlacedOrderFromAnswer(PlaceOrderAnswer{
		Order: "7", Symbol: "EURUSD", Type: "0", Volume: 20000,
		ResultRetcode: "10009 Done", ResultVolume: 20000,
	}, 0)
	if po.ResultRetcode != "10009 Done" || po.Outcome != OutcomeAccepted {
		t.Errorf("verdict missing: %+v", po)
	}
	if po.QtyLots != 2 || po.FilledQtyLots == nil || *po.FilledQtyLots != 2 {
		t.Errorf("lot volumes wrong: qty=%v filled=%v", po.QtyLots, po.FilledQtyLots)
	}

	rejected := PlacedOrderFromAnswer(PlaceOrderAnswer{ResultRetcode: "10019 No money"}, 0)
	if rejected.Outcome != OutcomeRejected || rejected.RetcodeDescription == "" {
		t.Errorf("rejection not explicit: %+v", rejected)
	}
	// An MT5 answer with no retcode at all is unknown, not accepted.
	if got := PlacedOrderFromAnswer(PlaceOrderAnswer{Order: "9"}, 0).Outcome; got != OutcomeUnknown {
		t.Errorf("missing retcode → %q, want unknown", got)
	}
}
