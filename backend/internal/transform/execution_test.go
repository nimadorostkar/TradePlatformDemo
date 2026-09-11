package transform

import "testing"

func TestDealsToExecutions(t *testing.T) {
	deals := []DealAnswer{
		{Deal: "1", Order: "10", Symbol: "EURUSD", Action: DealActionBuy, Price: 1.1, Volume: 20000, Time: 1700, TimeMsc: 1700123, Commission: -0.7},
		{Deal: "2", Order: "10", Symbol: "EURUSD", Action: DealActionSell, Price: 1.2, Volume: 30000, Time: 1750},
		// Balance operations carry no price and must never become chart markers.
		{Deal: "3", Symbol: "", Action: 2, Time: 1760},
		// Already delivered at this cursor.
		{Deal: "0", Symbol: "EURUSD", Action: DealActionBuy, Time: 1600},
	}
	out := DealsToExecutions(deals, 1650, 0)
	if len(out) != 2 {
		t.Fatalf("got %d executions, want 2: %+v", len(out), out)
	}
	if out[0].Side != 1 || out[1].Side != -1 {
		t.Errorf("sides wrong: %d %d", out[0].Side, out[1].Side)
	}
	if out[0].Qty != 2 || out[0].QtyMT5 != 20000 {
		t.Errorf("volume units wrong: %+v", out[0])
	}
	if out[0].Time != 1700123 {
		t.Errorf("TimeMsc should win when present: %d", out[0].Time)
	}
	// No TimeMsc → derive milliseconds from seconds rather than emitting 0.
	if out[1].Time != 1750*1000 || out[1].TimeSeconds != 1750 {
		t.Errorf("derived time wrong: %+v", out[1])
	}
}

// Polling with the newest timestamp seen must not re-deliver that same fill.
func TestExecutionsCursorIsExclusive(t *testing.T) {
	deals := []DealAnswer{{Deal: "1", Symbol: "X", Action: DealActionBuy, Time: 1700}}
	if got := DealsToExecutions(deals, 1700, 0); len(got) != 0 {
		t.Errorf("cursor must exclude its own second, got %+v", got)
	}
	if got := DealsToExecutions(deals, 1699, 0); len(got) != 1 {
		t.Errorf("a fill after the cursor must be delivered, got %+v", got)
	}
}
