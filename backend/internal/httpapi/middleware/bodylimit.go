package middleware

import (
	"bytes"
	"io"
	"net/http"
	"strings"

	"github.com/nimadorostkar/TradePlatformDemo/backend/internal/httpapi/response"
)

// RequestBodyLimit rejects oversized API request bodies before authentication
// or handlers parse them. It buffers at most maxBytes+1 so chunked requests are
// bounded too, then restores the exact body for downstream middleware.
func RequestBodyLimit(maxBytes int64) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Body == nil || !strings.HasPrefix(r.URL.Path, "/api/") ||
				(r.Method == http.MethodGet || r.Method == http.MethodHead || r.Method == http.MethodOptions) {
				next.ServeHTTP(w, r)
				return
			}
			if r.ContentLength > maxBytes {
				_ = r.Body.Close()
				response.WriteJSON(w, http.StatusRequestEntityTooLarge, response.Failure("request body too large"))
				return
			}

			body, err := io.ReadAll(io.LimitReader(r.Body, maxBytes+1))
			_ = r.Body.Close()
			if err != nil {
				response.WriteJSON(w, http.StatusBadRequest, response.Failure("could not read request body"))
				return
			}
			if int64(len(body)) > maxBytes {
				response.WriteJSON(w, http.StatusRequestEntityTooLarge, response.Failure("request body too large"))
				return
			}
			r.Body = io.NopCloser(bytes.NewReader(body))
			r.ContentLength = int64(len(body))
			next.ServeHTTP(w, r)
		})
	}
}
