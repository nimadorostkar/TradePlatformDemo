package auth

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

// The CRM /accounts call is measured at 5.5–13 s in production and sits on
// every login, renewal, and account switch. The cache exists so only the
// first exchange per token per minute pays that price.
func TestAccountsDetailed_CachesPerToken(t *testing.T) {
	var hits atomic.Int64
	crm := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`[{"login":"1001","typeId":57},{"login":"1002","typeId":58}]`))
	}))
	defer crm.Close()

	c := NewCRMClient(crm.URL)
	ctx := context.Background()

	first, err := c.AccountsDetailed(ctx, "token-a")
	if err != nil {
		t.Fatal(err)
	}
	second, err := c.AccountsDetailed(ctx, "token-a")
	if err != nil {
		t.Fatal(err)
	}
	if hits.Load() != 1 {
		t.Fatalf("second call for the same token hit the CRM (%d upstream calls)", hits.Load())
	}
	if len(first) != 2 || len(second) != 2 {
		t.Fatalf("account lists wrong: %d / %d", len(first), len(second))
	}

	// A different token is a different principal: never share its answer.
	if _, err := c.AccountsDetailed(ctx, "token-b"); err != nil {
		t.Fatal(err)
	}
	if hits.Load() != 2 {
		t.Fatalf("a different token must reach the CRM (%d upstream calls)", hits.Load())
	}

	// A cached answer must be a copy: mutating one caller's slice must not
	// poison the next hit.
	second[0].Login = "mutated"
	third, err := c.AccountsDetailed(ctx, "token-a")
	if err != nil {
		t.Fatal(err)
	}
	if third[0].Login != "1001" {
		t.Fatalf("cache returned a shared, mutated slice: %+v", third[0])
	}
}

// Errors are never cached: a transient CRM failure must not blank the account
// list for a whole TTL.
func TestAccountsDetailed_DoesNotCacheFailures(t *testing.T) {
	var hits atomic.Int64
	crm := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if hits.Add(1) == 1 {
			http.Error(w, "boom", http.StatusBadGateway)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`[{"login":"1001","typeId":57}]`))
	}))
	defer crm.Close()

	c := NewCRMClient(crm.URL)
	if _, err := c.AccountsDetailed(context.Background(), "token"); err == nil {
		t.Fatal("first call should have failed")
	}
	accounts, err := c.AccountsDetailed(context.Background(), "token")
	if err != nil || len(accounts) != 1 {
		t.Fatalf("retry after failure should reach the CRM and succeed: %v %v", accounts, err)
	}
}

// The 2026-08-24 chart-load teardown measured this endpoint bimodal — 100 ms
// on a cache hit, 5.5–6.4 s on every miss, misses on ~43% of loads — because
// an expired entry blocked the caller on the full CRM round trip. An entry
// past its TTL but within the max-stale ceiling must be served immediately,
// with revalidation happening off the request path.
func TestAccountsDetailed_ServesStaleWhileRevalidating(t *testing.T) {
	var hits atomic.Int64
	release := make(chan struct{})
	crm := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if hits.Add(1) > 1 {
			// The refresh flight: prove the caller did not wait for it.
			<-release
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`[{"login":"1001","typeId":57}]`))
	}))
	defer crm.Close()
	defer close(release)

	c := NewCRMClient(crm.URL)
	ctx := context.Background()
	if _, err := c.AccountsDetailed(ctx, "token-a"); err != nil {
		t.Fatal(err)
	}

	// Age the entry past the TTL but inside the serving ceiling.
	key := sha256.Sum256([]byte("token-a"))
	c.accountsMu.Lock()
	entry := c.accountsCache[key]
	entry.at = time.Now().Add(-2 * crmAccountsCacheTTL)
	c.accountsCache[key] = entry
	c.accountsMu.Unlock()

	done := make(chan []Account, 1)
	go func() {
		out, err := c.AccountsDetailed(ctx, "token-a")
		if err != nil {
			t.Error(err)
		}
		done <- out
	}()
	select {
	case out := <-done:
		if len(out) != 1 || out[0].Login != "1001" {
			t.Fatalf("stale serve returned wrong list: %+v", out)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("an expired-but-servable entry blocked on the CRM refresh")
	}

	// An entry past the max-stale ceiling is dead: the caller must wait for
	// the CRM again rather than serve arbitrarily old metadata.
	c.accountsMu.Lock()
	entry = c.accountsCache[key]
	entry.at = time.Now().Add(-crmAccountsMaxStale - time.Second)
	c.accountsCache[key] = entry
	c.accountsMu.Unlock()
	if _, _, ok := c.cachedAccounts(key); ok {
		t.Fatal("an entry past the max-stale ceiling must not be served")
	}
}

// The CRM token is the load-bearing half of a 30-day session: the gateway JWT
// lasts 30 minutes and every restore re-mints it by re-presenting this token.
// So the trader's "keep me signed in" choice has to reach the CRM's own login,
// not just the cookie MaxAge — a long cookie wrapped around a short-session CRM
// token expires whenever the CRM decides, as a password prompt.
func TestLogin_ForwardsRememberMeToCRM(t *testing.T) {
	for _, remember := range []bool{true, false} {
		var got struct {
			Email      string `json:"email"`
			Password   string `json:"password"`
			RememberMe *bool  `json:"rememberMe"`
		}
		crm := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			_ = json.NewDecoder(r.Body).Decode(&got)
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"accessToken":"crm-token"}`))
		}))

		token, err := NewCRMClient(crm.URL).Login(context.Background(), "a@b.c", "pw", remember)
		crm.Close()
		if err != nil {
			t.Fatalf("remember=%v: %v", remember, err)
		}
		if token != "crm-token" {
			t.Fatalf("remember=%v: token %q", remember, token)
		}
		// Sent explicitly either way. Omitting it for false would leave the
		// un-remembered case at whatever the CRM defaults to, which is the
		// very ambiguity this flag exists to remove.
		if got.RememberMe == nil {
			t.Fatalf("remember=%v: rememberMe absent from the CRM login body", remember)
		}
		if *got.RememberMe != remember {
			t.Errorf("remember=%v: CRM received rememberMe=%v", remember, *got.RememberMe)
		}
	}
}
