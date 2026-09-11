package handlers

import (
	"encoding/json"
	"testing"
)

// The terminal sends `login` as a JSON STRING (its account id is a string);
// other callers send a number. Declaring it int64 made a well-formed request
// fail as "must be valid JSON", which reads like a transport fault.
func TestJSONNumberAcceptsQuotedAndBare(t *testing.T) {
	ok := map[string]int64{
		`"600132510"`: 600132510,
		`600132510`:   600132510,
		`" 200 "`:     200,
		`0`:           0,
		`-1`:          -1,
	}
	for raw, want := range ok {
		got, valid := jsonNumber(json.RawMessage(raw))
		if !valid || got != want {
			t.Errorf("jsonNumber(%s) = %d,%v want %d,true", raw, got, valid, want)
		}
	}
	for _, raw := range []string{``, `""`, `null`, `"abc"`, `1.5`, `{}`} {
		if _, valid := jsonNumber(json.RawMessage(raw)); valid {
			t.Errorf("jsonNumber(%s) accepted a non-integer", raw)
		}
	}
}
