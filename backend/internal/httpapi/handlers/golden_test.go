package handlers

import (
	"context"
	"flag"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/nimadorostkar/TradePlatformDemo/backend/internal/domain"
)

var update = flag.Bool("update", false, "update golden files")

// goldenMT5 is a deterministic fake upstream returning canned MT5 fixtures keyed
// by request path. It lets the golden harness assert the exact wire output of
// the full handler stack without a live broker.
type goldenMT5 struct{}

func (goldenMT5) Get(_ context.Context, path string) ([]byte, error) {
	return []byte(fixtureFor(path)), nil
}
func (goldenMT5) Post(_ context.Context, path string, _ []byte) ([]byte, error) {
	return []byte(fixtureFor(path)), nil
}

func fixtureFor(path string) string {
	switch {
	case strings.HasPrefix(path, "/api/order/get?ticket="):
		return `{"retcode":"0 Done","answer":{"Order":"123","Login":"1001","Symbol":"EURUSD"}}`
	case strings.HasPrefix(path, "/api/order/get_page"):
		return `{"retcode":"0 Done","answer":[{"Order":"1","Symbol":"EURUSD","Type":2,"State":1,"VolumeInitial":50000,"PriceOrder":1.1,"PriceSL":1.05,"PriceTP":1.2,"VolumeCurrent":30000,"Comment":"hi","TimeSetup":1700,"side":-1,"TypeTime":2,"TimeExpiration":1800000000}]}`
	case strings.HasPrefix(path, "/api/book/get"):
		// MQL5 ENUM_BOOK_TYPE: 1=sell (ask), 2=buy (bid).
		return `{"retcode":"0 Done","answer":{"Symbol":"EURUSD","Items":[{"Type":2,"Price":1.1000,"Volume":100000},{"Type":1,"Price":1.1002,"Volume":250000},{"Type":2,"Price":1.0999,"Volume":50000}]}}`
	case strings.HasPrefix(path, "/api/deal/get_page"):
		return `{"retcode":"0 Done","answer":[` +
			`{"Deal":"9001","Order":"1","Login":42,"Symbol":"EURUSD","Action":0,"Entry":0,"Price":1.1001,"Volume":20000,"Time":1700,"TimeMsc":1700000,"Commission":-0.7,"Storage":0,"Profit":0,"PositionID":"7"},` +
			`{"Deal":"9002","Order":"1","Login":42,"Symbol":"EURUSD","Action":0,"Entry":0,"Price":1.1003,"Volume":30000,"Time":1750,"TimeMsc":1750000,"Commission":-1.05,"Storage":0,"Profit":0,"PositionID":"7"},` +
			`{"Deal":"9003","Login":42,"Symbol":"","Action":2,"Entry":0,"Price":0,"Volume":0,"Time":1760,"Comment":"deposit"}]}`
	case strings.HasPrefix(path, "/api/tick/last?"):
		return `{"retcode":"0 Done","trans_id":"0","answer":[{"Symbol":"EURUSD","Datetime":"1700000000","Bid":1.1,"Ask":1.2,"Last":0,"Volume":5}]}`
	case strings.HasPrefix(path, "/api/user/get?"):
		return `{"retcode":"0 Done","answer":{"ID":"42","Name":"Alice","Login":"42"}}`
	case strings.HasPrefix(path, "/api/symbol/get?symbol="):
		// Realistic MT5 volume scaling: 10000 = 1 lot, so the emitted
		// volume_min_lots is 1 while the parity field volume_precision still
		// carries the raw 10000 (see docs/VOLUME-UNITS.md).
		return `{"retcode":"0 Done","answer":{"Symbol":"EURUSD","Path":"Forex\\Majors\\EURUSD","Description":"Euro vs USD","Sector":"FX","Industry":"Spot","CurrencyBase":"EUR","Multiply":100000,"VolumeMin":10000,"VolumeMax":5000000,"VolumeStep":10000,"VolumeMinExt":0,"SessionsTrades":[[{"Open":0,"Close":1439}]]}}`
	case strings.HasPrefix(path, "/api/position/get?"):
		return `{"retcode":"0 Done","answer":{"Position":7,"Symbol":"EURUSD","Action":0,"Volume":10000,"Profit":12.5,"PriceOpen":1.1,"PriceCurrent":1.12,"PriceSL":1.0,"PriceTP":1.2,"TimeCreate":1700,"Storage":-2.5}}`
	default:
		return `{"retcode":"0 Done","answer":[]}`
	}
}

func goldenAPI() *API {
	c := goldenMT5{}
	return New(Deps{
		Order:    domain.NewOrderService(c),
		Position: domain.NewPositionService(c),
		Deal:     domain.NewDealService(c),
		Tick:     domain.NewTickService(c, nil, false),
		User:     domain.NewUserService(c),
		Symbol:   domain.NewSymbolService(c, ""),
	})
}

// TestGolden asserts the exact response body for representative endpoints across
// the three data-shape classes: raw-string passthrough, source=mt5 object, and
// source=tv transform. Run with -update to regenerate testdata/golden/*.json.
func TestGolden(t *testing.T) {
	a := goldenAPI()
	cases := []struct {
		name    string
		target  string
		handler http.HandlerFunc
	}{
		{"order_get_raw_string", "/api/Order/get?ticket=123", a.OrderGet},
		{"order_get_page_mt5_object", "/api/Order/get_page?login=1&offset=0&total=10&source=mt5", a.OrderGetPage},
		{"order_get_page_tv_array", "/api/Order/get_page?login=1&offset=0&total=10&source=tv", a.OrderGetPage},
		{"tick_last_tv_quote", "/api/Tick/last?symbol=EURUSD&Id=0&source=tv", a.TickLast},
		{"user_get_tv", "/api/User/get?login=42&source=tv", a.UserGet},
		{"symbol_by_name_tv", "/api/Symbol/getsymbolsbyname?symbol=EURUSD&source=tv", a.SymbolGetByName},
		{"position_get_tv", "/api/Position/get?login=1&symbol=EURUSD&source=tv", a.PositionGet},
		{"tick_market_depth", "/api/Tick/get_marketdepth?symbol=EURUSD", a.TickMarketDepth},
		{"deal_since_executions", "/api/Deal/since?login=42&after=1700", a.ExecutionsSince},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodGet, tc.target, nil)
			w := httptest.NewRecorder()
			tc.handler(w, r)
			got := w.Body.Bytes()

			path := filepath.Join("testdata", "golden", tc.name+".json")
			if *update {
				if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(path, got, 0o644); err != nil {
					t.Fatal(err)
				}
				return
			}
			want, err := os.ReadFile(path)
			if err != nil {
				t.Fatalf("read golden (run -update first): %v", err)
			}
			if string(got) != string(want) {
				t.Errorf("golden mismatch for %s\n got: %s\nwant: %s", tc.name, got, want)
			}
		})
	}
}
