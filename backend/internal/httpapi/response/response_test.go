package response

import (
	"encoding/json"
	"net/http/httptest"
	"testing"
)

// TestEnvelopeShape pins the JSON shape and field order to match the .NET
// GlobalResponse (data, errorMessage, message, success) with nulls emitted.
func TestEnvelopeShape(t *testing.T) {
	tests := []struct {
		name string
		resp GlobalResponse
		want string
	}{
		{
			name: "success with data",
			resp: Success(map[string]any{"x": 1}, ""),
			want: `{"data":{"x":1},"errorMessage":null,"message":null,"success":true}`,
		},
		{
			name: "success with message",
			resp: Success(nil, "ok"),
			want: `{"data":null,"errorMessage":null,"message":"ok","success":true}`,
		},
		{
			name: "failure",
			resp: Failure("boom"),
			want: `{"data":null,"errorMessage":"boom","message":null,"success":false}`,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			b, err := json.Marshal(tc.resp)
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}
			if got := string(b); got != tc.want {
				t.Errorf("envelope mismatch\n got: %s\nwant: %s", got, tc.want)
			}
		})
	}
}

// TestWriteStatusConvention pins success→200, failure→400.
func TestWriteStatusConvention(t *testing.T) {
	cases := []struct {
		name string
		resp GlobalResponse
		want int
	}{
		{"success is 200", Success(nil, ""), 200},
		{"failure is 400", Failure("x"), 400},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			Write(rec, tc.resp)
			if rec.Code != tc.want {
				t.Errorf("status = %d, want %d", rec.Code, tc.want)
			}
			if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
				t.Errorf("content-type = %q, want application/json", ct)
			}
		})
	}
}
