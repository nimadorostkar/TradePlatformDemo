package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/nimadorostkar/TradePlatformDemo/backend/internal/auth"
	"github.com/nimadorostkar/TradePlatformDemo/backend/internal/domain"
)

func loginAPI(t *testing.T, crmURL string) *API {
	t.Helper()
	j, err := auth.NewJWT(auth.JWTConfig{Secret: "s", Expiry: time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	crm := auth.NewCRMClient(crmURL)
	return New(Deps{Login: domain.NewLoginService(j, crm)})
}

func postLogin(a *API, body string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(http.MethodPost, "/api/Authentication/login", strings.NewReader(body))
	w := httptest.NewRecorder()
	a.Login(w, r)
	return w
}

// The username/password path never issues a token: without a CRMToken the
// request is rejected outright, whatever the credentials.
func TestLogin_RequiresCRMToken(t *testing.T) {
	a := loginAPI(t, "http://crm.invalid")
	for _, body := range []string{
		`{"Username":"admin","Password":""}`,
		`{"Username":"admin","Password":"anything"}`,
		`{"Username":"alice","Password":"x","CRMToken":""}`,
	} {
		w := postLogin(a, body)
		if w.Code != http.StatusUnauthorized {
			t.Errorf("body %s: status = %d, want 401", body, w.Code)
		}
	}
}

// A CRMToken that the CRM rejects yields 401, not a fallback token.
func TestLogin_CRMRejectionIsUnauthorized(t *testing.T) {
	crm := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer crm.Close()
	w := postLogin(loginAPI(t, crm.URL), `{"Username":"alice","CRMToken":"bad"}`)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", w.Code)
	}
}

// A valid CRMToken issues a JWT, returned under the lowercase "token" key
// (ASP.NET Core camel-cased the .NET Ok(new { Token }) response).
func TestLogin_CRMTokenIssuesLowercaseToken(t *testing.T) {
	crm := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`[{"login":"1001","typeId":11},{"login":"1002","typeId":26}]`))
	}))
	defer crm.Close()
	w := postLogin(loginAPI(t, crm.URL), `{"Username":"alice","CRMToken":"good"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body: %s)", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), `"token":`) {
		t.Errorf(`expected lowercase "token" key in response: %s`, w.Body.String())
	}
	if strings.Contains(w.Body.String(), `"Token":`) {
		t.Errorf(`response must not use the old "Token" key: %s`, w.Body.String())
	}
}

// The trader's "keep me signed in" choice has to survive the whole chain, not
// only the cookie MaxAge that /login sets: /crmlogin is the request that mints
// the CRM token every later restore re-presents, and a short-session CRM token
// inside a 30-day cookie ends the session early with a password prompt.
func TestCRMLogin_ForwardsRememberToCRM(t *testing.T) {
	for _, tc := range []struct {
		body string
		want bool
	}{
		{`{"email":"a@b.c","password":"pw","Remember":true}`, true},
		{`{"email":"a@b.c","password":"pw","Remember":false}`, false},
		{`{"email":"a@b.c","password":"pw"}`, false},
	} {
		var seen struct {
			RememberMe *bool `json:"rememberMe"`
		}
		crm := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			_ = json.NewDecoder(r.Body).Decode(&seen)
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"accessToken":"crm-token"}`))
		}))

		a := loginAPI(t, crm.URL)
		r := httptest.NewRequest(http.MethodPost, "/api/Authentication/crmlogin", strings.NewReader(tc.body))
		w := httptest.NewRecorder()
		a.CRMLogin(w, r)
		crm.Close()

		if w.Code != http.StatusOK {
			t.Fatalf("%s: status %d", tc.body, w.Code)
		}
		if seen.RememberMe == nil {
			t.Fatalf("%s: rememberMe never reached the CRM", tc.body)
		}
		if *seen.RememberMe != tc.want {
			t.Errorf("%s: CRM received rememberMe=%v, want %v", tc.body, *seen.RememberMe, tc.want)
		}
	}
}
