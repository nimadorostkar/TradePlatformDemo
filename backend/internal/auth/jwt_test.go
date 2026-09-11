package auth

import (
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

func newTestJWT(t *testing.T, validateIss bool) *JWT {
	t.Helper()
	j, err := NewJWT(JWTConfig{
		Secret:           "test-secret-key",
		Issuer:           "iss",
		Audience:         "aud",
		Expiry:           time.Hour,
		ValidateIssuer:   validateIss,
		ValidateAudience: validateIss,
	})
	if err != nil {
		t.Fatalf("NewJWT: %v", err)
	}
	return j
}

func TestUserTokenRoundTrip(t *testing.T) {
	j := newTestJWT(t, true)
	tok, err := j.GenerateForUser("alice")
	if err != nil {
		t.Fatalf("generate: %v", err)
	}
	claims, err := j.Validate(tok)
	if err != nil {
		t.Fatalf("validate: %v", err)
	}
	if claims.Name != "alice" {
		t.Errorf("name = %q, want alice", claims.Name)
	}
}

func TestAccountsTokenRoundTrip(t *testing.T) {
	j := newTestJWT(t, true)
	tok, err := j.GenerateForAccounts([]string{"1001", "1002", "1003"})
	if err != nil {
		t.Fatalf("generate: %v", err)
	}
	claims, err := j.Validate(tok)
	if err != nil {
		t.Fatalf("validate: %v", err)
	}
	if len(claims.Accounts) != 3 {
		t.Fatalf("accounts = %v, want 3", claims.Accounts)
	}
	if !claims.HasAccount("1002") {
		t.Errorf("HasAccount(1002) = false, want true")
	}
	if claims.HasAccount("9999") {
		t.Errorf("HasAccount(9999) = true, want false")
	}
}

func TestRejectsWrongSecret(t *testing.T) {
	j := newTestJWT(t, true)
	tok, _ := j.GenerateForUser("bob")

	other, _ := NewJWT(JWTConfig{Secret: "different-secret", Expiry: time.Hour})
	if _, err := other.Validate(tok); err == nil {
		t.Error("expected validation to fail with wrong secret")
	}
}

// legacyDotNetToken mimics a token issued by the .NET JwtTokenHelper: HS256,
// name + exp/iat only — no iss or aud claims.
func legacyDotNetToken(t *testing.T, secret string) string {
	t.Helper()
	now := time.Now()
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		ClaimName: "alice",
		"exp":     now.Add(time.Hour).Unix(),
		"iat":     now.Unix(),
	})
	s, err := tok.SignedString([]byte(secret))
	if err != nil {
		t.Fatalf("sign legacy token: %v", err)
	}
	return s
}

// TestLegacyDotNetTokenDuringTransition pins the .NET→Go cutover contract:
// tokens issued by the old .NET service (no iss/aud) must validate while
// JWT_VALIDATE_ISSUER/AUDIENCE=false, and must be rejected once hardened.
func TestLegacyDotNetTokenDuringTransition(t *testing.T) {
	tok := legacyDotNetToken(t, "test-secret-key")

	transition := newTestJWT(t, false)
	claims, err := transition.Validate(tok)
	if err != nil {
		t.Fatalf("legacy token must validate during transition, got: %v", err)
	}
	if claims.Name != "alice" {
		t.Errorf("name = %q, want alice", claims.Name)
	}

	hardened := newTestJWT(t, true)
	if _, err := hardened.Validate(tok); err == nil {
		t.Error("legacy token must be rejected once iss/aud validation is on")
	}
}

func TestRejectsWrongAlg(t *testing.T) {
	// A token with alg=none must be rejected (only HS256 accepted).
	const noneToken = "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJuYW1lIjoieCJ9."
	j := newTestJWT(t, false)
	if _, err := j.Validate(noneToken); err == nil {
		t.Error("expected alg=none token to be rejected")
	}
}
