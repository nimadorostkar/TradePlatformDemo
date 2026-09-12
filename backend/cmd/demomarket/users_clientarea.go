package main

// The user store's client-area operations: opening accounts, wallet
// transactions, the verification steps and per-account trading passwords.
// Kept apart from users.go so the sign-in/sign-up core stays readable; both
// backends implement every method.

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"golang.org/x/crypto/bcrypt"
)

var (
	dateOfBirthPattern = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)
	postalCodePattern  = regexp.MustCompile(`^[A-Za-z0-9 -]{2,12}$`)
)

func validAccountKind(kind string) bool {
	return kind == accountKindReal || kind == accountKindDemo
}

// normalizeIdentity validates the identity step. The document number is
// kept as typed but must look like one; the date must be a real calendar
// day for someone at least 18 — the one rule every broker applies.
func normalizeIdentity(docType, docNumber, dob string) (string, string, string, error) {
	docType = strings.ToLower(strings.TrimSpace(docType))
	docNumber = strings.TrimSpace(docNumber)
	dob = strings.TrimSpace(dob)
	switch docType {
	case "passport", "id_card", "driving_licence":
	default:
		return "", "", "", fmt.Errorf("%w: document type must be passport, id_card or driving_licence", errInvalidInput)
	}
	if len(docNumber) < 4 || len(docNumber) > 32 {
		return "", "", "", fmt.Errorf("%w: document number", errInvalidInput)
	}
	if !dateOfBirthPattern.MatchString(dob) {
		return "", "", "", fmt.Errorf("%w: date of birth must be YYYY-MM-DD", errInvalidInput)
	}
	born, err := time.Parse("2006-01-02", dob)
	if err != nil {
		return "", "", "", fmt.Errorf("%w: date of birth", errInvalidInput)
	}
	if born.After(time.Now().AddDate(-18, 0, 0)) {
		return "", "", "", fmt.Errorf("%w: you must be at least 18", errInvalidInput)
	}
	return docType, docNumber, dob, nil
}

func normalizeAddress(address, city, postalCode, country string) (string, string, string, string, error) {
	address = strings.TrimSpace(address)
	city = strings.TrimSpace(city)
	postalCode = strings.TrimSpace(postalCode)
	country = strings.ToUpper(strings.TrimSpace(country))
	if len(address) < 3 || len(address) > 160 {
		return "", "", "", "", fmt.Errorf("%w: address", errInvalidInput)
	}
	if city == "" || len(city) > 80 {
		return "", "", "", "", fmt.Errorf("%w: city", errInvalidInput)
	}
	if !postalCodePattern.MatchString(postalCode) {
		return "", "", "", "", fmt.Errorf("%w: postal code", errInvalidInput)
	}
	if !countryPattern.MatchString(country) {
		return "", "", "", "", fmt.Errorf("%w: country must be a two-letter ISO code", errInvalidInput)
	}
	return address, city, postalCode, country, nil
}

func validateTradingPassword(password string) error {
	if len(password) < 8 || len(password) > 64 {
		return fmt.Errorf("%w: trading password must be 8–64 characters", errInvalidInput)
	}
	var upper, lower, digit bool
	for _, r := range password {
		switch {
		case r >= 'A' && r <= 'Z':
			upper = true
		case r >= 'a' && r <= 'z':
			lower = true
		case r >= '0' && r <= '9':
			digit = true
		}
	}
	if !upper || !lower || !digit {
		return fmt.Errorf("%w: trading password needs upper and lower case letters and a digit", errInvalidInput)
	}
	return nil
}

// ── PostgreSQL ──────────────────────────────────────────────────────────────

func (s *pgStore) OpenAccount(ctx context.Context, userID int64, typeID int, kind, currency string, balance float64) (*Account, error) {
	if !validAccountKind(kind) {
		return nil, fmt.Errorf("%w: kind", errInvalidInput)
	}
	var a Account
	err := s.pool.QueryRow(ctx, `INSERT INTO accounts (login, user_id, type_id, currency, balance, kind)
		VALUES (nextval('account_login_seq'), $1, $2, $3, $4, $5) RETURNING `+accountColumns,
		userID, typeID, currency, balance, kind).Scan(accountFields(&a)...)
	if err != nil {
		return nil, err
	}
	return &a, nil
}

func (s *pgStore) SetTradingPassword(ctx context.Context, userID, login int64, password string) error {
	if err := validateTradingPassword(password); err != nil {
		return err
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return err
	}
	tag, err := s.pool.Exec(ctx, `UPDATE accounts SET trading_password_hash = $3 WHERE login = $1 AND user_id = $2`, login, userID, string(hash))
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return errNotFound
	}
	return nil
}

