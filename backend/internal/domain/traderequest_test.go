package domain

import (
	"encoding/json"
	"testing"

	"github.com/nimadorostkar/TradePlatformDemo/backend/internal/transform"
)

func decodeRequest(t *testing.T, body []byte) map[string]any {
	t.Helper()
	var out map[string]any
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatalf("normalized body is not JSON: %v (%s)", err, body)
	}
	return out
}

func TestNormalizeTradeRequestMapsClientDurationFields(t *testing.T) {
	cases := []struct {
		name         string
		in           string
		wantTypeTime float64
		wantExpiry   float64
	}{
		{
			name:         "lowercase typetime and expiration",
			in:           `{"Symbol":"EURUSD","typetime":2,"expiration":1800000000}`,
			wantTypeTime: transform.OrderTimeSpecified,
			wantExpiry:   1800000000,
		},
		{
			name:         "expiration alone implies good-till-specified",
			in:           `{"Symbol":"EURUSD","expiration":1800000000}`,
			wantTypeTime: transform.OrderTimeSpecified,
			wantExpiry:   1800000000,
		},
		{
			name:         "TradingView duration block",
			in:           `{"Symbol":"EURUSD","duration":{"type":"GTD","datetime":1800000000}}`,
			wantTypeTime: transform.OrderTimeSpecified,
			wantExpiry:   1800000000,
		},
		{
			name:         "DAY duration",
			in:           `{"Symbol":"EURUSD","duration":{"type":"DAY"}}`,
			wantTypeTime: transform.OrderTimeDay,
			wantExpiry:   0,
		},
		{
			name:         "numeric strings are accepted",
			in:           `{"Symbol":"EURUSD","typetime":"2","expiration":"1800000000"}`,
			wantTypeTime: transform.OrderTimeSpecified,
			wantExpiry:   1800000000,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := decodeRequest(t, normalizeTradeRequest([]byte(tc.in)))
			if got["TypeTime"] != tc.wantTypeTime {
				t.Errorf("TypeTime = %v, want %v", got["TypeTime"], tc.wantTypeTime)
			}
			if got["TimeExpiration"] != tc.wantExpiry {
				t.Errorf("TimeExpiration = %v, want %v", got["TimeExpiration"], tc.wantExpiry)
			}
			for _, stale := range []string{"typetime", "expiration", "duration"} {
				if _, present := got[stale]; present {
					t.Errorf("client field %q must not be forwarded to MT5", stale)
				}
			}
			if got["Symbol"] != "EURUSD" {
				t.Error("unrelated fields must survive normalization")
			}
		})
	}
}

// MT5 answers an expiry of 1970 with INVALID_EXPIRATION, which reads to a
// trader as an unexplained rejection of a perfectly valid order.
func TestNormalizeTradeRequestDowngradesGTDWithoutDeadline(t *testing.T) {
	got := decodeRequest(t, normalizeTradeRequest([]byte(`{"Symbol":"EURUSD","typetime":2}`)))
	if got["TypeTime"] != float64(transform.OrderTimeGTC) {
		t.Errorf("TypeTime = %v, want GTC", got["TypeTime"])
	}
	if got["TimeExpiration"] != float64(0) {
		t.Errorf("TimeExpiration = %v, want 0", got["TimeExpiration"])
	}
}

// A GTC order must not carry a stale deadline from an earlier ticket state.
func TestNormalizeTradeRequestClearsExpiryForNonGTD(t *testing.T) {
	got := decodeRequest(t, normalizeTradeRequest([]byte(`{"typetime":0,"expiration":1800000000}`)))
	if got["TimeExpiration"] != float64(0) {
		t.Errorf("GTC must clear the deadline, got %v", got["TimeExpiration"])
	}
}

func TestNormalizeTradeRequestStripsGatewayOnlyFields(t *testing.T) {
	got := decodeRequest(t, normalizeTradeRequest([]byte(`{"Symbol":"EURUSD","clientRequestId":"abc"}`)))
	if _, present := got["clientRequestId"]; present {
		t.Error("gateway-only fields must not reach the dealer")
	}
}

// Passthrough parity: a body with nothing to translate is forwarded byte for
// byte, so field order and formatting reach MT5 exactly as the client sent them.
func TestNormalizeTradeRequestLeavesUnrelatedBodiesUntouched(t *testing.T) {
	for _, in := range []string{
		`{"Action":"200","Login":1010,"Symbol":"EURUSD","Volume":10000}`,
		`not json at all`,
		``,
	} {
		if got := string(normalizeTradeRequest([]byte(in))); got != in {
			t.Errorf("body was rewritten:\n got: %s\nwant: %s", got, in)
		}
	}
}

// The dealer's parser is case-sensitive: a camelCase "action" is not an Action
// to it, and the request dies with "10013 Invalid request". The wire this MT5
// has always accepted is the .NET TradeRequest serialization, so every known
// field must leave in that exact spelling regardless of how the client cased it.
func TestNormalizeTradeRequestCanonicalizesFieldSpellings(t *testing.T) {
	in := `{"action":200,"login":1001,"symbol":"EURUSD","type":0,"volume":100,` +
		`"typeFill":0,"priceOrder":1.085,"priceSL":0,"priceTP":0,"digits":5,` +
		`"pricetrigger":0,"position":42,"source":"tv"}`

	got := decodeRequest(t, normalizeTradeRequest([]byte(in)))

	for _, want := range []string{
		"Action", "Login", "Symbol", "Type", "Volume", "TypeFill",
		"PriceOrder", "PriceSL", "PriceTP", "Digits", "PriceTrigger", "Position",
	} {
		if _, ok := got[want]; !ok {
			t.Errorf("normalized body is missing %q: %v", want, got)
		}
	}
	for _, gone := range []string{
		"action", "login", "symbol", "type", "volume", "typeFill",
		"priceOrder", "priceSL", "priceTP", "digits", "pricetrigger", "position",
	} {
		if _, ok := got[gone]; ok {
			t.Errorf("client spelling %q survived normalization: %v", gone, got)
		}
	}

	// Action has only ever been sent as a string ("200").
	if v, ok := got["Action"].(string); !ok || v != "200" {
		t.Errorf("Action = %#v, want the string \"200\"", got["Action"])
	}
	// source is not an MT5 field; the .NET model sent it lowercase and MT5
	// tolerates it, so it passes through unchanged.
	if v, ok := got["source"].(string); !ok || v != "tv" {
		t.Errorf("source = %#v, want \"tv\" untouched", got["source"])
	}
	if v := got["Volume"]; v != float64(100) {
		t.Errorf("Volume = %#v, want 100 untouched", v)
	}
}

// When the client already sends canonical spellings they must survive, and a
// duplicate in another casing must not clobber them.
func TestNormalizeTradeRequestKeepsCanonicalSpellings(t *testing.T) {
	in := `{"Action":"200","Symbol":"EURUSD","symbol":"IGNORED","Volume":100}`
	got := decodeRequest(t, normalizeTradeRequest([]byte(in)))
	if v := got["Symbol"]; v != "EURUSD" {
		t.Errorf("Symbol = %#v, want the canonical key's value to win", v)
	}
	if _, ok := got["symbol"]; ok {
		t.Error("duplicate lowercase symbol survived")
	}
}
