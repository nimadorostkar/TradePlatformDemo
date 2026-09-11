package middleware

import (
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/json"
	"io"
	"net/http"
	"strings"

	"github.com/nimadorostkar/TradePlatformDemo/backend/internal/auth"
	"github.com/nimadorostkar/TradePlatformDemo/backend/internal/httpapi/response"
)

type ctxKey int

const claimsKey ctxKey = iota

// Validator is the subset of *auth.JWT the middleware needs (interface at the
// boundary keeps handlers testable with a fake).
type Validator interface {
	Validate(token string) (*auth.Claims, error)
}

// ClaimsFromContext returns the validated claims attached by JWTAuth.
func ClaimsFromContext(ctx context.Context) (*auth.Claims, bool) {
	c, ok := ctx.Value(claimsKey).(*auth.Claims)
	return c, ok
}

// JWTAuth validates the Bearer token and stores the claims in the request
// context. Missing/invalid tokens → 401, mirroring the .NET [Authorize] filter.
func JWTAuth(v Validator) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			token := bearerToken(r)
			if token == "" {
				unauthorized(w)
				return
			}
			claims, err := v.Validate(token)
			if err != nil {
				unauthorized(w)
				return
			}
			ctx := context.WithValue(r.Context(), claimsKey, claims)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// AccountsAuthorize enforces that the requested `login` is within the token's
// accounts claim. Reproduces AccountsAuthorizeAttribute: missing/empty accounts
// claim → 401; login not in the list → 403. login is read from the query
// string, falling back to a JSON body field "login".
func AccountsAuthorize() func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			claims, ok := ClaimsFromContext(r.Context())
			if !ok || len(claims.Accounts) == 0 {
				unauthorized(w)
				return
			}
			login := r.URL.Query().Get("login")
			if login == "" {
				login = loginFromBody(r)
			}
			// An account-scoped route must never become unscoped because the
			// client omitted/misspelled `login` or sent malformed JSON.
			if login == "" {
				response.WriteJSON(w, http.StatusBadRequest, response.Failure("login is required"))
				return
			}
			if !claims.HasAccount(login) {
				forbidden(w)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// ManagerAuthorize protects MT5 Manager maintenance operations whose
// ticket-only contracts cannot be scoped to a retail JWT. Empty disables the
// surface; a configured key is required in X-Manager-Key in addition to JWT.
func ManagerAuthorize(expected string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if expected == "" {
				http.NotFound(w, r)
				return
			}
			provided := r.Header.Get("X-Manager-Key")
			if len(provided) != len(expected) || subtle.ConstantTimeCompare([]byte(provided), []byte(expected)) != 1 {
				forbidden(w)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// bearerToken extracts the token from the Authorization header.
func bearerToken(r *http.Request) string {
	h := r.Header.Get("Authorization")
	const prefix = "Bearer "
	if len(h) > len(prefix) && strings.EqualFold(h[:len(prefix)], prefix) {
		return strings.TrimSpace(h[len(prefix):])
	}
	return ""
}

// loginFromBody reads `login` from a JSON body without consuming it for the
// downstream handler (the body is buffered and restored).
func loginFromBody(r *http.Request) string {
	if r.Body == nil {
		return ""
	}
	// The router's RequestBodyLimit has already bounded and buffered the body.
	// Read all of that copy here: imposing a second, smaller limit used to
	// truncate valid workspace envelopes and then forward the truncated body.
	buf, err := io.ReadAll(r.Body)
	_ = r.Body.Close()
	r.Body = io.NopCloser(bytes.NewReader(buf))
	if err != nil || len(buf) == 0 {
		return ""
	}
	var probe struct {
		Login json.RawMessage `json:"login"`
	}
	if err := json.Unmarshal(buf, &probe); err != nil {
		return "" // parse errors are swallowed, matching the .NET attribute
	}
	s := strings.Trim(string(probe.Login), `"`)
	if s == "null" {
		return ""
	}
	return s
}

func unauthorized(w http.ResponseWriter) {
	w.Header().Set("WWW-Authenticate", "Bearer")
	response.WriteJSON(w, http.StatusUnauthorized, response.Failure("Unauthorized"))
}

func forbidden(w http.ResponseWriter) {
	response.WriteJSON(w, http.StatusForbidden, response.Failure("Forbidden: Unauthorized account access."))
}
