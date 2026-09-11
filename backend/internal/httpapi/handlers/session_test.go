package handlers

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/nimadorostkar/TradePlatformDemo/backend/internal/auth"
	"github.com/nimadorostkar/TradePlatformDemo/backend/internal/domain"
)

// Session restoration (AUTH-001): /login leaves the credentials in HttpOnly
// cookies, GET /session hands them back while the JWT is valid, /logout clears
// them. Reload-survives-without-relogin depends on exactly these three.

func sessionAPI(t *testing.T, crmURL string) *API {
	t.Helper()
	j, err := auth.NewJWT(auth.JWTConfig{Secret: "s", Expiry: time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	crm := auth.NewCRMClient(crmURL)
	return New(Deps{Login: domain.NewLoginService(j, crm), JWT: j, SessionTTL: time.Hour})
}

func crmStub(t *testing.T) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`[{"login":"1001","typeId":11}]`))
	}))
}

func cookieByName(res *http.Response, name string) *http.Cookie {
	for _, c := range res.Cookies() {
		if c.Name == name {
			return c
		}
	}
	return nil
}

func TestLogin_SetsHardenedSessionCookies(t *testing.T) {
	crm := crmStub(t)
	defer crm.Close()
	a := sessionAPI(t, crm.URL)

	// Remember=true keeps the long restore window; the un-remembered variant
	// is covered by TestLogin_WithoutRememberIsSessionOnly below (MED-02).
	w := postLogin(a, `{"Username":"alice@example.com","CRMToken":"crm-token-value","Remember":true}`)
	if w.Code != http.StatusOK {
		t.Fatalf("login status = %d", w.Code)
	}
	res := w.Result()
	session := cookieByName(res, "opotrade_session")
	if session == nil || session.Value == "" {
		t.Fatal("no opotrade_session cookie set at login")
	}
	if !session.HttpOnly || !session.Secure || session.SameSite != http.SameSiteLaxMode || session.Path != "/" {
		t.Errorf("session cookie not hardened: %+v", session)
	}
	// SessionTTL is the RESTORE window, not the JWT lifetime: /session
	// re-mints an expired JWT from the CRM cookie, so the cookies must
	// outlive the bearer token.
	if session.MaxAge != int(time.Hour/time.Second) {
		t.Errorf("cookie MaxAge %d does not match the configured restore window", session.MaxAge)
	}
	if crm := cookieByName(res, "opotrade_crm"); crm == nil || crm.Value == "" || !crm.HttpOnly {
		t.Error("CRM token cookie missing or script-readable")
	}
	if persist := cookieByName(res, "opotrade_persist"); persist == nil || persist.Value != "1" {
		t.Error("remembered login must set the persist marker for the /session re-mint")
	}
}

