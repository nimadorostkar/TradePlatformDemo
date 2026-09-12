package handlers

import (
	"encoding/base64"
	"errors"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/nimadorostkar/TradePlatformDemo/backend/internal/auth"
	"github.com/nimadorostkar/TradePlatformDemo/backend/internal/httpapi/response"
)

// Session restoration (AUTH-001).
//
// The terminal keeps its gateway JWT in memory only — the right call for a
// real-money app, but it meant a plain reload landed on the sign-in screen,
// possibly while a position was open. These endpoints add the missing half:
// /login also leaves the credentials in HttpOnly cookies the page's scripts
// cannot read, and GET /session hands them back to the app on boot.
//
// Scope and threat model:
//   - HttpOnly + SameSite=Lax + Path=/, and Secure whenever the trader's
//     connection is TLS (directly, or as the edge reports it in
//     X-Forwarded-Proto). In production the gateway is reverse-proxied
//     same-origin under /gateway, so these are first-party cookies. Lax means
//     no cross-site XHR/fetch ever carries them, and the gateway grants no
//     credentialed CORS — so /session is unreachable from another origin, and
//     cookie-borne CSRF cannot reach the POST trade routes. A deployment that
//     is still plain HTTP (an IP and a port) gets non-Secure cookies rather
//     than none: the browser would otherwise discard them and every reload
//     would demand the password again, while the bearer token on that same
//     connection is already travelling in clear.
//   - The cookies are a RESTORATION channel, not a parallel auth scheme: every
//     API route still authenticates with the Bearer token; nothing else reads
//     the cookies.
//   - The CRM token rides in its own cookie so the app can re-list accounts
//     and re-mint the gateway JWT after a reload without a new password entry.
//     It is base64url-wrapped only to keep the cookie value RFC-clean.
//   - Sessions stay stateless. The bearer JWT is short-lived (JWT_EXPIRY,
//     ≤1h); the cookies survive for SESSION_RESTORE_TTL and /session re-mints
//     a fresh JWT from the CRM cookie, so the RESTORE window is long while
//     the token blast radius stays small. Logout clears the cookies;
//     server-side revocation of a live JWT remains out of scope and is
//     documented in docs/API.md.

const (
	sessionCookieName = "tradeplatform_session"
	crmCookieName     = "tradeplatform_crm"
	userCookieName    = "tradeplatform_user"
	// Present (value "1") only when the trader asked to be remembered
	// (MED-02). Its absence makes every session cookie browser-session-only,
	// and the /session re-mint consults it so the choice survives renewal.
	persistCookieName = "tradeplatform_persist"
)

// sessionResponse mirrors the login response family: bare JSON, not enveloped.
type sessionResponse struct {
	Token    string `json:"token"`
	CRMToken string `json:"crmToken,omitempty"`
	Username string `json:"username,omitempty"`
	// Remembered reports whether this session was created with Remember=true,
	// so the client can keep passing the same choice on renewals (MED-02).
	Remembered bool `json:"remembered,omitempty"`
}

// setSessionCookies stores the freshly-minted session in HttpOnly cookies.
// ttl is the RESTORE window (SESSION_RESTORE_TTL), deliberately longer than
// the JWT it carries: when a returning browser presents an expired JWT,
// GET /session re-mints a fresh one from the cookie-held CRM token, so the
// short bearer lifetime does not shrink "come back tomorrow without a
// password" down to minutes.
// persist=false issues browser-session cookies instead: a 30-day session on a
// shared machine was never a choice the trader made (MED-02). The remember
// flag rides in its own cookie so the /session re-mint keeps honouring it.
func (a *API) setSessionCookies(w http.ResponseWriter, r *http.Request, token, crmToken, username string, persist bool) {
	ttl := a.d.SessionTTL
	if ttl <= 0 {
		ttl = time.Hour
	}
	// MaxAge 0 omits the attribute entirely — a session cookie that dies with
	// the browser, which is the default unless the trader opted in.
	maxAge := 0
	if persist {
		maxAge = int(ttl / time.Second)
	}
	secure := requestIsTLS(r)
	set := func(name, value string) {
		http.SetCookie(w, &http.Cookie{
			Name:     name,
			Value:    value,
			Path:     "/",
			Domain:   a.cookieDomainFor(r),
			MaxAge:   maxAge,
			HttpOnly: true,
			Secure:   secure,
			SameSite: http.SameSiteLaxMode,
		})
	}
	set(sessionCookieName, token)
	if crmToken != "" {
		set(crmCookieName, cookieEncode(crmToken))
	}
	if username != "" {
		set(userCookieName, cookieEncode(username))
	}
	if persist {
		set(persistCookieName, "1")
	}
}

// clearSessionCookies removes the session cookies (logout, invalid session).
// The Secure attribute must match the one they were set with, or the browser
// treats the clearing cookie as a different cookie and keeps the original.
func (a *API) clearSessionCookies(w http.ResponseWriter, r *http.Request) {
	secure := requestIsTLS(r)
	for _, name := range []string{sessionCookieName, crmCookieName, userCookieName, persistCookieName} {
		http.SetCookie(w, &http.Cookie{
			Name:     name,
			Value:    "",
			Path:     "/",
			Domain:   a.cookieDomainFor(r),
			MaxAge:   -1,
			HttpOnly: true,
			Secure:   secure,
			SameSite: http.SameSiteLaxMode,
		})
	}
}

