package main

// User management for the demo CRM: registered users with bcrypt password
// hashes, the demo accounts they own, and persisted sessions — in PostgreSQL
// (USERS_DSN) or, for a laptop without a database, an in-memory store with
// the same seed. The gateway and the terminal speak to it only through the
// CRM wire contract (/client-api/login, /client-api/accounts) plus the
// registration and admin endpoints added here; passwords never leave this
// process and are never stored in clear.

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/crypto/bcrypt"
)

var (
	errBadCredentials = errors.New("invalid credentials")
	errDisabled       = errors.New("account disabled")
	errEmailTaken     = errors.New("email already registered")
	errInvalidInput   = errors.New("invalid input")
	errNotFound       = errors.New("not found")
)

const (
	sessionTTL       = 30 * 24 * time.Hour
	minPasswordLen   = 8
	demoAccountType  = 57 // the account type every self-registered user gets
	demoStartBalance = 10000.00
)

var emailPattern = regexp.MustCompile(`^[^\s@]+@[^\s@]+\.[^\s@]+$`)

type User struct {
	ID          int64
	Email       string
	Name        string
	Enabled     bool
	CreatedAt   time.Time
	LastLoginAt *time.Time
	Profile
	// KYCStatus is the identity-verification state a real CRM would carry:
	// unverified (fresh sign-up), pending (documents submitted), verified.
	// The client area's identity step moves it to pending; the demo's review
	// (or the admin API) moves it on from there.
	KYCStatus string
	// Identity step (what the trader submitted) and the residential-address
	// step, with its own status. See clientarea.go for the levels they unlock.
	DateOfBirth       string
	IdentityDocType   string
	IdentityDocNumber string
	Address           string
	PostalCode        string
	AddressStatus     string // unverified | verified
	UpdatedAt         time.Time
}

// Profile is the part of a user record the user may edit themselves.
type Profile struct {
	Name     string
	Phone    string // E.164-ish, optional
	Country  string // ISO 3166-1 alpha-2, optional
	City     string
	Language string // BCP 47 tag, "en" by default
	Timezone string // IANA zone, "UTC" by default
}

const (
	kycUnverified = "unverified"
	kycPending    = "pending"
	kycVerified   = "verified"
)

var (
	phonePattern    = regexp.MustCompile(`^\+?[0-9][0-9 ()-]{5,19}$`)
	countryPattern  = regexp.MustCompile(`^[A-Z]{2}$`)
	languagePattern = regexp.MustCompile(`^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$`)
)

// normalizeProfile trims, canonicalises and validates the editable fields;
// blanks keep their defaults. Timezones must be real IANA zones so the
// terminal can format times with them.
func normalizeProfile(p Profile) (Profile, error) {
	p.Name = strings.TrimSpace(p.Name)
	p.Phone = strings.TrimSpace(p.Phone)
	p.Country = strings.ToUpper(strings.TrimSpace(p.Country))
	p.City = strings.TrimSpace(p.City)
	p.Language = strings.TrimSpace(p.Language)
	p.Timezone = strings.TrimSpace(p.Timezone)
	if len(p.Name) > 80 {
		return p, fmt.Errorf("%w: name", errInvalidInput)
	}
	if p.Phone != "" && !phonePattern.MatchString(p.Phone) {
		return p, fmt.Errorf("%w: phone", errInvalidInput)
	}
	if p.Country != "" && !countryPattern.MatchString(p.Country) {
		return p, fmt.Errorf("%w: country must be a two-letter ISO code", errInvalidInput)
	}
	if len(p.City) > 80 {
		return p, fmt.Errorf("%w: city", errInvalidInput)
	}
	if p.Language == "" {
		p.Language = "en"
	} else if !languagePattern.MatchString(p.Language) {
		return p, fmt.Errorf("%w: language", errInvalidInput)
	}
	if p.Timezone == "" {
		p.Timezone = "UTC"
	} else if _, err := time.LoadLocation(p.Timezone); err != nil {
		return p, fmt.Errorf("%w: timezone", errInvalidInput)
	}
	return p, nil
}

