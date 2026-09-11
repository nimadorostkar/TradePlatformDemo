package auth

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Which CRM account types may trade through this terminal is a policy, not a
// constant. The .NET LoginService admitted {11, 26, 57..67}, but only 57–67
// have a known symbol suffix ("." ECN, "!" Standard, "#" Social, none for
// ECNPRO). Trading a group whose suffix is unknown sends wrong symbol names to
// MT5, so types 11 and 26 are excluded by default — and admitting them once
// their suffix is confirmed is a configuration change, not a code change.

// DefaultAllowedTypeIDs are the CRM account typeIds admitted out of the box:
// 57–67, the range whose symbol suffix is known.
func DefaultAllowedTypeIDs() []int {
	out := make([]int, 0, 11)
	for i := 57; i <= 67; i++ {
		out = append(out, i)
	}
	return out
}

// AccountPolicy decides which CRM account types are tradable and what symbol
// suffix each one uses.
type AccountPolicy struct {
	allowed    map[int]struct{}
	suffixes   map[int]string
	kinds      map[int]string
	demoGroups map[string]struct{}
}

// NewAccountPolicy builds a policy. An empty allowed list falls back to the
// default 57–67 range rather than admitting everything: failing open here would
// put untradable accounts in the account selector.
func NewAccountPolicy(allowed []int, suffixes map[int]string) AccountPolicy {
	if len(allowed) == 0 {
		allowed = DefaultAllowedTypeIDs()
	}
	p := AccountPolicy{
		allowed:    make(map[int]struct{}, len(allowed)),
		suffixes:   map[int]string{},
		kinds:      map[int]string{},
		demoGroups: map[string]struct{}{},
	}
	for _, id := range allowed {
		p.allowed[id] = struct{}{}
	}
	for id, suffix := range suffixes {
		p.suffixes[id] = suffix
	}
	return p
}

// AccountKind values. Anything else — including the empty string — means the
// deployment has not classified the type, and the client shows no badge.
const (
	AccountKindDemo = "demo"
	AccountKindLive = "live"
)

// WithAccountKinds records which CRM account types hold demo funds and which
// hold real money. A type in neither list stays unclassified.
//
// A type in BOTH is treated as unclassified rather than picking a winner: a
// contradictory configuration is exactly the case where guessing is worst.
func (p AccountPolicy) WithAccountKinds(demo, live []int) AccountPolicy {
	kinds := make(map[int]string, len(demo)+len(live))
	for _, id := range demo {
		kinds[id] = AccountKindDemo
	}
	for _, id := range live {
		if _, clash := kinds[id]; clash {
			delete(kinds, id)
			continue
		}
		kinds[id] = AccountKindLive
	}
	p.kinds = kinds
	return p
}

// Kind returns "demo", "live", or "" when the type has not been classified.
func (p AccountPolicy) Kind(typeID int) string { return p.kinds[typeID] }

// WithDemoGroups records the MT5 groups whose funds are simulated, matched by
// EXACT full name, case-insensitively.
//
// Exact names rather than a pattern, deliberately. A renamed or newly added
// group falls OUT of the list and becomes unclassified, which shows no badge —
// visibly missing, and someone asks why. A substring rule like "-SF-" keeps
// matching whatever it happens to hit and mislabels silently, which is the
// failure nobody notices until a client trades the wrong account.
//
// Groups rather than CRM account types because this broker's types cannot
// express it: "ECN Pro" contains both Opoforex\ECNPRO-USD-B (real) and
// Opoforex\ECNPRO-SF-USD-B (simulated), so classifying by type would badge
// five real accounts as demo (measured 2026-08-26).
func (p AccountPolicy) WithDemoGroups(groups []string) AccountPolicy {
	set := make(map[string]struct{}, len(groups))
	for _, g := range groups {
		if trimmed := strings.ToLower(strings.TrimSpace(g)); trimmed != "" {
			set[trimmed] = struct{}{}
		}
	}
	p.demoGroups = set
	return p
}

// ClassifiesByGroup reports whether any group has been classified, so a caller
// can skip the per-account lookups entirely when none has.
func (p AccountPolicy) ClassifiesByGroup() bool { return len(p.demoGroups) > 0 }

