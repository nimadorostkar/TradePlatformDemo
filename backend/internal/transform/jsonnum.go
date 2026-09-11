package transform

import (
	"strconv"
	"strings"
)

// The MT5 Manager Web API returns numeric fields as JSON STRINGS
// (e.g. "Bid":"1.0854", "Digits":"5"). Go's encoding/json can't decode those
// into float64/int, which would silently break the source=tv transforms. These
// lenient types accept both a quoted string and a bare number (matching
// Newtonsoft's behavior in the .NET service).

// Float decodes a float from a JSON number or a quoted numeric string.
type Float float64

func (f *Float) UnmarshalJSON(b []byte) error {
	s := strings.Trim(string(b), `"`)
	if s == "" || s == "null" {
		*f = 0
		return nil
	}
	if v, err := strconv.ParseFloat(s, 64); err == nil {
		*f = Float(v)
	}
	return nil // lenient: leave 0 on unparseable input
}

// Int decodes an int from a JSON number or a quoted numeric string.
type Int int

func (i *Int) UnmarshalJSON(b []byte) error {
	s := strings.Trim(string(b), `"`)
	if s == "" || s == "null" {
		*i = 0
		return nil
	}
	if v, err := strconv.ParseFloat(s, 64); err == nil {
		*i = Int(int64(v))
	}
	return nil
}

// Int64 decodes an int64 from a JSON number or a quoted numeric string.
type Int64 int64

func (i *Int64) UnmarshalJSON(b []byte) error {
	s := strings.Trim(string(b), `"`)
	if s == "" || s == "null" {
		*i = 0
		return nil
	}
	if v, err := strconv.ParseFloat(s, 64); err == nil {
		*i = Int64(int64(v))
	}
	return nil
}
