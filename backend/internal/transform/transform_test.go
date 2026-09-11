package transform

import "testing"

func TestPathToType(t *testing.T) {
	cases := map[string]string{
		`Forex\Majors\EURUSD`: "Majors",
		`Forex`:               "",
		``:                    "",
		`NoBackslash`:         "",
	}
	for in, want := range cases {
		if got := PathToType(in); got != want {
			t.Errorf("PathToType(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestConvertSessionsMt5ToTv(t *testing.T) {
	// Day 0 with one session 00:00–23:59, day 1 empty (skipped), day 2 two sessions.
	in := [][]Session{
		{{Open: 0, Close: 1439}},
		{},
		{{Open: 60, Close: 120}, {Open: 600, Close: 660}},
	}
	want := "0000-2359:1|0100-0200,1000-1100:3"
	if got := ConvertSessionsMt5ToTv(in); got != want {
		t.Errorf("ConvertSessionsMt5ToTv = %q, want %q", got, want)
	}
}

func TestMappings(t *testing.T) {
	if MT5ToTVType(4) != 3 {
		t.Errorf("MT5ToTVType(4) = %d, want 3", MT5ToTVType(4))
	}
	if MT5ToTVStatus(4) != 2 { // FILLED → Filled
		t.Errorf("MT5ToTVStatus(4) = %d, want 2", MT5ToTVStatus(4))
	}
	if GetStatusType("99999") != 5 { // default
		t.Errorf("GetStatusType default = %d, want 5", GetStatusType("99999"))
	}
	if SideFromType(3) != -1 {
		t.Errorf("SideFromType(3) = %d, want -1", SideFromType(3))
	}
}

func TestQuotesToTV_LastPriceFallback(t *testing.T) {
	q := QuotesToTV([]TicklastAnswer{{Symbol: "EURUSD", Bid: 1.1, Ask: 1.2, Last: 0, Volume: 5}}, 0)
	if len(q) != 1 || q[0].LastPrice != 1.1 { // Last<=0 → falls back to Bid
		t.Fatalf("lastprice fallback failed: %+v", q)
	}
	q2 := QuotesToTV([]TicklastAnswer{{Bid: 1.1, Last: 1.15}}, 0)
	if q2[0].LastPrice != 1.15 {
		t.Errorf("lastprice = %v, want 1.15", q2[0].LastPrice)
	}
}
