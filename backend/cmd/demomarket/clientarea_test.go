package main

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestOpenAccountAndTransactionsInMemory(t *testing.T) {
	ctx := context.Background()
	s := newMemStore()
	u, err := s.Register(ctx, "wallet@example.com", "long-enough-password", Profile{Name: "W"})
	if err != nil {
		t.Fatal(err)
	}
	demo, err := s.OpenAccount(ctx, u.ID, 58, accountKindDemo, "USD", demoStartBalance)
	if err != nil {
		t.Fatal(err)
	}
	if demo.Kind != accountKindDemo || demo.Balance != demoStartBalance || demo.TypeID != 58 {
		t.Fatalf("demo account = %+v", demo)
	}
	if _, err := s.OpenAccount(ctx, u.ID, 57, "paper", "USD", 0); err == nil {
		t.Fatal("an unknown kind must be refused")
	}
	accounts, _ := s.Accounts(ctx, u.ID)
	if len(accounts) != 2 {
		t.Fatalf("expected the sign-up account plus the new one, got %d", len(accounts))
	}

	for i, kind := range []string{"deposit", "withdrawal", "transfer_out"} {
		if _, err := s.RecordTransaction(ctx, Transaction{UserID: u.ID, Login: demo.Login, Kind: kind, Amount: float64(i + 1), Currency: "USD"}); err != nil {
			t.Fatal(err)
		}
	}
	txs, _ := s.Transactions(ctx, u.ID, 10)
	if len(txs) != 3 || txs[0].Kind != "transfer_out" || txs[2].Kind != "deposit" || txs[0].Status != "completed" {
		t.Fatalf("transactions newest first = %+v", txs)
	}
	other, _ := s.Register(ctx, "other@example.com", "long-enough-password", Profile{})
	if txs, _ := s.Transactions(ctx, other.ID, 10); len(txs) != 0 {
		t.Fatal("transactions leaked across users")
	}
}

func TestVerificationLevelsAndLimits(t *testing.T) {
	u := &User{KYCStatus: kycUnverified, AddressStatus: kycUnverified}
	if verificationLevel(u) != verificationNone {
		t.Fatal("a fresh user has no level")
	}
	u.Name, u.Profile = "A", Profile{Name: "A", Phone: "+1 555 0100", Country: "US", City: "NYC"}
	if verificationLevel(u) != verificationProfile {
		t.Fatal("a complete profile is level 1")
	}
	u.KYCStatus = kycVerified
	if verificationLevel(u) != verificationIdentity {
		t.Fatal("verified identity is level 2")
	}
	u.AddressStatus = kycVerified
	if verificationLevel(u) != verificationAddress {
		t.Fatal("verified address is level 3")
	}

	dto := verificationDTO(u, 150)
	if dto["depositLimit"] != nil || dto["verified"] != true || dto["stepsComplete"] != 3 {
		t.Fatalf("fully verified dto = %v", dto)
	}
	u.AddressStatus = kycUnverified
	dto = verificationDTO(u, 150)
	if dto["depositLimit"] != 20000.0 || dto["depositRemaining"] != 19850.0 {
		t.Fatalf("level-2 limits = %v / %v", dto["depositLimit"], dto["depositRemaining"])
	}
}

func TestIdentityAndAddressSubmission(t *testing.T) {
	ctx := context.Background()
	s := newMemStore()
	u, _ := s.Register(ctx, "kyc@example.com", "long-enough-password", Profile{Name: "K", Phone: "+44 20 7946 0958", Country: "GB", City: "London"})

	if _, err := s.SubmitIdentity(ctx, u.ID, "passport", "X1", "1990-01-01"); err == nil {
		t.Fatal("a two-character document number must be refused")
	}
	tooYoung := time.Now().AddDate(-17, 0, 0).Format("2006-01-02")
	if _, err := s.SubmitIdentity(ctx, u.ID, "passport", "AB123456", tooYoung); err == nil || !strings.Contains(err.Error(), "18") {
		t.Fatalf("minors must be refused, got %v", err)
	}
	updated, err := s.SubmitIdentity(ctx, u.ID, "Passport", "AB123456", "1990-01-01")
	if err != nil {
		t.Fatal(err)
	}
	if updated.KYCStatus != kycPending || updated.IdentityDocType != "passport" {
		t.Fatalf("after submission: %+v", updated)
	}
	if got := maskDocument(updated.IdentityDocNumber); got != "****3456" {
		t.Fatalf("masked document = %q", got)
	}

	if _, err := s.SubmitAddress(ctx, u.ID, "1 Main St", "London", "SW1A 1AA", "gb"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SubmitAddress(ctx, u.ID, "x", "London", "SW1A 1AA", "GB"); err == nil {
		t.Fatal("a one-character address must be refused")
	}
	fresh, _ := s.UserByID(ctx, u.ID)
	if fresh.AddressStatus != kycVerified || fresh.Country != "GB" || fresh.PostalCode != "SW1A 1AA" {
		t.Fatalf("address not stored: %+v", fresh)
	}
}

func TestTradingPasswordRules(t *testing.T) {
	ctx := context.Background()
	s := newMemStore()
	u, _ := s.Register(ctx, "tp@example.com", "long-enough-password", Profile{})
	accounts, _ := s.Accounts(ctx, u.ID)
	login := accounts[0].Login
	for _, weak := range []string{"short1A", "alllowercase1", "ALLUPPERCASE1", "NoDigitsHere"} {
		if err := s.SetTradingPassword(ctx, u.ID, login, weak); err == nil {
			t.Fatalf("%q must be refused", weak)
		}
	}
	if err := s.SetTradingPassword(ctx, u.ID, login, "Str0ngPassword"); err != nil {
		t.Fatal(err)
	}
	if err := s.SetTradingPassword(ctx, u.ID+1, login, "Str0ngPassword"); err == nil {
		t.Fatal("another user's account must not be writable")
	}
	accounts, _ = s.Accounts(ctx, u.ID)
	if !accounts[0].HasTradingPassword {
		t.Fatal("HasTradingPassword not reported")
	}
}