func (s *pgStore) SubmitIdentity(ctx context.Context, userID int64, docType, docNumber, dob string) (*User, error) {
	docType, docNumber, dob, err := normalizeIdentity(docType, docNumber, dob)
	if err != nil {
		return nil, err
	}
	u, err := scanUser(s.pool.QueryRow(ctx, `UPDATE users SET identity_doc_type = $2, identity_doc_number = $3, date_of_birth = $4,
		kyc_status = CASE WHEN kyc_status = 'verified' THEN kyc_status ELSE 'pending' END, updated_at = now()
		WHERE id = $1 RETURNING `+userColumns, userID, docType, docNumber, dob))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, errNotFound
	}
	return u, err
}

func (s *pgStore) SubmitAddress(ctx context.Context, userID int64, address, city, postalCode, country string) (*User, error) {
	address, city, postalCode, country, err := normalizeAddress(address, city, postalCode, country)
	if err != nil {
		return nil, err
	}
	u, err := scanUser(s.pool.QueryRow(ctx, `UPDATE users SET address = $2, city = $3, postal_code = $4, country = $5,
		address_status = 'verified', updated_at = now() WHERE id = $1 RETURNING `+userColumns,
		userID, address, city, postalCode, country))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, errNotFound
	}
	return u, err
}

func (s *pgStore) RecordTransaction(ctx context.Context, t Transaction) (*Transaction, error) {
	err := s.pool.QueryRow(ctx, `INSERT INTO transactions (user_id, login, kind, amount, currency, method, status, counterpart, comment)
		VALUES ($1,$2,$3,$4,$5,$6,'completed',$7,$8) RETURNING id, status, created_at`,
		t.UserID, t.Login, t.Kind, t.Amount, t.Currency, t.Method, t.Counterpart, t.Comment).Scan(&t.ID, &t.Status, &t.CreatedAt)
	if err != nil {
		return nil, err
	}
	return &t, nil
}

func (s *pgStore) Transactions(ctx context.Context, userID int64, limit int) ([]Transaction, error) {
	rows, err := s.pool.Query(ctx, `SELECT id, user_id, login, kind, amount, currency, method, status, counterpart, comment, created_at
		FROM transactions WHERE user_id = $1 ORDER BY id DESC LIMIT $2`, userID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Transaction{}
	for rows.Next() {
		var t Transaction
		if err := rows.Scan(&t.ID, &t.UserID, &t.Login, &t.Kind, &t.Amount, &t.Currency, &t.Method, &t.Status, &t.Counterpart, &t.Comment, &t.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// ── In-memory ───────────────────────────────────────────────────────────────

func (s *memStore) OpenAccount(_ context.Context, userID int64, typeID int, kind, currency string, balance float64) (*Account, error) {
	if !validAccountKind(kind) {
		return nil, fmt.Errorf("%w: kind", errInvalidInput)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.users[userID]; !ok {
		return nil, errNotFound
	}
	a := Account{Login: s.nextLogin, UserID: userID, TypeID: typeID, Currency: currency, Balance: balance, Kind: kind, CreatedAt: time.Now()}
	s.nextLogin++
	s.accounts[a.Login] = a
	return &a, nil
}

func (s *memStore) SetTradingPassword(_ context.Context, userID, login int64, password string) error {
	if err := validateTradingPassword(password); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	a, ok := s.accounts[login]
	if !ok || a.UserID != userID {
		return errNotFound
	}
	a.HasTradingPassword = true
	s.accounts[login] = a
	return nil
}

func (s *memStore) SubmitIdentity(_ context.Context, userID int64, docType, docNumber, dob string) (*User, error) {
	docType, docNumber, dob, err := normalizeIdentity(docType, docNumber, dob)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	u, ok := s.users[userID]
	if !ok {
		return nil, errNotFound
	}
	u.IdentityDocType, u.IdentityDocNumber, u.DateOfBirth = docType, docNumber, dob
	if u.KYCStatus != kycVerified {
		u.KYCStatus = kycPending
	}
	u.UpdatedAt = time.Now()
	copy := *u
	return &copy, nil
}

func (s *memStore) SubmitAddress(_ context.Context, userID int64, address, city, postalCode, country string) (*User, error) {
	address, city, postalCode, country, err := normalizeAddress(address, city, postalCode, country)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	u, ok := s.users[userID]
	if !ok {
		return nil, errNotFound
	}
	u.Address, u.City, u.PostalCode, u.Country = address, city, postalCode, country
	u.AddressStatus = kycVerified
	u.UpdatedAt = time.Now()
	copy := *u
	return &copy, nil
}

func (s *memStore) RecordTransaction(_ context.Context, t Transaction) (*Transaction, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.nextTxID++
	t.ID = s.nextTxID
	t.Status = "completed"
	t.CreatedAt = time.Now()
	s.transactions = append(s.transactions, t)
	return &t, nil
}

func (s *memStore) Transactions(_ context.Context, userID int64, limit int) ([]Transaction, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := []Transaction{}
	for i := len(s.transactions) - 1; i >= 0 && len(out) < limit; i-- {
		if s.transactions[i].UserID == userID {
			out = append(out, s.transactions[i])
		}
	}
	return out, nil
}
