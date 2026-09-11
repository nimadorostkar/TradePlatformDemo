package transform

import "testing"

// The scale confusion these tests pin down caused a production outage: reading
// a 1/10000-lot field as lots made the order ticket demand a 100-lot minimum
// and blocked all trading.
func TestLotConversions(t *testing.T) {
	cases := []struct {
		name string
		got  float64
		want float64
	}{
		{"one lot", Lots(10000), 1},
		{"hundredth lot", Lots(100), 0.01},
		{"minimum micro lot", Lots(1), 0.0001},
		{"one lot extended", LotsExt(100000000), 1},
		{"hundredth lot extended", LotsExt(1000000), 0.01},
		{"prefers extended when set", LotsPreferExt(10000, 5000000), 0.05},
		{"falls back to standard", LotsPreferExt(10000, 0), 1},
	}
	for _, tc := range cases {
		if tc.got != tc.want {
			t.Errorf("%s = %v, want %v", tc.name, tc.got, tc.want)
		}
	}
}

// Round-tripping must be exact for every volume a trader can actually enter;
// float dust here would reach MT5 as a rejected order.
func TestMT5VolumeRoundTrip(t *testing.T) {
	for _, lots := range []float64{0.01, 0.02, 0.03, 0.07, 0.1, 0.33, 1, 1.5, 12.34, 100} {
		mt5 := MT5Volume(lots)
		if back := Lots(float64(mt5)); back != lots {
			t.Errorf("%v lots → %d → %v lots", lots, mt5, back)
		}
	}
}

func TestMT5VolumeRoundsRatherThanTruncates(t *testing.T) {
	// 0.03 is 299.999… in binary float when multiplied out; truncating would
	// shrink the order to 0.0299 lots.
	if got := MT5Volume(0.03); got != 300 {
		t.Errorf("MT5Volume(0.03) = %d, want 300", got)
	}
}
