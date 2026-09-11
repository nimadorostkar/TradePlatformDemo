package domain

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func TestLeverageDisabledUntilTheBrokerStatesTheChoices(t *testing.T) {
	// Leverage is a broker policy. Until a deployment lists what a trader may
	// pick, the terminal must not offer a control that rewrites a real
	// account's margin terms — so an unset, blank or unparseable list is OFF,
	// never a guessed range.
	for _, choices := range []string{"", "   ", ",,,", "abc", "0", "-100"} {
		svc := NewLeverageService(nil, choices)
		if svc.Enabled() {
			t.Errorf("choices %q enabled the feature", choices)
		}
		if got := svc.Get(context.Background(), 1); got.Success {
			t.Errorf("choices %q: Get succeeded while disabled", choices)
		}
		if got := svc.Set(context.Background(), 1, 100); got.Success {
			t.Errorf("choices %q: Set succeeded while disabled", choices)
		}
	}
}

func TestLeverageChoicesAreParsedSortedAndDeduplicated(t *testing.T) {
	svc := NewLeverageService(nil, " 200, 25,100 ,25, 500 ")
	want := []int{25, 100, 200, 500}
	got := svc.Choices()
	if len(got) != len(want) {
		t.Fatalf("choices = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("choices = %v, want %v", got, want)
		}
	}
	if !svc.Enabled() {
		t.Error("a valid list must enable the feature")
	}
}

func TestLeverageRefusesAValueTheBrokerDidNotOffer(t *testing.T) {
	// MT5 accepts whatever it is sent, so an unlisted value would be a silent,
	// broker-unsanctioned change to a live account. It must never reach the
	// upstream — note the nil client: a request that got that far would panic.
	svc := NewLeverageService(nil, "100,200")
	for _, bad := range []int{1, 50, 300, 1000, 0, -100} {
		got := svc.Set(context.Background(), 600132510, bad)
		if got.Success {
			t.Errorf("leverage %d was accepted", bad)
		}
		if got.ErrorMessage == nil || !strings.Contains(*got.ErrorMessage, "not offered") {
			t.Errorf("leverage %d: unhelpful refusal %+v", bad, got.ErrorMessage)
		}
	}
}

func TestLeverageReadsWhicheverSpellingTheRecordUses(t *testing.T) {
	// `/api/user/get` answers with `Leverage`; `/api/user/account/get` answers
	// with `MarginLeverage`. Reading only the account summary's spelling made
	// every request against the USER record fail — and, under the gateway's
	// success/failure convention, fail as an HTTP 400 that read like a
	// malformed request rather than a field this code looked for in the wrong
	// place. Writing the wrong name is worse: MT5 ignores the unknown field, so
	// the change reports success and does nothing.
	cases := map[string]struct {
		record map[string]json.RawMessage
		want   string
	}{
		"user record":    {map[string]json.RawMessage{"Login": json.RawMessage(`1`), "Leverage": json.RawMessage(`"100"`)}, "Leverage"},
		"account record": {map[string]json.RawMessage{"MarginLeverage": json.RawMessage(`"100"`)}, "MarginLeverage"},
		"both present":   {map[string]json.RawMessage{"Leverage": json.RawMessage(`"100"`), "MarginLeverage": json.RawMessage(`"200"`)}, "Leverage"},
		"neither":        {map[string]json.RawMessage{"Login": json.RawMessage(`1`)}, "Leverage"},
	}
	for name, c := range cases {
		if got := leverageFieldName(c.record); got != c.want {
			t.Errorf("%s: field = %q, want %q", name, got, c.want)
		}
	}
}
