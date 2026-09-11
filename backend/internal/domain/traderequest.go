package domain

import (
	"encoding/json"
	"strconv"
	"strings"

	"github.com/nimadorostkar/TradePlatformDemo/backend/internal/transform"
)

// The trade-request body is forwarded to MT5 essentially as the client sent
// it. normalizeTradeRequest closes the two gaps that opens: it translates a
// client's notion of "expires at" into MT5's TypeTime / TimeExpiration pair,
// and it canonicalizes field spellings to the ones the dealer's case-sensitive
// parser accepts. Field VALUES pass through untouched — MT5 remains the
// authority on whether a request is well formed.

// Client field names accepted for order duration, in priority order. All are
// matched case-insensitively because the wire has historically mixed casings.
var (
	clientTypeTimeKeys   = []string{"typetime", "type_time"}
	clientExpirationKeys = []string{"expiration", "timeexpiration", "expiry", "expiretime"}
	clientDurationKey    = "duration"
	// clientOnlyKeys never reach MT5: they are gateway-level concerns and an
	// unknown field in a dealer request is a needless risk.
	clientOnlyKeys = []string{"clientrequestid", "idempotencykey", "idempotency_key"}
)

// MT5 field names written into the forwarded body.
const (
	mt5TypeTimeKey       = "TypeTime"
	mt5TimeExpirationKey = "TimeExpiration"
)

// The dealer parses field names case-sensitively. The .NET service always
// re-serialized requests through its TradeRequest model, so this MT5 has only
// ever been sent these exact spellings — a camelCase "action" is not an
// Action to it, and the whole request dies with "10013 Invalid request"
// (observed live). Emit the proven spellings whatever the client sent.
var mt5FieldSpellings = map[string]string{
	"action":         "Action",
	"login":          "Login",
	"symbol":         "Symbol",
	"volume":         "Volume",
	"typefill":       "TypeFill",
	"type":           "Type",
	"priceorder":     "PriceOrder",
	"digits":         "Digits",
	"pricetrigger":   "PriceTrigger",
	"order":          "Order",
	"position":       "Position",
	"pricesl":        "PriceSL",
	"pricetp":        "PriceTP",
	"typetime":       mt5TypeTimeKey,
	"timeexpiration": mt5TimeExpirationKey,
}