func TestLogin_WithoutRememberIsSessionOnly(t *testing.T) {
	// A 30-day session nobody asked for is how the previous trader's account
	// greets the next person at a shared computer (MED-02). Without the
	// checkbox the cookies must die with the browser: no Max-Age, no Expires.
	crm := crmStub(t)
	defer crm.Close()
	a := sessionAPI(t, crm.URL)

	w := postLogin(a, `{"Username":"alice@example.com","CRMToken":"crm-token-value"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("login status = %d", w.Code)
	}
	res := w.Result()
	session := cookieByName(res, "opotrade_session")
	if session == nil || session.Value == "" {
		t.Fatal("no opotrade_session cookie set at login")
	}
	if session.MaxAge != 0 || !session.Expires.IsZero() {
		t.Errorf("un-remembered session cookie must be browser-session-only, got MaxAge=%d Expires=%v",
			session.MaxAge, session.Expires)
	}
	if persist := cookieByName(res, "opotrade_persist"); persist != nil {
		t.Error("persist marker must not be set without Remember")
	}
}

func TestSession_RestoresWhatLoginStored(t *testing.T) {
	crm := crmStub(t)
	defer crm.Close()
	a := sessionAPI(t, crm.URL)

	login := postLogin(a, `{"Username":"alice@example.com","CRMToken":"crm-token-value"}`)
	res := login.Result()

	r := httptest.NewRequest(http.MethodGet, "/api/Authentication/session", nil)
	for _, c := range res.Cookies() {
		r.AddCookie(c)
	}
	w := httptest.NewRecorder()
	a.Session(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("session status = %d (%s)", w.Code, w.Body.String())
	}
	body := w.Body.String()
	if !strings.Contains(body, `"token":`) {
		t.Errorf("restored session missing token: %s", body)
	}
	if !strings.Contains(body, `"crmToken":"crm-token-value"`) {
		t.Errorf("restored session missing CRM token: %s", body)
	}
	if !strings.Contains(body, `"username":"alice@example.com"`) {
		t.Errorf("restored session missing username: %s", body)
	}
}

func TestSession_NoCookieIs204(t *testing.T) {
	// "This browser has no session" is a normal pre-login answer, not an
	// error: a 401 here logged a red console line on every clean page load
	// (MED-10). Failed RESTORATIONS still 401 — see the tests below.
	a := sessionAPI(t, "http://crm.invalid")
	r := httptest.NewRequest(http.MethodGet, "/api/Authentication/session", nil)
	w := httptest.NewRecorder()
	a.Session(w, r)
	if w.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204", w.Code)
	}
}

func TestSession_GarbageCookieIs401AndCleared(t *testing.T) {
	a := sessionAPI(t, "http://crm.invalid")
	r := httptest.NewRequest(http.MethodGet, "/api/Authentication/session", nil)
	r.AddCookie(&http.Cookie{Name: "opotrade_session", Value: "not-a-jwt"})
	w := httptest.NewRecorder()
	a.Session(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", w.Code)
	}
	cleared := cookieByName(w.Result(), "opotrade_session")
	if cleared == nil || cleared.MaxAge != -1 {
		t.Error("an invalid session cookie must be cleared, not re-presented forever")
	}
}

// With short bearer lifetimes, every return visit outlives the stored JWT.
// The session is not dead: the CRM cookie is the durable credential, and
// /session re-mints a fresh JWT from it — CRM-validated, carrying the current
// account claims.
func TestSession_ExpiredJWTIsRemintedFromCRMCookie(t *testing.T) {
	crm := crmStub(t)
	defer crm.Close()
	a := sessionAPI(t, crm.URL)

	r := httptest.NewRequest(http.MethodGet, "/api/Authentication/session", nil)
	r.AddCookie(&http.Cookie{Name: "opotrade_session", Value: "expired-or-rotated-jwt"})
	r.AddCookie(&http.Cookie{Name: "opotrade_crm", Value: cookieEncode("crm-token-value")})
	r.AddCookie(&http.Cookie{Name: "opotrade_user", Value: cookieEncode("alice@example.com")})
	w := httptest.NewRecorder()
	a.Session(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 via re-mint (%s)", w.Code, w.Body.String())
	}
	body := w.Body.String()
	if !strings.Contains(body, `"token":`) || strings.Contains(body, "expired-or-rotated-jwt") {
		t.Errorf("re-mint must return a FRESH token: %s", body)
	}
	// The fresh token must also replace the stored cookie, or every later
	// restore repeats the slow CRM exchange.
	set := cookieByName(w.Result(), "opotrade_session")
	if set == nil || set.Value == "" || set.Value == "expired-or-rotated-jwt" {
		t.Error("re-mint did not refresh the session cookie")
	}
}

// A dead JWT with a DEFINITIVELY rejected CRM token is the end of the session.
func TestSession_ExpiredJWTWithDeadCRMIs401(t *testing.T) {
	crm := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
	}))
	defer crm.Close()
	a := sessionAPI(t, crm.URL)

	r := httptest.NewRequest(http.MethodGet, "/api/Authentication/session", nil)
	r.AddCookie(&http.Cookie{Name: "opotrade_session", Value: "expired-jwt"})
	r.AddCookie(&http.Cookie{Name: "opotrade_crm", Value: cookieEncode("revoked-crm-token")})
	w := httptest.NewRecorder()
	a.Session(w, r)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", w.Code)
	}
	if c := cookieByName(w.Result(), "opotrade_session"); c == nil || c.MaxAge != -1 {
		t.Error("a dead session must clear its cookies")
	}
}

// A TRANSIENT CRM failure during a re-mint proves nothing about the
// credential. Clearing the cookies on it would let one CRM hiccup permanently
// sign a trader out of a 30-day session — the cookies must survive so the
// next restore attempt can succeed.
func TestSession_TransientCRMFailureKeepsTheCookies(t *testing.T) {
	crm := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "bad gateway", http.StatusBadGateway)
	}))
	defer crm.Close()
	a := sessionAPI(t, crm.URL)

	r := httptest.NewRequest(http.MethodGet, "/api/Authentication/session", nil)
	r.AddCookie(&http.Cookie{Name: "opotrade_session", Value: "expired-jwt"})
	r.AddCookie(&http.Cookie{Name: "opotrade_crm", Value: cookieEncode("still-good-crm-token")})
	w := httptest.NewRecorder()
	a.Session(w, r)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401 (restore fails NOW, retryable later)", w.Code)
	}
	if strings.Contains(w.Body.String(), "Session expired") {
		t.Error("a transient failure must not be reported as an expired session")
	}
	for _, c := range w.Result().Cookies() {
		if c.MaxAge == -1 {
			t.Errorf("cookie %s was cleared on a transient CRM failure", c.Name)
		}
	}
}

// An unreachable CRM (network refusal, not an HTTP status) is transient too.
func TestSession_UnreachableCRMKeepsTheCookies(t *testing.T) {
	a := sessionAPI(t, "http://127.0.0.1:1") // connection refused

	r := httptest.NewRequest(http.MethodGet, "/api/Authentication/session", nil)
	r.AddCookie(&http.Cookie{Name: "opotrade_session", Value: "expired-jwt"})
	r.AddCookie(&http.Cookie{Name: "opotrade_crm", Value: cookieEncode("still-good-crm-token")})
	w := httptest.NewRecorder()
	a.Session(w, r)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", w.Code)
	}
	for _, c := range w.Result().Cookies() {
		if c.MaxAge == -1 {
			t.Errorf("cookie %s was cleared while the CRM was unreachable", c.Name)
		}
	}
}

func TestLogout_ClearsEverySessionCookie(t *testing.T) {
	a := sessionAPI(t, "http://crm.invalid")
	r := httptest.NewRequest(http.MethodPost, "/api/Authentication/logout", nil)
	w := httptest.NewRecorder()
	a.Logout(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d", w.Code)
	}
	res := w.Result()
	for _, name := range []string{"opotrade_session", "opotrade_crm", "opotrade_user"} {
		c := cookieByName(res, name)
		if c == nil || c.MaxAge != -1 {
			t.Errorf("cookie %s not cleared on logout", name)
		}
	}
}