func validKYC(status string) bool {
	return status == kycUnverified || status == kycPending || status == kycVerified
}

type Account struct {
	Login    int64
	UserID   int64
	TypeID   int
	Currency string
	Balance  float64
	// Kind is real or demo in the client area's sense: a real account starts
	// empty and is funded through Deposit; a demo one opens with virtual
	// money. Nothing here is real money either way — the whole platform is a
	// demo — but the two flows differ and traders expect both.
	Kind               string
	HasTradingPassword bool
	CreatedAt          time.Time
}

const (
	accountKindReal = "real"
	accountKindDemo = "demo"
)

// Transaction is one wallet movement: a deposit into or a withdrawal from a
// trading account, or one leg of a transfer between two of the user's own.
type Transaction struct {
	ID          int64
	UserID      int64
	Login       int64
	Kind        string // deposit | withdrawal | transfer_in | transfer_out
	Amount      float64
	Currency    string
	Method      string
	Status      string // completed
	Counterpart int64  // the other account of a transfer, else 0
	Comment     string
	CreatedAt   time.Time
}

// UserStore is what the CRM endpoints need; both backends implement it.
type UserStore interface {
	// Authenticate checks the password and opens a session; the returned
	// token is the CRM access token the client keeps.
	Authenticate(ctx context.Context, email, password string) (*User, string, error)
	Register(ctx context.Context, email, password string, profile Profile) (*User, error)
	// UpdateProfile replaces the user-editable fields and returns the record.
	UpdateProfile(ctx context.Context, userID int64, profile Profile) (*User, error)
	// ChangePassword requires the current password and revokes every other
	// session of the user.
	ChangePassword(ctx context.Context, userID int64, current, next string) error
	SetKYC(ctx context.Context, userID int64, status string) error
	// UserBySession resolves a CRM token; ok=false when unknown or expired.
	UserBySession(ctx context.Context, token string) (*User, bool)
	Accounts(ctx context.Context, userID int64) ([]Account, error)
	AccountByLogin(ctx context.Context, login int64) (*Account, bool)
	UserByID(ctx context.Context, id int64) (*User, bool)
	ListUsers(ctx context.Context) ([]User, error)
	SetEnabled(ctx context.Context, userID int64, enabled bool) error
	// SetBalance records the balance the demo broker has settled for a
	// trading account; the CRM's account list reports it.
	SetBalance(ctx context.Context, login int64, balance float64) error
	// OpenAccount adds a trading account for the user; the login comes from
	// the account sequence.
	OpenAccount(ctx context.Context, userID int64, typeID int, kind, currency string, balance float64) (*Account, error)
	// SetTradingPassword stores the bcrypt hash of a per-account platform
	// password (informational in this demo: the terminal signs in by token).
	SetTradingPassword(ctx context.Context, userID, login int64, password string) error
	// SubmitIdentity records the identity step and moves KYC to pending.
	SubmitIdentity(ctx context.Context, userID int64, docType, docNumber, dateOfBirth string) (*User, error)
	// SubmitAddress records and (in this demo) verifies the residential address.
	SubmitAddress(ctx context.Context, userID int64, address, city, postalCode, country string) (*User, error)
	RecordTransaction(ctx context.Context, t Transaction) (*Transaction, error)
	// Transactions lists the user's wallet movements, newest first.
	Transactions(ctx context.Context, userID int64, limit int) ([]Transaction, error)
	Name() string
}

func normalizeEmail(email string) string { return strings.ToLower(strings.TrimSpace(email)) }

func validateRegistration(email, password string) error {
	if !emailPattern.MatchString(email) || len(email) > 254 {
		return fmt.Errorf("%w: email", errInvalidInput)
	}
	return validatePassword(password)
}