// normalizeTradeRequest rewrites client duration fields into the MT5 pair and
// strips gateway-only fields. Unparseable bodies pass through untouched — this
// function's job is translation, not validation, and MT5 remains the authority
// on whether a request is well formed.
func normalizeTradeRequest(body []byte) []byte {
	if len(body) == 0 {
		return body
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(body, &fields); err != nil {
		return body
	}

	lower := make(map[string]string, len(fields)) // lowercased name → actual key
	for k := range fields {
		lower[strings.ToLower(k)] = k
	}

	rawTypeTime, hasTypeTime := lookupInt(fields, lower, clientTypeTimeKeys)
	typeTime := int(rawTypeTime)
	expiration, hasExpiration := lookupInt(fields, lower, clientExpirationKeys)
	durationType, durationAt, hasDuration := lookupDuration(fields, lower)

	touched := false

	// A `duration` block ({type:"GTD",datetime:…}) is the TradingView-native
	// form; explicit typetime/expiration win when both are present.
	if hasDuration && !hasTypeTime {
		at := durationAt
		if hasExpiration {
			at = expiration
		}
		typeTime, expiration = transform.MT5TypeTimeFromDuration(durationType, at)
		hasTypeTime, hasExpiration = true, true
	}

	// An expiry with no explicit typetime means "good till that time".
	if hasExpiration && !hasTypeTime && expiration > 0 {
		typeTime = transform.OrderTimeSpecified
		hasTypeTime = true
	}
	// A GTD typetime with no deadline is downgraded to GTC: MT5 answers an
	// expiry of 1970 with INVALID_EXPIRATION, which reads to a trader as an
	// unexplained rejection of a valid order.
	if hasTypeTime && isSpecified(typeTime) && expiration <= 0 {
		typeTime = transform.OrderTimeGTC
	}

	if hasTypeTime {
		fields[mt5TypeTimeKey] = jsonInt(typeTime)
		touched = true
	}
	if hasTypeTime || hasExpiration {
		if !isSpecified(typeTime) {
			expiration = 0
		}
		fields[mt5TimeExpirationKey] = jsonInt64(expiration)
		touched = true
	}

	// Drop the client spellings so MT5 sees only its own field names.
	for _, name := range append(append([]string{}, clientTypeTimeKeys...), clientExpirationKeys...) {
		if actual, ok := lower[name]; ok && actual != mt5TypeTimeKey && actual != mt5TimeExpirationKey {
			delete(fields, actual)
			touched = true
		}
	}
	if actual, ok := lower[clientDurationKey]; ok {
		delete(fields, actual)
		touched = true
	}
	for _, name := range clientOnlyKeys {
		if actual, ok := lower[name]; ok {
			delete(fields, actual)
			touched = true
		}
	}

	// Canonicalize the remaining keys to the dealer's spelling. When both a
	// client casing and the canonical one are present, the canonical one wins.
	for actual := range fields {
		canonical, known := mt5FieldSpellings[strings.ToLower(actual)]
		if !known || actual == canonical {
			continue
		}
		if _, exists := fields[canonical]; !exists {
			fields[canonical] = fields[actual]
		}
		delete(fields, actual)
		touched = true
	}

	// The dealer has only ever been sent Action as a STRING ("200"): the .NET
	// TradeRequest declared it string and every working client complied.
	if raw, ok := fields["Action"]; ok {
		if s := strings.TrimSpace(string(raw)); s != "" && s[0] != '"' && s != "null" {
			fields["Action"] = json.RawMessage(strconv.Quote(s))
			touched = true
		}
	}

	if !touched {
		return body
	}
	out, err := json.Marshal(fields)
	if err != nil {
		return body
	}
	return out
}

func isSpecified(typeTime int) bool {
	return typeTime == transform.OrderTimeSpecified || typeTime == transform.OrderTimeSpecifiedDay
}

// lookupInt reads the first present key as an integer, accepting both a JSON
// number and a quoted numeric string (MT5 clients send both).
func lookupInt(fields map[string]json.RawMessage, lower map[string]string, names []string) (int64, bool) {
	for _, name := range names {
		actual, ok := lower[name]
		if !ok {
			continue
		}
		if v, ok := parseJSONInt(fields[actual]); ok {
			return v, true
		}
	}
	return 0, false
}

// lookupDuration reads a TradingView `duration` block: {type, datetime}.
func lookupDuration(fields map[string]json.RawMessage, lower map[string]string) (string, int64, bool) {
	actual, ok := lower[clientDurationKey]
	if !ok {
		return "", 0, false
	}
	var d struct {
		Type     string          `json:"type"`
		Datetime json.RawMessage `json:"datetime"`
	}
	if err := json.Unmarshal(fields[actual], &d); err != nil || d.Type == "" {
		return "", 0, false
	}
	at, _ := parseJSONInt(d.Datetime)
	return d.Type, at, true
}

// parseJSONInt decodes a JSON number or quoted numeric string to an int64.
// Fractional values are truncated: a unix timestamp with a decimal part is
// still a second-precision timestamp.
func parseJSONInt(raw json.RawMessage) (int64, bool) {
	s := strings.TrimSpace(strings.Trim(string(raw), `"`))
	if s == "" || s == "null" {
		return 0, false
	}
	if v, err := strconv.ParseInt(s, 10, 64); err == nil {
		return v, true
	}
	if f, err := strconv.ParseFloat(s, 64); err == nil {
		return int64(f), true
	}
	return 0, false
}

func jsonInt(v int) json.RawMessage { return json.RawMessage(strconv.Itoa(v)) }

func jsonInt64(v int64) json.RawMessage {
	return json.RawMessage(strconv.FormatInt(v, 10))
}

// shiftExpirationToBroker restates a normalized request's TimeExpiration —
// which the client provided in UTC — on the broker's clock, where MT5
// evaluates it. Runs AFTER normalizeTradeRequest, so the field is already
// under its canonical name. Zero ("no expiry") and malformed bodies pass
// through untouched.
func shiftExpirationToBroker(body []byte, brokerOffsetSeconds int64) []byte {
	if brokerOffsetSeconds == 0 || len(body) == 0 {
		return body
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(body, &fields); err != nil {
		return body
	}
	raw, ok := fields[mt5TimeExpirationKey]
	if !ok {
		return body
	}
	v, ok := parseJSONInt(raw)
	if !ok || v <= 0 {
		return body
	}
	fields[mt5TimeExpirationKey] = jsonInt64(v + brokerOffsetSeconds)
	out, err := json.Marshal(fields)
	if err != nil {
		return body
	}
	return out
}
