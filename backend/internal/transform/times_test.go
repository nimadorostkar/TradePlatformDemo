package transform

import (
	"encoding/json"
	"strings"
	"testing"
)

// The broker runs UTC+3; every test uses that offset because it is the drift
// the 2026-08-10 production test actually observed (a trade shown 3h apart).
const testOffset = 3 * 3600

func TestShiftEpochsInObjectArray_NumbersAndStrings(t *testing.T) {
	arr := json.RawMessage(`[{"Deal":"9223372036854775807","Time":1754844000,"TimeMsc":"1754844000123","Profit":-0.13}]`)
	out, changed := ShiftEpochsInObjectArray(arr, testOffset, []string{"Time"}, []string{"TimeMsc"})
	if !changed {
		t.Fatal("expected a change")
	}
	var rows []map[string]any
	if err := json.Unmarshal(out, &rows); err != nil {
		t.Fatalf("patched array does not parse: %v", err)
	}
	s := string(out)
	if !strings.Contains(s, `"Time":1754833200`) {
		t.Errorf("Time not shifted to UTC: %s", s)
	}
	// A string-encoded value stays a string after the shift.
	if !strings.Contains(s, `"TimeMsc":"1754833200123"`) {
		t.Errorf("TimeMsc not shifted (or lost its string encoding): %s", s)
	}
	// json.Number must protect a 64-bit ticket from float64 rounding.
	if !strings.Contains(s, `"Deal":"9223372036854775807"`) {
		t.Errorf("64-bit ticket corrupted: %s", s)
	}
	if !strings.Contains(s, `-0.13`) {
		t.Errorf("unrelated field altered: %s", s)
	}
}

func TestShiftEpochsInObjectArray_ZeroMeansUnsetAndStays(t *testing.T) {
	arr := json.RawMessage(`[{"TimeExpiration":0,"TimeSetup":1754844000}]`)
	out, _ := ShiftEpochsInObjectArray(arr, testOffset, []string{"TimeSetup", "TimeExpiration"}, nil)
	s := string(out)
	if !strings.Contains(s, `"TimeExpiration":0`) {
		t.Errorf("zero expiration must not become negative: %s", s)
	}
	if !strings.Contains(s, `"TimeSetup":1754833200`) {
		t.Errorf("TimeSetup not shifted: %s", s)
	}
}

func TestShiftEpochsInObjectArray_ZeroOffsetIsIdentity(t *testing.T) {
	arr := json.RawMessage(`[{"Time":100}]`)
	out, changed := ShiftEpochsInObjectArray(arr, 0, []string{"Time"}, nil)
	if changed || string(out) != string(arr) {
		t.Errorf("zero offset must be byte-identical: %s", out)
	}
}

func TestShiftEpochsInObjectArray_MalformedPassesThrough(t *testing.T) {
	arr := json.RawMessage(`{"not":"an array"}`)
	out, changed := ShiftEpochsInObjectArray(arr, testOffset, []string{"Time"}, nil)
	if changed || string(out) != string(arr) {
		t.Errorf("malformed input must pass through untouched: %s", out)
	}
}

func TestShiftEpochsInAnswerBody(t *testing.T) {
	body := []byte(`{"retcode":"0 Done","answer":[{"Time":1754844000}],"extra":true}`)
	out := ShiftEpochsInAnswerBody(body, testOffset, []string{"Time"}, nil)
	s := string(out)
	if !strings.Contains(s, `"Time":1754833200`) {
		t.Errorf("answer times not shifted: %s", s)
	}
	if !strings.Contains(s, `"retcode":"0 Done"`) || !strings.Contains(s, `"extra":true`) {
		t.Errorf("sibling fields lost: %s", s)
	}
}

func TestShiftEpochParam(t *testing.T) {
	cases := []struct{ in, want string }{
		{"1754833200", "1754844000"}, // UTC seconds → broker seconds
		{" 1754833200 ", "1754844000"},
		{"", ""},                         // empty stays empty
		{"2026-08-10", "2026-08-10"},     // date strings pass through
		{"0", "0"},                       // zero is "unset"
		{"not-a-number", "not-a-number"}, // garbage passes through
	}
	for _, c := range cases {
		if got := ShiftEpochParam(c.in, testOffset); got != c.want {
			t.Errorf("ShiftEpochParam(%q) = %q, want %q", c.in, got, c.want)
		}
	}
	if got := ShiftEpochParam("123", 0); got != "123" {
		t.Errorf("zero offset must not rewrite: %q", got)
	}
}

// The regression that motivated TIME-001: with a UTC+3 broker, a deal executed
// "now" is broker-stamped 3h into the client's future. Restated in UTC it must
// come out at the true instant, and a cursor at that instant must exclude it.
func TestDealsToExecutions_RestatesBrokerTimeUTC(t *testing.T) {
	deals := []DealAnswer{{
		Deal: "1", Order: "2", PositionID: "3", Symbol: "EURUSD",
		Action: 0, Time: Int64(1754844000), TimeMsc: Int64(1754844000123),
	}}
	out := DealsToExecutions(deals, 0, testOffset)
	if len(out) != 1 {
		t.Fatalf("expected 1 execution, got %d", len(out))
	}
	if out[0].TimeSeconds != 1754833200 {
		t.Errorf("TimeSeconds not UTC: %d", out[0].TimeSeconds)
	}
	if out[0].Time != 1754833200123 {
		t.Errorf("Time (ms) not UTC: %d", out[0].Time)
	}
	// Cursor semantics stay strict-after on the UTC clock.
	if got := DealsToExecutions(deals, 1754833200, testOffset); len(got) != 0 {
		t.Errorf("cursor at the deal's UTC second must exclude it")
	}
}
