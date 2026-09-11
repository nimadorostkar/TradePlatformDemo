package main

import (
	"context"
	"errors"
	"testing"
)

func TestSeedUserCarriesAFullProfile(t *testing.T) {
	s := newMemStore()
	u, token, err := s.Authenticate(context.Background(), seedEmail, seedPassword)
	if err != nil {
		t.Fatal(err)
	}
	if u.Phone != seedProfile.Phone || u.Country != "GB" || u.City != "London" || u.Timezone != "Europe/London" || u.Language != "en" {
		t.Fatalf("seed profile = %+v", u.Profile)
	}
	if u.KYCStatus != kycVerified {
		t.Fatalf("seed KYC = %q, want verified", u.KYCStatus)
	}
	if again, ok := s.UserBySession(context.Background(), token); !ok || again.Country != "GB" {
		t.Fatal("session lookup lost the profile")
	}
}

func TestRegisterNormalisesAndValidatesProfile(t *testing.T) {
	s := newMemStore()
	ctx := context.Background()

	u, err := s.Register(ctx, "New@Example.com", "long-enough-pw", Profile{Name: "  Ada ", Phone: "+1 (415) 555-0100", Country: "us", City: "SF", Timezone: "America/Los_Angeles"})
	if err != nil {
		t.Fatal(err)
	}
	if u.Name != "Ada" || u.Country != "US" || u.Language != "en" || u.Timezone != "America/Los_Angeles" || u.KYCStatus != kycUnverified {
		t.Fatalf("registered = %+v kyc=%s", u.Profile, u.KYCStatus)
	}
	if u.Email != "new@example.com" {
		t.Fatalf("email not normalised: %s", u.Email)
	}
	accounts, _ := s.Accounts(ctx, u.ID)
	if len(accounts) != 1 || accounts[0].Balance != demoStartBalance {
		t.Fatalf("accounts = %+v", accounts)
	}

	bad := []Profile{
		{Phone: "call me"},
		{Country: "USA"},
		{Timezone: "Mars/Olympus"},
		{Language: "English Language"},
	}
	for _, p := range bad {
		if _, err := s.Register(ctx, "x@example.com", "long-enough-pw", p); !errors.Is(err, errInvalidInput) {
			t.Fatalf("profile %+v accepted (err=%v)", p, err)
		}
	}
	if _, err := s.Register(ctx, "new@example.com", "long-enough-pw", Profile{}); !errors.Is(err, errEmailTaken) {
		t.Fatalf("duplicate email → %v", err)
	}
}

func TestUpdateProfileKYCAndPassword(t *testing.T) {
	s := newMemStore()
	ctx := context.Background()
	u, token, _ := s.Authenticate(ctx, seedEmail, seedPassword)

	updated, err := s.UpdateProfile(ctx, u.ID, Profile{Name: "Demo T.", Country: "de", City: "Berlin", Timezone: "Europe/Berlin", Language: "de"})
	if err != nil {
		t.Fatal(err)
	}
	if updated.Name != "Demo T." || updated.Country != "DE" || updated.Phone != "" || updated.UpdatedAt.Before(u.UpdatedAt) {
		t.Fatalf("updated = %+v", updated)
	}
	if _, err := s.UpdateProfile(ctx, u.ID, Profile{Country: "Germany"}); !errors.Is(err, errInvalidInput) {
		t.Fatal("invalid country accepted on update")
	}
	if _, err := s.UpdateProfile(ctx, 999, Profile{}); !errors.Is(err, errNotFound) {
		t.Fatal("unknown user accepted on update")
	}

	if err := s.SetKYC(ctx, u.ID, "maybe"); !errors.Is(err, errInvalidInput) {
		t.Fatal("bad KYC status accepted")
	}
	if err := s.SetKYC(ctx, u.ID, kycPending); err != nil {
		t.Fatal(err)
	}
	if got, _ := s.UserByID(ctx, u.ID); got.KYCStatus != kycPending {
		t.Fatalf("kyc = %s", got.KYCStatus)
	}

	if err := s.ChangePassword(ctx, u.ID, "wrong", "another-long-pw"); !errors.Is(err, errBadCredentials) {
		t.Fatalf("wrong current password → %v", err)
	}
	if err := s.ChangePassword(ctx, u.ID, seedPassword, "short"); !errors.Is(err, errInvalidInput) {
		t.Fatalf("short new password → %v", err)
	}
	if err := s.ChangePassword(ctx, u.ID, seedPassword, "another-long-pw"); err != nil {
		t.Fatal(err)
	}
	if _, ok := s.UserBySession(ctx, token); ok {
		t.Fatal("old session survived a password change")
	}
	if _, _, err := s.Authenticate(ctx, seedEmail, seedPassword); !errors.Is(err, errBadCredentials) {
		t.Fatal("old password still works")
	}
	if _, _, err := s.Authenticate(ctx, seedEmail, "another-long-pw"); err != nil {
		t.Fatal("new password refused")
	}
}

func TestBrokerResetEmptiesTheBookAndRefunds(t *testing.T) {
	b, p, users := newTestBroker(t)
	submit(t, b, map[string]any{"Action": "200", "Login": "1010", "Symbol": "EURUSD", "Type": 0, "Volume": 10000})
	submit(t, b, map[string]any{"Action": "201", "Login": "1010", "Symbol": "EURUSD", "Type": 2, "Volume": 10000, "PriceOrder": 1.09})
	p.set("EURUSD", 1.09000, 1.09010)
	submit(t, b, map[string]any{"Action": "200", "Login": "1010", "Symbol": "EURUSD", "Type": 1, "Volume": 10000, "Position": 600001})
	if a, _ := users.AccountByLogin(nil, 1010); a.Balance == demoStartBalance {
		t.Fatal("balance unchanged by a losing close")
	}

	b.Reset(1010, demoStartBalance)
	f := b.Summary(1010)
	if f.Positions != 0 || f.Orders != 0 || f.Equity != demoStartBalance || f.Margin != 0 {
		t.Fatalf("after reset: %+v", f)
	}
	if b.History(1010, 0, 0, 0, 0) != `{"retcode":"0 Done","answer":[]}` || b.Deals(1010, 0, 0, 0, 0) != `{"retcode":"0 Done","answer":[]}` {
		t.Fatal("history or deals survived the reset")
	}
	if a, _ := users.AccountByLogin(nil, 1010); a.Balance != demoStartBalance {
		t.Fatalf("store balance after reset = %v", a.Balance)
	}
}
