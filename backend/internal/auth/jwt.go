// Package auth issues and validates the gateway's client JWTs and talks to the
// OpoFinance CRM for login/account discovery. JWT signing matches the .NET
// service (HS256, ASCII key bytes, "accounts" claim) so tokens are cross-
// compatible across a migration when the same JWT_SECRET_KEY is used.
package auth

import (
	"fmt"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// ClaimName is the .NET ClaimTypes.Name URI, used for the username-only token
// so the JWT payload matches what the old service emitted.
const ClaimName = "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name"

// ClaimAccounts is the claim carrying the comma-joined MT5 account logins.
const ClaimAccounts = "accounts"

// JWTConfig configures token issuance and validation.
type JWTConfig struct {
	Secret           string
	Issuer           string
	Audience         string
	Expiry           time.Duration
	ValidateIssuer   bool // hardened default true; false reproduces legacy (no iss check)
	ValidateAudience bool // hardened default true; false reproduces legacy (no aud check)
}

// JWT issues and validates tokens.
type JWT struct {
	cfg JWTConfig
	key []byte
}

// Claims is the decoded, validated token payload the middleware needs.
type Claims struct {
	Name     string
	Accounts []string
	Raw      jwt.MapClaims
}

// NewJWT builds a JWT issuer/validator. The key is the ASCII bytes of the
// secret, matching the .NET SymmetricSecurityKey(Encoding.ASCII.GetBytes(...)).
func NewJWT(cfg JWTConfig) (*JWT, error) {
	if cfg.Secret == "" {
		return nil, fmt.Errorf("jwt: secret is required")
	}
	if cfg.Expiry <= 0 {
		cfg.Expiry = time.Hour
	}
	return &JWT{cfg: cfg, key: []byte(cfg.Secret)}, nil
}

// GenerateForUser issues a username-only token (the .NET GenerateToken).
func (j *JWT) GenerateForUser(username string) (string, error) {
	return j.sign(jwt.MapClaims{ClaimName: username})
}

// GenerateForAccounts issues a token carrying the comma-joined account list
// (the .NET GenerateJwtToken).
func (j *JWT) GenerateForAccounts(accounts []string) (string, error) {
	return j.sign(jwt.MapClaims{ClaimAccounts: strings.Join(accounts, ",")})
}

// sign adds standard timing/issuer/audience claims and signs with HS256.
func (j *JWT) sign(claims jwt.MapClaims) (string, error) {
	now := time.Now()
	claims["exp"] = now.Add(j.cfg.Expiry).Unix()
	claims["iat"] = now.Unix()
	// Include iss/aud so our own tokens pass when validation is enabled.
	// (Legacy .NET tokens omit these; validating them requires the flags off.)
	if j.cfg.Issuer != "" {
		claims["iss"] = j.cfg.Issuer
	}
	if j.cfg.Audience != "" {
		claims["aud"] = j.cfg.Audience
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return token.SignedString(j.key)
}

// Validate parses and verifies a token, returning its claims.
func (j *JWT) Validate(tokenString string) (*Claims, error) {
	opts := []jwt.ParserOption{jwt.WithValidMethods([]string{"HS256"})}
	if j.cfg.ValidateIssuer && j.cfg.Issuer != "" {
		opts = append(opts, jwt.WithIssuer(j.cfg.Issuer))
	}
	if j.cfg.ValidateAudience && j.cfg.Audience != "" {
		opts = append(opts, jwt.WithAudience(j.cfg.Audience))
	}

	parsed, err := jwt.Parse(tokenString, func(t *jwt.Token) (any, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", t.Header["alg"])
		}
		return j.key, nil
	}, opts...)
	if err != nil {
		return nil, err
	}
	mc, ok := parsed.Claims.(jwt.MapClaims)
	if !ok || !parsed.Valid {
		return nil, fmt.Errorf("jwt: invalid claims")
	}

	c := &Claims{Raw: mc}
	if v, ok := mc[ClaimName].(string); ok {
		c.Name = v
	}
	if v, ok := mc[ClaimAccounts].(string); ok && v != "" {
		c.Accounts = strings.Split(v, ",")
	}
	return c, nil
}

// HasAccount reports whether login is in the token's accounts claim.
func (c *Claims) HasAccount(login string) bool {
	for _, a := range c.Accounts {
		if strings.TrimSpace(a) == login {
			return true
		}
	}
	return false
}