func validatePassword(password string) error {
	if len(password) < minPasswordLen || len(password) > 128 {
		return fmt.Errorf("%w: password must be %d–128 characters", errInvalidInput, minPasswordLen)
	}
	return nil
}

func newSessionToken() (token, hash string, err error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", "", err
	}
	token = hex.EncodeToString(raw)
	return token, hashToken(token), nil
}

func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// The seed: the demo user every environment starts with, so the documented
// sign-in works on a fresh database and the contract suite's fixed logins
// (1010 owned, 9999 foreign) hold.
const (
	seedEmail    = "trader@example.com"
	seedPassword = "correct-password"
	seedName     = "Demo Trader"
)

// seedProfile is the demo trader's filled-in profile, so every screen that
// shows user data has something to show on a fresh database.
var seedProfile = Profile{Name: seedName, Phone: "+44 20 7946 0958", Country: "GB", City: "London", Language: "en", Timezone: "Europe/London"}

var seedAccounts = []Account{
	{Login: 1010, TypeID: 57, Currency: "USD", Balance: demoStartBalance},
	{Login: 2020, TypeID: 58, Currency: "USD", Balance: 25000},
	{Login: 3030, TypeID: 11, Currency: "USD", Balance: 5000},
}

// ── PostgreSQL ──────────────────────────────────────────────────────────────

type pgStore struct{ pool *pgxpool.Pool }

const usersSchema = `
CREATE TABLE IF NOT EXISTS users (
  id            BIGSERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL DEFAULT '',
  enabled       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS accounts (
  login      BIGINT PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type_id    INTEGER NOT NULL DEFAULT 57,
  currency   TEXT NOT NULL DEFAULT 'USD',
  balance    NUMERIC(18,2) NOT NULL DEFAULT 10000,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS accounts_user_id ON accounts(user_id);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_id ON sessions(user_id);
CREATE SEQUENCE IF NOT EXISTS account_login_seq START WITH 100001;
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS phone      TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS country    TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS city       TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS language   TEXT NOT NULL DEFAULT 'en',
  ADD COLUMN IF NOT EXISTS timezone   TEXT NOT NULL DEFAULT 'UTC',
  ADD COLUMN IF NOT EXISTS kyc_status TEXT NOT NULL DEFAULT 'unverified',
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS date_of_birth       TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS identity_doc_type   TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS identity_doc_number TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS address             TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS postal_code         TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS address_status      TEXT NOT NULL DEFAULT 'unverified';
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS kind                  TEXT NOT NULL DEFAULT 'real',
  ADD COLUMN IF NOT EXISTS trading_password_hash TEXT NOT NULL DEFAULT '';
CREATE TABLE IF NOT EXISTS transactions (
  id           BIGSERIAL PRIMARY KEY,
  user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  login        BIGINT NOT NULL,
  kind         TEXT NOT NULL,
  amount       NUMERIC(18,2) NOT NULL,
  currency     TEXT NOT NULL DEFAULT 'USD',
  method       TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'completed',
  counterpart  BIGINT NOT NULL DEFAULT 0,
  comment      TEXT NOT NULL DEFAULT '',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS transactions_user_id ON transactions(user_id, id DESC);
`

func openPGStore(ctx context.Context, dsn string) (*pgStore, error) {
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		return nil, err
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, err
	}
	if _, err := pool.Exec(ctx, usersSchema); err != nil {
		pool.Close()
		return nil, fmt.Errorf("migrate users schema: %w", err)
	}
	s := &pgStore{pool: pool}
	if err := s.seed(ctx); err != nil {
		pool.Close()
		return nil, err
	}
	return s, nil
}

func (s *pgStore) Name() string { return "postgresql" }

