package transform

import (
	"encoding/json"
	"testing"
)

// Real MT5 returns numbers as strings; the lenient types must parse them so the
// TV transforms still produce numeric output (regression for the live-broker bug).
func TestLenientNumbers_StringEncoded(t *testing.T) {
	body := `{"retcode":"0 Done","answer":[{"Symbol":"EURUSD","Datetime":"1700","Bid":"1.0854","Ask":"1.0856","Last":"0","Volume":"12"}]}`
	var root TicklastRoot
	if err := json.Unmarshal([]byte(body), &root); err != nil {
		t.Fatal(err)
	}
	q := QuotesToTV(root.Answer, 0)
	if len(q) != 1 || q[0].Bid != 1.0854 || q[0].Ask != 1.0856 || q[0].LastPrice != 1.0854 || q[0].Volume != 12 {
		t.Fatalf("string-encoded numbers not parsed: %+v", q)
	}
}

func TestLenientNumbers_BothForms(t *testing.T) {
	var a struct {
		X Float `json:"x"`
		Y Int   `json:"y"`
	}
	_ = json.Unmarshal([]byte(`{"x":"3.5","y":"7"}`), &a)
	if a.X != 3.5 || a.Y != 7 {
		t.Errorf("string form: %+v", a)
	}
	_ = json.Unmarshal([]byte(`{"x":3.5,"y":7}`), &a)
	if a.X != 3.5 || a.Y != 7 {
		t.Errorf("number form: %+v", a)
	}
}
