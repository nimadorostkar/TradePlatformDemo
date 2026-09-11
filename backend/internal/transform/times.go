package transform

import (
	"bytes"
	"encoding/json"
	"strconv"
	"strings"
)

// Epoch-field rewriting for RAW MT5 payloads.
//
// The typed TV mappings restate broker-stamped times in UTC field by field, but
// several endpoints pass MT5's own JSON through untouched (the deal page, the
// non-TV history/position/order branches). Those payloads still carry broker-
// clock epochs, so they are patched in place: the named fields are shifted, and
// EVERYTHING else — unknown fields, numeric precision, string-encoded numbers —
// survives byte-for-byte in value (numbers are decoded with json.Number, never
// float64, so a 64-bit ticket cannot be rounded).
//
// The helpers are deliberately forgiving: a payload that does not decode, or a
// field that is absent, non-numeric, or zero ("not set"), is left exactly as it
// was. A time conversion is cosmetic next to delivering the data at all.

// DealTimeSecondFields / DealTimeMillisecondFields are the broker-stamped
// epochs on an MT5 deal record.
var (
	DealTimeSecondFields      = []string{"Time"}
	DealTimeMillisecondFields = []string{"TimeMsc"}
)

// OrderTimeSecondFields / OrderTimeMillisecondFields cover open orders and
// closed-order history rows (MT5 "history" = closed orders).
var (
	OrderTimeSecondFields      = []string{"TimeSetup", "TimeDone", "TimeExpiration"}
	OrderTimeMillisecondFields = []string{"TimeSetupMsc", "TimeDoneMsc"}
)

// PositionTimeSecondFields / PositionTimeMillisecondFields cover position rows.
var (
	PositionTimeSecondFields      = []string{"TimeCreate", "TimeUpdate"}
	PositionTimeMillisecondFields = []string{"TimeCreateMsc", "TimeUpdateMsc"}
)

// ShiftEpochsInAnswerBody rewrites the named epoch fields of every object in
// body's top-level "answer" array by −delta (broker → UTC when delta is the
// broker offset). The rest of the body (retcode, unknown siblings) is
// preserved. On any decode problem the original body is returned unchanged.
func ShiftEpochsInAnswerBody(body []byte, delta int64, secondFields, millisecondFields []string) []byte {
	if delta == 0 || len(body) == 0 {
		return body
	}
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.UseNumber()
	var root map[string]json.RawMessage
	if err := dec.Decode(&root); err != nil {
		return body
	}
	answer, ok := root["answer"]
	if !ok {
		return body
	}
	patched, changed := ShiftEpochsInObjectArray(answer, delta, secondFields, millisecondFields)
	if !changed {
		return body
	}
	root["answer"] = patched
	out, err := json.Marshal(root)
	if err != nil {
		return body
	}
	return out
}

// ShiftEpochsInObjectArray rewrites the named epoch fields of every object in a
// JSON array by −delta seconds (millisecond fields by −delta·1000). Numbers
// keep their exact representation via json.Number; values encoded as strings
// stay strings. Returns the (possibly patched) array and whether anything
// changed.
func ShiftEpochsInObjectArray(arr json.RawMessage, delta int64, secondFields, millisecondFields []string) (json.RawMessage, bool) {
	if delta == 0 || len(arr) == 0 {
		return arr, false
	}
	dec := json.NewDecoder(bytes.NewReader(arr))
	dec.UseNumber()
	var rows []map[string]any
	if err := dec.Decode(&rows); err != nil {
		return arr, false
	}
	changed := false
	for _, row := range rows {
		for _, f := range secondFields {
			if shiftEpochField(row, f, delta) {
				changed = true
			}
		}
		for _, f := range millisecondFields {
			if shiftEpochField(row, f, delta*1000) {
				changed = true
			}
		}
	}
	if !changed {
		return arr, false
	}
	out, err := json.Marshal(rows)
	if err != nil {
		return arr, false
	}
	return out, true
}

// shiftEpochField subtracts delta from row[field] when it is a positive
// integer, preserving the value's original encoding (number vs string).
// Zero means "not set" in every MT5 time field and is never shifted.
func shiftEpochField(row map[string]any, field string, delta int64) bool {
	v, ok := row[field]
	if !ok {
		return false
	}
	switch t := v.(type) {
	case json.Number:
		n, err := strconv.ParseInt(t.String(), 10, 64)
		if err != nil || n <= 0 {
			return false
		}
		row[field] = json.Number(strconv.FormatInt(n-delta, 10))
		return true
	case string:
		s := strings.TrimSpace(t)
		n, err := strconv.ParseInt(s, 10, 64)
		if err != nil || n <= 0 {
			return false
		}
		row[field] = strconv.FormatInt(n-delta, 10)
		return true
	default:
		return false
	}
}

// ShiftEpochParam shifts a raw query-string range value by +delta seconds when
// it is a plain unix-seconds integer, and passes anything else (empty, date
// strings) through untouched. Used on from/to windows headed INTO MT5, whose
// selection clock is the broker's.
func ShiftEpochParam(v string, delta int64) string {
	if delta == 0 {
		return v
	}
	s := strings.TrimSpace(v)
	if s == "" {
		return v
	}
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil || n <= 0 {
		return v
	}
	return strconv.FormatInt(n+delta, 10)
}