func (s *pgStore) seed(ctx context.Context) error {
	var n int
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM users`).Scan(&n); err != nil {
		return err
	}
	if n > 0 {
		return nil
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(seedPassword), bcrypt.DefaultCost)
	if err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var id int64
	if err := tx.QueryRow(ctx, `INSERT INTO users (email, password_hash, name, phone, country, city, language, timezone, kyc_status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
		seedEmail, string(hash), seedProfile.Name, seedProfile.Phone, seedProfile.Country, seedProfile.City, seedProfile.Language, seedProfile.Timezone, kycVerified).Scan(&id); err != nil {
		return err
	}
	for _, a := range seedAccounts {
		if _, err := tx.Exec(ctx, `INSERT INTO accounts (login, user_id, type_id, currency, balance, kind) VALUES ($1,$2,$3,$4,$5,'real')`, a.Login, id, a.TypeID, a.Currency, a.Balance); err != nil {
			return err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	log.Printf("users: seeded %s with %d accounts", seedEmail, len(seedAccounts))
	return nil
}

func scanUser(row pgx.Row) (*User, error) {
	var u User
	if err := row.Scan(userFields(&u)...); err != nil {
		return nil, err
	}
	return &u, nil
}

// userColumns and userFields are the one column list and its scan targets;
// every user query goes through them so a new column is added in one place.
const userColumns = `id, email, name, enabled, created_at, last_login_at, phone, country, city, language, timezone, kyc_status, updated_at, date_of_birth, identity_doc_type, identity_doc_number, address, postal_code, address_status`

func userFields(u *User) []any {
	return []any{&u.ID, &u.Email, &u.Name, &u.Enabled, &u.CreatedAt, &u.LastLoginAt, &u.Phone, &u.Country, &u.City, &u.Language, &u.Timezone, &u.KYCStatus, &u.UpdatedAt,
		&u.DateOfBirth, &u.IdentityDocType, &u.IdentityDocNumber, &u.Address, &u.PostalCode, &u.AddressStatus}
}

const accountColumns = `login, user_id, type_id, currency, balance, kind, trading_password_hash <> '', created_at`

func accountFields(a *Account) []any {
	return []any{&a.Login, &a.UserID, &a.TypeID, &a.Currency, &a.Balance, &a.Kind, &a.HasTradingPassword, &a.CreatedAt}
}

func qualifiedUserColumns(alias string) string {
	parts := strings.Split(userColumns, ", ")
	for i, c := range parts {
		parts[i] = alias + "." + c
	}
	return strings.Join(parts, ", ")
}

func (s *pgStore) Authenticate(ctx context.Context, email, password string) (*User, string, error) {
	email = normalizeEmail(email)
	var u User
	var hash string
	err := s.pool.QueryRow(ctx, `SELECT `+userColumns+`, password_hash FROM users WHERE email = $1`, email).
		Scan(append(userFields(&u), &hash)...)
	if errors.Is(err, pgx.ErrNoRows) {
		// Same cost as a real comparison, so timing does not reveal which
		// emails exist.
		_ = bcrypt.CompareHashAndPassword([]byte("$2a$10$0123456789012345678901uZ4jn3q4pM0fYbF0O7KM0oTz6aMyeYq"), []byte(password))
		return nil, "", errBadCredentials
	}
	if err != nil {
		return nil, "", err
	}
	if bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)) != nil {
		return nil, "", errBadCredentials
	}
	if !u.Enabled {
		return nil, "", errDisabled
	}
	token, tokenHash, err := newSessionToken()
	if err != nil {
		return nil, "", err
	}
	now := time.Now()
	if _, err := s.pool.Exec(ctx, `INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1,$2,$3)`, tokenHash, u.ID, now.Add(sessionTTL)); err != nil {
		return nil, "", err
	}
	_, _ = s.pool.Exec(ctx, `UPDATE users SET last_login_at = $2 WHERE id = $1`, u.ID, now)
	_, _ = s.pool.Exec(ctx, `DELETE FROM sessions WHERE expires_at < now()`)
	u.LastLoginAt = &now
	return &u, token, nil
}