// KindForGroup classifies one MT5 group. An empty group name, or one nobody
// listed, is unclassified — never "live" by omission.
func (p AccountPolicy) KindForGroup(group string) string {
	if group == "" || len(p.demoGroups) == 0 {
		return ""
	}
	if _, ok := p.demoGroups[strings.ToLower(strings.TrimSpace(group))]; ok {
		return AccountKindDemo
	}
	// Every group on this deployment is enumerated, so one that is not demo is
	// real money — the operator stating the demo set IS the statement.
	return AccountKindLive
}

// Allows reports whether accounts of this type may trade here.
func (p AccountPolicy) Allows(typeID int) bool {
	_, ok := p.allowed[typeID]
	return ok
}

// Suffix returns the configured symbol suffix for a type and whether one is
// configured at all. An empty suffix is a legitimate answer (ECNPRO uses none),
// which is exactly why "not configured" cannot be represented as "".
func (p AccountPolicy) Suffix(typeID int) (string, bool) {
	s, ok := p.suffixes[typeID]
	return s, ok
}

// Account is one CRM trading account with the policy applied.
type Account struct {
	Login  string `json:"login"`
	TypeID int    `json:"typeId"`
	// Suffix is the symbol suffix for this account's group; SuffixKnown says
	// whether it was configured. A client must not build symbol names for an
	// account whose suffix is unknown.
	Suffix      string `json:"suffix"`
	SuffixKnown bool   `json:"suffixKnown"`
	// AccountKind is "demo" or "live" when the deployment has classified this
	// account type, and is OMITTED otherwise. Absent means "not stated": the
	// terminal renders no badge rather than defaulting to LIVE.
	AccountKind string `json:"accountKind,omitempty"`
}

// CRMClient talks to the TradePlatform CRM. It uses its own HTTP client so its
// bearer headers never touch the shared MT5 connection.
type CRMClient struct {
	baseURL string
	client  *http.Client
	policy  AccountPolicy

	// Accounts cache, keyed by a hash of the CRM token (never the token
	// itself). The CRM's /accounts call is measured at 5.5–13 s in
	// production, and it sits on every login, every token renewal, and —
	// because a subaccount switch renews the JWT to refresh its claims —
	// every account switch. The list itself changes on the timescale of
	// support tickets, so a short cache turns all but the first exchange
	// per minute into local work while keeping a permission revocation's
	// propagation delay bounded by the TTL (the same 60 s the frontend
	// already accepts for its own account-list cache).
	accountsMu    sync.Mutex
	accountsCache map[[sha256.Size]byte]accountsCacheEntry
	// Tokens with a background refresh in flight (single-flight per token).
	accountsRefreshing map[[sha256.Size]byte]bool
}

type accountsCacheEntry struct {
	at       time.Time
	accounts []Account
}

// crmAccountsCacheTTL is the freshness window: an entry younger than this is
// served without a second thought.
const crmAccountsCacheTTL = 60 * time.Second

// crmAccountsMaxStale is how far past the TTL an entry may still be SERVED —
// immediately, while a single background flight refreshes it. The 2026-08-24
// chart-load teardown measured this endpoint bimodal at 100 ms / 6 s: every
// cache miss paid the CRM's full latency synchronously, and reloads more than
// a minute apart always missed. The list this cache holds is metadata (login →
// symbol suffix); authorization is enforced per-request by the JWT accounts
// claim, so staleness here can mislabel, never authorize. Ten minutes bounds
// the mislabeling; the synchronous path survives only for tokens never seen.
const crmAccountsMaxStale = 10 * time.Minute

const maxCRMResponseBytes int64 = 8 << 20

// NewCRMClient builds a CRM client for the given base URL, using the default
// account policy.
func NewCRMClient(baseURL string) *CRMClient {
	return NewCRMClientWithPolicy(baseURL, NewAccountPolicy(nil, nil))
}

// NewCRMClientWithPolicy builds a CRM client with an explicit account policy.
func NewCRMClientWithPolicy(baseURL string, policy AccountPolicy) *CRMClient {
	return &CRMClient{
		baseURL: baseURL,
		client:  &http.Client{Timeout: 30 * time.Second},
		policy:  policy,
	}
}

