package domain

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/nimadorostkar/TradePlatformDemo/backend/internal/httpapi/response"
	"github.com/nimadorostkar/TradePlatformDemo/backend/internal/mt5"
	"github.com/nimadorostkar/TradePlatformDemo/backend/internal/transform"
)

// UserService ports UserService.cs.
type UserService struct{ c MT5Client }

// NewUserService constructs a UserService.
func NewUserService(c MT5Client) *UserService { return &UserService{c: c} }

// Getbylogin → GET /api/user/get. tv → []TVUserResponse (1 elem); else →
// OBJECT<MT5UserResponse>. (tv match uses case-insensitive compare.)
func (s *UserService) Getbylogin(ctx context.Context, login int64, source string) response.GlobalResponse {
	env, body, ok := fetchGet(ctx, s.c, fmt.Sprintf(mt5.PathUserGet, login))
	if !ok {
		return env
	}
	var root transform.MT5UserResponse
	if err := json.Unmarshal(body, &root); err != nil {
		return env
	}
	if strings.EqualFold(source, SourceTV) {
		tv, err := transform.UserToTV(root.Answer)
		if err != nil {
			return catchError(err)
		}
		env.Data = []transform.TVUserResponse{tv}
	} else {
		env.Data = json.RawMessage(body)
	}
	env.Success = true
	return env
}

// GroupOf returns the MT5 group an account trades under, or "" when the
// record cannot be read.
//
// Used to classify an account as demo or live: this broker's CRM account TYPE
// cannot express it — "ECN Pro" covers both Opoforex\\ECNPRO-USD-B and
// Opoforex\\ECNPRO-SF-USD-B — so the group is the only per-account fact that
// separates them (verified 2026-08-26).
func (s *UserService) GroupOf(ctx context.Context, login int64) string {
	_, body, ok := fetchGet(ctx, s.c, fmt.Sprintf(mt5.PathUserGet, login))
	if !ok {
		return ""
	}
	// Parsed loosely rather than through MT5UserResponse: that shape keeps only
	// ID and Name, and adding Group to it would change every other caller's
	// contract for one field read in one place.
	var root struct {
		Answer struct {
			Group string `json:"Group"`
		} `json:"answer"`
	}
	if err := json.Unmarshal(body, &root); err != nil {
		return ""
	}
	return root.Answer.Group
}

// GetTradeState → GET /api/user/account/get. tv → TVAccountSummary; else →
// OBJECT<AccountSummaryRoot>. (tv match is exact "tv" in the .NET source.)
func (s *UserService) GetTradeState(ctx context.Context, login int64, source string) response.GlobalResponse {
	env, body, ok := fetchGet(ctx, s.c, fmt.Sprintf(mt5.PathUserAccountGet, login))
	if !ok {
		return env
	}
	var root transform.AccountSummaryRoot
	if err := json.Unmarshal(body, &root); err != nil {
		return env
	}
	if source == SourceTV {
		env.Data = transform.AccountToTV(root.Answer)
	} else {
		env.Data = json.RawMessage(body)
	}
	env.Success = true
	return env
}

// GetUserServiceData dispatches WS user methods (RAW_STRING; no TV transform).
// Unknown MethodType → empty path (matches the .NET empty-URL request).
func (s *UserService) GetUserServiceData(ctx context.Context, login int64, methodType string) response.GlobalResponse {
	var path string
	switch methodType {
	case "Getbylogin":
		path = fmt.Sprintf(mt5.PathUserGet, login)
	case "GetTradeState":
		path = fmt.Sprintf(mt5.PathUserAccountGet, login)
	default:
		path = ""
	}
	env, body, ok := fetchGet(ctx, s.c, path)
	if ok {
		env.Data = json.RawMessage(body)
	}
	return env
}