func (s *pgStore) Register(ctx context.Context, email, password string, profile Profile) (*User, error) {
	email = normalizeEmail(email)
	if err := validateRegistration(email, password); err != nil {
		return nil, err
	}
	p, err := normalizeProfile(profile)
	if err != nil {
		return nil, err
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return nil, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	u, err := scanUser(tx.QueryRow(ctx, `INSERT INTO users (email, password_hash, name, phone, country, city, language, timezone)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
		ON CONFLICT (email) DO NOTHING RETURNING `+userColumns, email, string(hash), p.Name, p.Phone, p.Country, p.City, p.Language, p.Timezone))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, errEmailTaken
	}
	if err != nil {
		return nil, err
	}
	// Every new user gets one real Standard account. It opens empty — the
	// client area's Deposit funds it — the way a broker's onboarding does;
	// demo accounts with virtual money are a click away in the same place.
	if _, err := tx.Exec(ctx, `INSERT INTO accounts (login, user_id, type_id, currency, balance, kind)
		VALUES (nextval('account_login_seq'), $1, $2, 'USD', 0, 'real')`, u.ID, demoAccountType); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return u, nil
}

func (s *pgStore) UserBySession(ctx context.Context, token string) (*User, bool) {
	// Columns are qualified: both tables carry created_at, and an ambiguous
	// reference here read as "no session" for every valid token.
	u, err := scanUser(s.pool.QueryRow(ctx, `SELECT `+qualifiedUserColumns("u")+` FROM users u
		JOIN sessions se ON se.user_id = u.id
		WHERE se.token_hash = $1 AND se.expires_at > now() AND u.enabled`, hashToken(token)))
	if err != nil {
		return nil, false
	}
	return u, true
}