// Policy returns the client's account policy.
func (c *CRMClient) Policy() AccountPolicy { return c.policy }

// crmLoginRequest is the CRM login body.
type crmLoginRequest struct {
	Email      string `json:"email"`
	Password   string `json:"password"`
	RememberMe *bool  `json:"rememberMe,omitempty"`
}

// crmLoginResponse extracts the access token from the CRM login reply.
type crmLoginResponse struct {
	AccessToken string `json:"accessToken"`
}

// crmAccount mirrors CRMRoot { login, typeId }.
type crmAccount struct {
	Login  string `json:"login"`
	TypeID int    `json:"typeId"`
}

// Login authenticates against the CRM and returns the CRM access token.
//
// remember carries the trader's "keep me signed in" choice through to the CRM.
// It matters because the CRM token is what makes a 30-day session possible: the
// gateway JWT lives 30 minutes, and every restore re-mints it by re-presenting
// this token. A token the CRM issued for a short session dies long before the
// SESSION_RESTORE_TTL cookies do, and its expiry reaches the trader as a
// password prompt they explicitly asked not to see. Sent explicitly in both
// directions — false is a real answer here, not an absence, because it is what
// keeps an un-remembered sign-in genuinely short-lived.
func (c *CRMClient) Login(ctx context.Context, email, password string, remember bool) (string, error) {
	body, _ := json.Marshal(crmLoginRequest{Email: email, Password: password, RememberMe: &remember})
	respBody, err := c.post(ctx, PathCRMLogin, body, "")
	if err != nil {
		return "", err
	}
	var lr crmLoginResponse
	if err := json.Unmarshal(respBody, &lr); err != nil {
		return "", fmt.Errorf("crm login decode: %w", err)
	}
	return lr.AccessToken, nil
}

// Accounts fetches the CRM accounts for a bearer token and returns the filtered
// list of MT5 logins used for the JWT accounts claim.
func (c *CRMClient) Accounts(ctx context.Context, crmToken string) ([]string, error) {
	accounts, err := c.AccountsDetailed(ctx, crmToken)
	if err != nil {
		return nil, err
	}
	logins := make([]string, 0, len(accounts))
	for _, a := range accounts {
		logins = append(logins, a.Login)
	}
	return logins, nil
}

// AccountsDetailed fetches the tradable CRM accounts with their symbol suffix,
// so a client does not have to infer the suffix from the account type.
// Answers come from a short per-token cache when fresh (see accountsCache).
func (c *CRMClient) AccountsDetailed(ctx context.Context, crmToken string) ([]Account, error) {
	key := sha256.Sum256([]byte(crmToken))
	if cached, fresh, ok := c.cachedAccounts(key); ok {
		if !fresh {
			// Serve the stale copy NOW and revalidate off the request path.
			// Blocking here was the endpoint's measured 6 s mode; the copy is
			// at most crmAccountsMaxStale old and carries no authorization.
			c.refreshAccountsInBackground(key, crmToken)
		}
		return cached, nil
	}
	out, err := c.fetchAccounts(ctx, crmToken)
	if err != nil {
		return nil, err
	}
	c.storeAccounts(key, out)
	return out, nil
}

// fetchAccounts performs the CRM round trip and policy filtering, without
// touching the cache.
func (c *CRMClient) fetchAccounts(ctx context.Context, crmToken string) ([]Account, error) {
	respBody, err := c.post(ctx, PathCRMAccounts, []byte("{}"), crmToken)
	if err != nil {
		return nil, err
	}
	var accounts []crmAccount
	if err := json.Unmarshal(respBody, &accounts); err != nil {
		return nil, fmt.Errorf("crm accounts decode: %w", err)
	}
	out := make([]Account, 0, len(accounts))
	for _, a := range accounts {
		if a.Login == "" || !c.policy.Allows(a.TypeID) {
			continue
		}
		suffix, known := c.policy.Suffix(a.TypeID)
		out = append(out, Account{
			Login:       a.Login,
			TypeID:      a.TypeID,
			Suffix:      suffix,
			SuffixKnown: known,
			AccountKind: c.policy.Kind(a.TypeID),
		})
	}
	return out, nil
}

