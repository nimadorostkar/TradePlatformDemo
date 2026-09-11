package domain

import (
	"testing"

	"github.com/nimadorostkar/TradePlatformDemo/backend/internal/transform"
)

func iptr(v int) *int { return &v }

func TestIntradayStepSeconds(t *testing.T) {
	cases := map[string]int64{
		"":     0,
		"1":    0, // raw M1 passthrough
		"0":    0,
		"-5":   0,
		"1D":   0, // daily tokens never aggregate here
		"D":    0,
		"abc":  0,
		"721":  0, // past the largest advertised intraday resolution
		"2":    120,
		"5":    300,
		"60":   3600,
		"120":  7200,
		"720":  43200,
		" 30 ": 1800,
	}
	for in, want := range cases {
		if got := intradayStepSeconds(in); got != want {
			t.Errorf("intradayStepSeconds(%q) = %d, want %d", in, got, want)
		}
	}
}

func TestAggregateIntradayM1_BrokerAlignment(t *testing.T) {
	// UTC+3 broker, 2h buckets: broker-day boundaries sit at odd UTC hours
	// (21:00, 23:00, 01:00 … UTC), which is where MT5 desktop cuts them.
	const offset = 3 * 3600
	const step = 2 * 3600
	const t2100 = 1786136400 // 2026-08-07T21:00:00Z == broker midnight
	bars := []transform.TVTickResponse{
		{Time: t2100, Open: 1.0, High: 1.2, Low: 0.9, Close: 1.1, Volume: iptr(3)},
		{Time: t2100 + 60, Open: 1.1, High: 1.5, Low: 1.0, Close: 1.4, Volume: iptr(2)},
		{Time: t2100 + 119*60, Open: 1.4, High: 1.45, Low: 0.8, Close: 0.85, Volume: iptr(1)},
		{Time: t2100 + 120*60, Open: 0.85, High: 0.9, Low: 0.84, Close: 0.88, Volume: iptr(5)},
	}
	got := aggregateIntradayM1(bars, step, offset)
	if len(got) != 2 {
		t.Fatalf("want 2 buckets, got %d: %+v", len(got), got)
	}
	first, second := got[0], got[1]
	if first.Time != t2100 || second.Time != t2100+step {
		t.Errorf("bucket starts = %d,%d want %d,%d", first.Time, second.Time, t2100, int64(t2100)+step)
	}
	if first.Open != 1.0 || first.Close != 0.85 || first.High != 1.5 || first.Low != 0.8 {
		t.Errorf("first bucket OHLC wrong: %+v", first)
	}
	if first.Volume == nil || *first.Volume != 6 {
		t.Errorf("first bucket volume = %v want 6", first.Volume)
	}
	if second.Open != 0.85 || second.Volume == nil || *second.Volume != 5 {
		t.Errorf("second bucket wrong: %+v", second)
	}
}

func TestAggregateIntradayM1_UnsortedInputAndNilVolume(t *testing.T) {
	// The DB-backed read returns rows newest-first; aggregation must not
	// depend on input order. All-nil volumes must stay nil, not become 0.
	bars := []transform.TVTickResponse{
		{Time: 300, Open: 3, High: 3, Low: 3, Close: 3},
		{Time: 0, Open: 1, High: 1, Low: 1, Close: 1},
		{Time: 60, Open: 2, High: 2, Low: 2, Close: 2},
	}
	got := aggregateIntradayM1(bars, 300, 0)
	if len(got) != 2 {
		t.Fatalf("want 2 buckets, got %d", len(got))
	}
	if got[0].Time != 0 || got[0].Open != 1 || got[0].Close != 2 {
		t.Errorf("first bucket wrong: %+v", got[0])
	}
	if got[0].Volume != nil {
		t.Errorf("volume should stay nil when no constituent carries one, got %v", *got[0].Volume)
	}
	if got[1].Time != 300 || got[1].Open != 3 {
		t.Errorf("second bucket wrong: %+v", got[1])
	}
}

func TestAggregateIntradayM1_Empty(t *testing.T) {
	if got := aggregateIntradayM1(nil, 300, 0); len(got) != 0 {
		t.Errorf("want empty slice, got %+v", got)
	}
}