func (s *pgStore) Accounts(ctx context.Context, userID int64) ([]Account, error) {
	rows, err := s.pool.Query(ctx, `SELECT `+accountColumns+` FROM accounts WHERE user_id = $1 ORDER BY login`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Account
	for rows.Next() {
		var a Account
		if err := rows.Scan(accountFields(&a)...); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

func (s *pgStore) AccountByLogin(ctx context.Context, login int64) (*Account, bool) {
	var a Account
	err := s.pool.QueryRow(ctx, `SELECT `+accountColumns+` FROM accounts WHERE login = $1`, login).Scan(accountFields(&a)...)
	if err != nil {
		return nil, false
	}
	return &a, true
}

func (s *pgStore) UserByID(ctx context.Context, id int64) (*User, bool) {
	u, err := scanUser(s.pool.QueryRow(ctx, `SELECT `+userColumns+` FROM users WHERE id = $1`, id))
	if err != nil {
		return nil, false
	}
	return u, true
}

func (s *pgStore) ListUsers(ctx context.Context) ([]User, error) {
	rows, err := s.pool.Query(ctx, `SELECT `+userColumns+` FROM users ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []User
	for rows.Next() {
		var u User
		if err := rows.Scan(userFields(&u)...); err != nil {
			return nil, err
		}
		out = append(out, u)
	}
	return out, rows.Err()
}

func (s *pgStore) UpdateProfile(ctx context.Context, userID int64, profile Profile) (*User, error) {
	p, err := normalizeProfile(profile)
	if err != nil {
		return nil, err
	}
	u, err := scanUser(s.pool.QueryRow(ctx, `UPDATE users SET name = $2, phone = $3, country = $4, city = $5, language = $6, timezone = $7, updated_at = now()
		WHERE id = $1 RETURNING `+userColumns, userID, p.Name, p.Phone, p.Country, p.City, p.Language, p.Timezone))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, errNotFound
	}
	return u, err
}

func (s *pgStore) ChangePassword(ctx context.Context, userID int64, current, next string) error {
	if err := validatePassword(next); err != nil {
		return err
	}
	var hash string
	if err := s.pool.QueryRow(ctx, `SELECT password_hash FROM users WHERE id = $1`, userID).Scan(&hash); err != nil {
		return errNotFound
	}
	if bcrypt.CompareHashAndPassword([]byte(hash), []byte(current)) != nil {
		return errBadCredentials
	}
	newHash, err := bcrypt.GenerateFromPassword([]byte(next), bcrypt.DefaultCost)
	if err != nil {
		return err
	}
	if _, err := s.pool.Exec(ctx, `UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1`, userID, string(newHash)); err != nil {
		return err
	}
	// Every other device is signed out; the caller's own session is
	// re-established by the client with the new password.
	_, _ = s.pool.Exec(ctx, `DELETE FROM sessions WHERE user_id = $1`, userID)
	return nil
}

func (s *pgStore) SetKYC(ctx context.Context, userID int64, status string) error {
	if !validKYC(status) {
		return fmt.Errorf("%w: kyc status", errInvalidInput)
	}
	tag, err := s.pool.Exec(ctx, `UPDATE users SET kyc_status = $2, updated_at = now() WHERE id = $1`, userID, status)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return errNotFound
	}
	return nil
}

func (s *pgStore) SetBalance(ctx context.Context, login int64, balance float64) error {
	tag, err := s.pool.Exec(ctx, `UPDATE accounts SET balance = $2 WHERE login = $1`, login, balance)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return errNotFound
	}
	return nil
}

func (s *pgStore) SetEnabled(ctx context.Context, userID int64, enabled bool) error {
	tag, err := s.pool.Exec(ctx, `UPDATE users SET enabled = $2 WHERE id = $1`, userID, enabled)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return pgx.ErrNoRows
	}
	if !enabled {
		_, _ = s.pool.Exec(ctx, `DELETE FROM sessions WHERE user_id = $1`, userID)
	}
	return nil
}

// ── In-memory (no USERS_DSN) ────────────────────────────────────────────────

type memStore struct {
	mu        sync.Mutex
	users     map[int64]*User
	hashes    map[int64]string
	byEmail   map[string]int64
	accounts  map[int64]Account // by login
	sessions  map[string]session
	nextID    int64
	nextLogin int64

	transactions []Transaction
	nextTxID     int64
}

type session struct {
	userID    int64
	expiresAt time.Time
}

func newMemStore() *memStore {
	s := &memStore{users: map[int64]*User{}, hashes: map[int64]string{}, byEmail: map[string]int64{}, accounts: map[int64]Account{}, sessions: map[string]session{}, nextID: 1, nextLogin: 100001}
	u, _ := s.Register(context.Background(), seedEmail, seedPassword, seedProfile)
	if u != nil {
		// Replace the auto-created account with the documented seed set.
		s.mu.Lock()
		s.users[u.ID].KYCStatus = kycVerified
		for login, a := range s.accounts {
			if a.UserID == u.ID {
				delete(s.accounts, login)
			}
		}
		for _, a := range seedAccounts {
			a.UserID = u.ID
			a.Kind = accountKindReal
			a.CreatedAt = time.Now()
			s.accounts[a.Login] = a
		}
		s.mu.Unlock()
	}
	return s
}

func (s *memStore) Name() string { return "in-memory (set USERS_DSN for PostgreSQL)" }

func (s *memStore) Authenticate(_ context.Context, email, password string) (*User, string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	id, ok := s.byEmail[normalizeEmail(email)]
	if !ok || bcrypt.CompareHashAndPassword([]byte(s.hashes[id]), []byte(password)) != nil {
		return nil, "", errBadCredentials
	}
	u := s.users[id]
	if !u.Enabled {
		return nil, "", errDisabled
	}
	token, hash, err := newSessionToken()
	if err != nil {
		return nil, "", err
	}
	now := time.Now()
	s.sessions[hash] = session{userID: id, expiresAt: now.Add(sessionTTL)}
	u.LastLoginAt = &now
	copy := *u
	return &copy, token, nil
}

func (s *memStore) Register(_ context.Context, email, password string, profile Profile) (*User, error) {
	email = normalizeEmail(email)
	if err := validateRegistration(email, password); err != nil {
		return nil, err
	}
	p, err := normalizeProfile(profile)
	if err != nil {
		return nil, err
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, taken := s.byEmail[email]; taken {
		return nil, errEmailTaken
	}
	now := time.Now()
	u := &User{ID: s.nextID, Email: email, Name: p.Name, Enabled: true, CreatedAt: now, Profile: p, KYCStatus: kycUnverified, AddressStatus: kycUnverified, UpdatedAt: now}
	s.nextID++
	s.users[u.ID] = u
	s.hashes[u.ID] = string(hash)
	s.byEmail[email] = u.ID
	s.accounts[s.nextLogin] = Account{Login: s.nextLogin, UserID: u.ID, TypeID: demoAccountType, Currency: "USD", Balance: 0, Kind: accountKindReal, CreatedAt: time.Now()}
	s.nextLogin++
	copy := *u
	return &copy, nil
}

func (s *memStore) UserBySession(_ context.Context, token string) (*User, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	se, ok := s.sessions[hashToken(token)]
	if !ok || time.Now().After(se.expiresAt) {
		return nil, false
	}
	u, ok := s.users[se.userID]
	if !ok || !u.Enabled {
		return nil, false
	}
	copy := *u
	return &copy, true
}

func (s *memStore) Accounts(_ context.Context, userID int64) ([]Account, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []Account
	for _, a := range s.accounts {
		if a.UserID == userID {
			out = append(out, a)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Login < out[j].Login })
	return out, nil
}

func (s *memStore) AccountByLogin(_ context.Context, login int64) (*Account, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	a, ok := s.accounts[login]
	return &a, ok
}

func (s *memStore) UserByID(_ context.Context, id int64) (*User, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	u, ok := s.users[id]
	if !ok {
		return nil, false
	}
	copy := *u
	return &copy, true
}

func (s *memStore) ListUsers(_ context.Context) ([]User, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]User, 0, len(s.users))
	for _, u := range s.users {
		out = append(out, *u)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}

func (s *memStore) UpdateProfile(_ context.Context, userID int64, profile Profile) (*User, error) {
	p, err := normalizeProfile(profile)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	u, ok := s.users[userID]
	if !ok {
		return nil, errNotFound
	}
	u.Profile, u.Name, u.UpdatedAt = p, p.Name, time.Now()
	copy := *u
	return &copy, nil
}

func (s *memStore) ChangePassword(_ context.Context, userID int64, current, next string) error {
	if err := validatePassword(next); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	hash, ok := s.hashes[userID]
	if !ok {
		return errNotFound
	}
	if bcrypt.CompareHashAndPassword([]byte(hash), []byte(current)) != nil {
		return errBadCredentials
	}
	newHash, err := bcrypt.GenerateFromPassword([]byte(next), bcrypt.DefaultCost)
	if err != nil {
		return err
	}
	s.hashes[userID] = string(newHash)
	s.users[userID].UpdatedAt = time.Now()
	for h, se := range s.sessions {
		if se.userID == userID {
			delete(s.sessions, h)
		}
	}
	return nil
}

func (s *memStore) SetKYC(_ context.Context, userID int64, status string) error {
	if !validKYC(status) {
		return fmt.Errorf("%w: kyc status", errInvalidInput)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	u, ok := s.users[userID]
	if !ok {
		return errNotFound
	}
	u.KYCStatus, u.UpdatedAt = status, time.Now()
	return nil
}

func (s *memStore) SetBalance(_ context.Context, login int64, balance float64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	a, ok := s.accounts[login]
	if !ok {
		return errNotFound
	}
	a.Balance = balance
	s.accounts[login] = a
	return nil
}

func (s *memStore) SetEnabled(_ context.Context, userID int64, enabled bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	u, ok := s.users[userID]
	if !ok {
		return pgx.ErrNoRows
	}
	u.Enabled = enabled
	if !enabled {
		for h, se := range s.sessions {
			if se.userID == userID {
				delete(s.sessions, h)
			}
		}
	}
	return nil
}