// cookieDomainFor is the configured shared cookie domain when the request
// actually arrived on it (or a subdomain of it), else empty for a host-only
// cookie. A browser discards a cookie whose Domain does not cover the
// request host, so setting it blindly on the bare-IP address would leave
// that origin with no session at all.
func (a *API) cookieDomainFor(r *http.Request) string {
	domain := strings.TrimPrefix(strings.ToLower(a.d.SessionCookieDomain), ".")
	if domain == "" {
		return ""
	}
	host := strings.ToLower(requestHost(r))
	if host == domain || strings.HasSuffix(host, "."+domain) {
		return domain
	}
	return ""
}

// requestHost is the host the browser addressed, without a port: the edge
// forwards it in Host (and X-Forwarded-Host when it rewrites Host).
func requestHost(r *http.Request) string {
	host := r.Header.Get("X-Forwarded-Host")
	if host == "" {
		host = r.Host
	}
	if i := strings.IndexByte(host, ','); i >= 0 {
		host = host[:i]
	}
	host = strings.TrimSpace(host)
	if h, _, err := net.SplitHostPort(host); err == nil {
		return h
	}
	return host
}

// requestIsTLS reports whether the trader's connection is HTTPS: terminated
// here, or at the edge proxy, which forwards the original scheme.
func requestIsTLS(r *http.Request) bool {
	if r.TLS != nil {
		return true
	}
	return strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https")
}

// Session → GET /api/Authentication/session.
//
// Returns the cookie-held credentials when the session cookie carries a JWT
// this gateway still accepts. A stale JWT is not the end of the session: with
// short bearer lifetimes every return visit outlives the stored token, so an
// expired (or secret-rotated) JWT is re-minted from the cookie-held CRM token
// — the CRM re-validates it and the fresh token carries the CURRENT account
// claims. Only when that exchange also fails is the session dead; the cookies
// are then cleared so a browser holding garbage does not re-present it
// forever.
func (a *API) Session(w http.ResponseWriter, r *http.Request) {
	cookie, err := r.Cookie(sessionCookieName)
	token := ""
	if err == nil {
		token = cookie.Value
	}
	crmToken, username := "", ""
	if crm, err := r.Cookie(crmCookieName); err == nil {
		crmToken = cookieDecode(crm.Value)
	}
	if user, err := r.Cookie(userCookieName); err == nil {
		username = cookieDecode(user.Value)
	}

	if token == "" && crmToken == "" {
		// The pre-login probe (MED-10): a browser that has never signed in
		// asks whether it has a session, and "no" is a normal answer, not a
		// failure. A 401 here painted a red console error on every clean page
		// load — noise that buries the real problems support needs to spot.
		// Genuine restoration failures below keep their 401.
		w.WriteHeader(http.StatusNoContent)
		return
	}

	_, persistErr := r.Cookie(persistCookieName)
	remembered := persistErr == nil

	if token != "" {
		if _, err := a.d.JWT.Validate(token); err == nil {
			response.WriteStatus(w, http.StatusOK, sessionResponse{
				Token: token, CRMToken: crmToken, Username: username, Remembered: remembered,
			})
			return
		}
	}

	if crmToken != "" && a.d.Login != nil {
		fresh, err := a.d.Login.GenerateTokenWithCRMAccounts(r.Context(), crmToken, username)
		if err == nil && fresh != "" {
			// Preserve the original remember-me choice across the re-mint.
			a.setSessionCookies(w, r, fresh, crmToken, username, remembered)
			response.WriteStatus(w, http.StatusOK, sessionResponse{
				Token: fresh, CRMToken: crmToken, Username: username, Remembered: remembered,
			})
			return
		}
		// Only a DEFINITIVE CRM rejection may kill the session. A network
		// failure or a CRM 5xx proves nothing about the credential; clearing
		// the cookies on it would let one CRM hiccup permanently sign a
		// trader out of a 30-day session. Keep the cookies and let the next
		// restore attempt try again.
		var status *auth.CRMStatusError
		if !(errors.As(err, &status) && status.Rejected()) {
			response.WriteStatus(w, http.StatusUnauthorized,
				response.Failure("Session could not be restored — try again."))
			return
		}
	}

	a.clearSessionCookies(w, r)
	response.WriteStatus(w, http.StatusUnauthorized, response.Failure("Session expired."))
}

// Logout → POST /api/Authentication/logout. Clears the session cookies. The
// in-memory token the client holds simply expires with the tab; this makes
// sure the next visitor on this browser does not inherit the session.
func (a *API) Logout(w http.ResponseWriter, r *http.Request) {
	a.clearSessionCookies(w, r)
	response.WriteStatus(w, http.StatusOK, map[string]bool{"loggedOut": true})
}

// cookieEncode wraps an arbitrary token so the cookie value stays within
// RFC 6265's allowed octets regardless of what the CRM issues.
func cookieEncode(v string) string {
	return base64.RawURLEncoding.EncodeToString([]byte(v))
}

// cookieDecode reverses cookieEncode; garbage decodes to "".
func cookieDecode(v string) string {
	b, err := base64.RawURLEncoding.DecodeString(v)
	if err != nil {
		return ""
	}
	return string(b)
}
