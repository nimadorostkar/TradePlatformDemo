package domain

import (
	"context"
	"strconv"
	"sync"
	"time"

	"github.com/nimadorostkar/TradePlatformDemo/backend/internal/auth"
)

// LoginService ports LoginService.cs — orchestrates CRM auth + JWT issuance.
type LoginService struct {
	jwt    *auth.JWT
	crm    *auth.CRMClient
	groups GroupLookup

	groupCacheMu sync.Mutex
	groupCache   map[string]groupCacheEntry
}

// GroupLookup reads the MT5 group an account trades under. Satisfied by
// UserService; nil when the deployment classifies nothing by group.
type GroupLookup interface {
	GroupOf(ctx context.Context, login int64) string
}

type groupCacheEntry struct {
	group string
	at    time.Time
}

// An account's group changes about as often as its product does — rarely, and
// never without the broker doing it deliberately. Long enough that the account
// list does not pay for the lookups, short enough that a real change lands the
// same day.
const groupCacheTTL = 30 * time.Minute

// How many group lookups run at once. Every MT5 call is serialised through the
// connection pool anyway, so this only bounds how much of that pool one account
// list may occupy.
const groupLookupConcurrency = 4

// NewLoginService constructs a LoginService.
func NewLoginService(jwt *auth.JWT, crm *auth.CRMClient) *LoginService {
	return &LoginService{jwt: jwt, crm: crm, groupCache: map[string]groupCacheEntry{}}
}

// WithGroupLookup enables demo/live classification by MT5 group.
func (s *LoginService) WithGroupLookup(lookup GroupLookup) *LoginService {
	s.groups = lookup
	return s
}

// GetLoginDetails performs a CRM login and returns the CRM access token
// (the /api/Authentication/crmlogin flow).
func (s *LoginService) GetLoginDetails(ctx context.Context, email, password string, remember bool) (string, error) {
	return s.crm.Login(ctx, email, password, remember)
}

// GenerateTokenWithCRMAccounts resolves the CRM accounts for a CRM token and
// issues a JWT carrying the filtered account list; falls back to a username
// token when no accounts qualify (the /api/Authentication/login CRM path).
func (s *LoginService) GenerateTokenWithCRMAccounts(ctx context.Context, crmToken, username string) (string, error) {
	logins, err := s.crm.Accounts(ctx, crmToken)
	if err != nil {
		return "", err
	}
	if len(logins) == 0 {
		return s.GenerateOpoSocketToken(username)
	}
	tok, err := s.jwt.GenerateForAccounts(logins)
	if err != nil || tok == "" {
		return s.GenerateOpoSocketToken(username)
	}
	return tok, nil
}

// GenerateOpoSocketToken issues a username-only JWT (the no-CRM login fallback).
func (s *LoginService) GenerateOpoSocketToken(username string) (string, error) {
	return s.jwt.GenerateForUser(username)
}

// Accounts returns the tradable accounts for a CRM token, each with the symbol
// suffix its group uses. Accounts whose type has no configured suffix are
// still listed with suffixKnown=false — the client must not build symbol names
// for them, but hiding them entirely would leave a trader wondering where their
// account went.
func (s *LoginService) Accounts(ctx context.Context, crmToken string) ([]auth.Account, error) {
	accounts, err := s.crm.AccountsDetailed(ctx, crmToken)
	if err != nil {
		return nil, err
	}
	s.classifyByGroup(ctx, accounts)
	return accounts, nil
}

// classifyByGroup fills in AccountKind from each account's MT5 group.
//
// Skipped entirely unless the deployment has named its demo groups, so a
// gateway that classifies nothing pays nothing: the whole point of the
// unclassified default is that it costs neither accuracy nor latency.
func (s *LoginService) classifyByGroup(ctx context.Context, accounts []auth.Account) {
	policy := s.crm.Policy()
	if s.groups == nil || !policy.ClassifiesByGroup() {
		return
	}

	var wg sync.WaitGroup
	slots := make(chan struct{}, groupLookupConcurrency)
	for i := range accounts {
		// A type-level classification, where one exists, is already correct and
		// costs no round trip.
		if accounts[i].AccountKind != "" {
			continue
		}
		wg.Add(1)
		go func(a *auth.Account) {
			defer wg.Done()
			slots <- struct{}{}
			defer func() { <-slots }()
			if group := s.groupOf(ctx, a.Login); group != "" {
				a.AccountKind = policy.KindForGroup(group)
			}
		}(&accounts[i])
	}
	wg.Wait()
}

func (s *LoginService) groupOf(ctx context.Context, login string) string {
	s.groupCacheMu.Lock()
	entry, ok := s.groupCache[login]
	s.groupCacheMu.Unlock()
	if ok && time.Since(entry.at) < groupCacheTTL {
		return entry.group
	}

	id, err := strconv.ParseInt(login, 10, 64)
	if err != nil {
		return ""
	}
	group := s.groups.GroupOf(ctx, id)
	if group == "" {
		// Not cached: a failed read must not pin an account as unclassified for
		// half an hour.
		return ""
	}

	s.groupCacheMu.Lock()
	s.groupCache[login] = groupCacheEntry{group: group, at: time.Now()}
	s.groupCacheMu.Unlock()
	return group
}
