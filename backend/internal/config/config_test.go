package config

import (
	"testing"
	"time"

	"github.com/caarlos0/env/v11"
)

func TestWebSocketQueryTokenDefaultsFailClosed(t *testing.T) {
	var security Security
	if err := env.ParseWithOptions(&security, env.Options{Environment: map[string]string{}}); err != nil {
		t.Fatal(err)
	}
	if security.WSAllowQueryToken {
		t.Fatal("WS_ALLOW_QUERY_TOKEN default must remain false")
	}
}

func TestWebSocketQueryTokenCanBeExplicitlyEnabledForMigration(t *testing.T) {
	var security Security
	if err := env.ParseWithOptions(&security, env.Options{Environment: map[string]string{
		"WS_ALLOW_QUERY_TOKEN": "true",
	}}); err != nil {
		t.Fatal(err)
	}
	if !security.WSAllowQueryToken {
		t.Fatal("explicit WS_ALLOW_QUERY_TOKEN=true was ignored")
	}
}

// valid returns a Config that passes Validate, so each test below can break
// exactly one thing.
func valid() *Config {
	c := &Config{}
	c.JWT.SecretKey = "secret"
	c.JWT.Expiry = 30 * time.Minute
	c.JWT.RestoreTTL = 720 * time.Hour
	c.JWT.ValidateIssuer, c.JWT.Issuer = true, "https://issuer.example"
	c.JWT.ValidateAudience, c.JWT.Audience = true, "clients"
	c.MT5.HostURL = "https://mt5.example"
	c.MT5.PoolSize = 1
	c.MT5.MaxResponseBytes = 1 << 20
	c.CRM.URL = "https://crm.example"
	c.Server.ReadHeaderTimeout = time.Second
	c.Server.MaxBodyBytes = 1 << 20
	c.Roles.Enabled = []string{"api"} // no mt5 role, so no password required
	return c
}

func TestValidAndCompleteConfigPasses(t *testing.T) {
	if err := valid().Validate(); err != nil {
		t.Fatalf("baseline config should validate: %v", err)
	}
}

// The bearer JWT authorizes live trading and has no server-side revocation,
// so its lifetime is the blast radius of a stolen token. An hour is the
// ceiling; month-long bearer tokens must be a startup failure, not a silent
// deployment choice. (Long sessions come from renewal + SESSION_RESTORE_TTL.)
func TestValidateRejectsLongBearerLifetimes(t *testing.T) {
	c := valid()
	c.JWT.Expiry = 720 * time.Hour
	if err := c.Validate(); err == nil {
		t.Fatal("a 30-day bearer token must be rejected at startup")
	}

	c = valid()
	c.JWT.Expiry = time.Hour // exactly the ceiling is allowed
	if err := c.Validate(); err != nil {
		t.Fatalf("a 1h lifetime should pass: %v", err)
	}

	c = valid()
	c.JWT.Expiry = 0
	if err := c.Validate(); err == nil {
		t.Fatal("a zero lifetime must be rejected")
	}
}

func TestValidateRequiresRestoreWindowToCoverOneToken(t *testing.T) {
	c := valid()
	c.JWT.RestoreTTL = time.Minute // shorter than the 30m token
	if err := c.Validate(); err == nil {
		t.Fatal("a restore window shorter than one token must be rejected")
	}
}

// The upstream broker, the CRM, and the token issuer are per-deployment. A
// compiled-in default meant a gateway stood up on a new server silently talked
// to the original firm's production instead of refusing to start.
func TestPerDeploymentEndpointsHaveNoDefaults(t *testing.T) {
	var c Config
	if err := env.ParseWithOptions(&c, env.Options{Environment: map[string]string{}}); err != nil {
		t.Fatal(err)
	}
	for name, got := range map[string]string{
		"MT5_HOST_URL": c.MT5.HostURL,
		"CRM_URL":      c.CRM.URL,
		"JWT_ISSUER":   c.JWT.Issuer,
		"JWT_AUDIENCE": c.JWT.Audience,
	} {
		if got != "" {
			t.Errorf("%s must not carry a built-in default, got %q", name, got)
		}
	}
}

func TestValidateRequiresPerDeploymentEndpoints(t *testing.T) {
	for name, breaks := range map[string]func(*Config){
		"MT5_HOST_URL": func(c *Config) { c.MT5.HostURL = "" },
		"CRM_URL":      func(c *Config) { c.CRM.URL = "" },
		"JWT_ISSUER":   func(c *Config) { c.JWT.Issuer = "" },
		"JWT_AUDIENCE": func(c *Config) { c.JWT.Audience = "" },
		"JWT_SECRET":   func(c *Config) { c.JWT.SecretKey = "" },
	} {
		c := valid()
		breaks(c)
		if err := c.Validate(); err == nil {
			t.Errorf("missing %s should fail validation", name)
		}
	}
}

// An unset issuer is only a problem when the issuer is actually checked.
func TestIssuerAndAudienceOptionalWhenValidationDisabled(t *testing.T) {
	c := valid()
	c.JWT.ValidateIssuer, c.JWT.Issuer = false, ""
	c.JWT.ValidateAudience, c.JWT.Audience = false, ""
	if err := c.Validate(); err != nil {
		t.Fatalf("issuer/audience should be optional when unvalidated: %v", err)
	}
}

func TestMT5PasswordRequiredOnlyForTheMT5Role(t *testing.T) {
	c := valid()
	c.Roles.Enabled = []string{"all"}
	if err := c.Validate(); err == nil {
		t.Error("a process running the mt5 role needs MT5_PASSWORD")
	}
	c.MT5.Password = "pw"
	if err := c.Validate(); err != nil {
		t.Errorf("mt5 role with a password should validate: %v", err)
	}
}

// The old rule failed fast only when ENVIRONMENT was exactly "production", so
// "staging", "prod", or an unset value started a misconfigured gateway.
func TestOnlyExplicitDevelopmentRelaxesValidation(t *testing.T) {
	for _, env := range []string{"", "staging", "prod", "production", "Production", "test", "qa"} {
		c := valid()
		c.Observability.Environment = env
		if !c.Strict() {
			t.Errorf("ENVIRONMENT=%q must be strict", env)
		}
	}
	for _, env := range []string{"development", "Development", "DEVELOPMENT"} {
		c := valid()
		c.Observability.Environment = env
		if c.Strict() {
			t.Errorf("ENVIRONMENT=%q should relax validation", env)
		}
	}
}
