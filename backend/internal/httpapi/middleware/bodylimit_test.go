package middleware

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRequestBodyLimit(t *testing.T) {
	const max = 4
	tests := []struct {
		name          string
		method        string
		path          string
		body          string
		unknownLength bool
		wantStatus    int
		wantBody      string
	}{
		{"within limit is preserved", http.MethodPost, "/api/x", "1234", false, http.StatusOK, "1234"},
		{"content length over limit", http.MethodPost, "/api/x", "12345", false, http.StatusRequestEntityTooLarge, ""},
		{"chunked over limit", http.MethodPost, "/api/x", "12345", true, http.StatusRequestEntityTooLarge, ""},
		{"non API route unaffected", http.MethodPost, "/other", "12345", false, http.StatusOK, "12345"},
		{"GET unaffected", http.MethodGet, "/api/x", "12345", false, http.StatusOK, "12345"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var gotBody string
			h := RequestBodyLimit(max)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				b, _ := io.ReadAll(r.Body)
				gotBody = string(b)
				w.WriteHeader(http.StatusOK)
			}))
			r := httptest.NewRequest(tc.method, tc.path, strings.NewReader(tc.body))
			if tc.unknownLength {
				r.ContentLength = -1
			}
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			if w.Code != tc.wantStatus {
				t.Fatalf("status = %d, want %d", w.Code, tc.wantStatus)
			}
			if gotBody != tc.wantBody {
				t.Fatalf("downstream body = %q, want %q", gotBody, tc.wantBody)
			}
		})
	}
}