// refreshAccountsInBackground revalidates one token's expired entry, at most
// one flight per token at a time. A failed refresh leaves the stale entry
// standing — the next caller past the TTL simply triggers another attempt,
// and the max-stale ceiling in cachedAccounts bounds how long that can go on.
func (c *CRMClient) refreshAccountsInBackground(key [sha256.Size]byte, crmToken string) {
	c.accountsMu.Lock()
	if c.accountsRefreshing == nil {
		c.accountsRefreshing = make(map[[sha256.Size]byte]bool)
	}
	if c.accountsRefreshing[key] {
		c.accountsMu.Unlock()
		return
	}
	c.accountsRefreshing[key] = true
	c.accountsMu.Unlock()

	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		out, err := c.fetchAccounts(ctx, crmToken)

		c.accountsMu.Lock()
		delete(c.accountsRefreshing, key)
		c.accountsMu.Unlock()
		if err == nil {
			c.storeAccounts(key, out)
		}
	}()
}

// cachedAccounts returns a copy of a fresh cache entry. A copy, because
// callers range over and re-slice the result; sharing the backing array would
// let one caller's mutation poison every later cache hit.
func (c *CRMClient) cachedAccounts(key [sha256.Size]byte) (accounts []Account, fresh, ok bool) {
	c.accountsMu.Lock()
	defer c.accountsMu.Unlock()
	entry, ok := c.accountsCache[key]
	if !ok || time.Since(entry.at) >= crmAccountsMaxStale {
		return nil, false, false
	}
	out := make([]Account, len(entry.accounts))
	copy(out, entry.accounts)
	return out, time.Since(entry.at) < crmAccountsCacheTTL, true
}

func (c *CRMClient) storeAccounts(key [sha256.Size]byte, accounts []Account) {
	stored := make([]Account, len(accounts))
	copy(stored, accounts)

	c.accountsMu.Lock()
	defer c.accountsMu.Unlock()
	if c.accountsCache == nil {
		c.accountsCache = make(map[[sha256.Size]byte]accountsCacheEntry)
	}
	// Drop entries past the serving ceiling while we hold the lock: tokens
	// rotate on every renewal, so without pruning the map grows by one dead
	// key per renewal. Pruning at the TTL would defeat stale-while-revalidate.
	for k, e := range c.accountsCache {
		if time.Since(e.at) >= crmAccountsMaxStale {
			delete(c.accountsCache, k)
		}
	}
	c.accountsCache[key] = accountsCacheEntry{at: time.Now(), accounts: stored}
}

func (c *CRMClient) post(ctx context.Context, path string, body []byte, bearer string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+path, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	resp, err := c.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	respBody, err := io.ReadAll(io.LimitReader(resp.Body, maxCRMResponseBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(respBody)) > maxCRMResponseBytes {
		return nil, fmt.Errorf("crm %s: response exceeds %d bytes", path, maxCRMResponseBytes)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, &CRMStatusError{Path: path, Status: resp.StatusCode}
	}
	return respBody, nil
}

// CRMStatusError is a non-2xx answer FROM the CRM itself — as opposed to a
// network failure that never reached it. Callers deciding whether a
// credential is DEAD (401/403: revoke the session) or merely UNPROVEN (5xx,
// timeout: keep it and retry later) need the distinction; conflating the two
// let one CRM hiccup permanently sign a trader out.
type CRMStatusError struct {
	Path   string
	Status int
}

func (e *CRMStatusError) Error() string {
	return "crm " + e.Path + ": status " + strconv.Itoa(e.Status)
}

// Rejected reports whether the CRM definitively refused the credential.
func (e *CRMStatusError) Rejected() bool {
	return e.Status == 401 || e.Status == 403
}

// CRM path constants (kept local to auth to avoid importing the mt5 package).
const (
	PathCRMLogin    = "/client-api/login?version=1.0.0"
	PathCRMAccounts = "/client-api/accounts?version=1.0.0"
)
