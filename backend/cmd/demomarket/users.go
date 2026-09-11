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
}

type Account struct {
	Login     int64
	UserID    int64
	TypeID    int
	Currency  string
	Balance   float64
	CreatedAt time.Time
}

// UserStore is what the CRM endpoints need; both backends implement it.
type UserStore interface {
	// Authenticate checks the password and opens a session; the returned
	// token is the CRM access token the client keeps.
	Authenticate(ctx context.Context, email, password string) (*User, string, error)
	Register(ctx context.Context, email, password, name string) (*User, error)
	// UserBySession resolves a CRM token; ok=false when unknown or expired.
	UserBySession(ctx context.Context, token string) (*User, bool)
	Accounts(ctx context.Context, userID int64) ([]Account, error)
	AccountByLogin(ctx context.Context, login int64) (*Account, bool)
	UserByID(ctx context.Context, id int64) (*User, bool)
	ListUsers(ctx context.Context) ([]User, error)
	SetEnabled(ctx context.Context, userID int64, enabled bool) error
	Name() string
}

func normalizeEmail(email string) string { return strings.ToLower(strings.TrimSpace(email)) }

func validateRegistration(email, password, name string) error {
	if !emailPattern.MatchString(email) || len(email) > 254 {
		return fmt.Errorf("%w: email", errInvalidInput)
	}
	if len(password) < minPasswordLen || len(password) > 128 {
		return fmt.Errorf("%w: password must be %d–128 characters", errInvalidInput, minPasswordLen)
	}
	if len(name) > 80 {
		return fmt.Errorf("%w: name", errInvalidInput)
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
	if err := tx.QueryRow(ctx, `INSERT INTO users (email, password_hash, name) VALUES ($1,$2,$3) RETURNING id`, seedEmail, string(hash), seedName).Scan(&id); err != nil {
		return err
	}
	for _, a := range seedAccounts {
		if _, err := tx.Exec(ctx, `INSERT INTO accounts (login, user_id, type_id, currency, balance) VALUES ($1,$2,$3,$4,$5)`, a.Login, id, a.TypeID, a.Currency, a.Balance); err != nil {
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
	if err := row.Scan(&u.ID, &u.Email, &u.Name, &u.Enabled, &u.CreatedAt, &u.LastLoginAt); err != nil {
		return nil, err
	}
	return &u, nil
}

const userColumns = `id, email, name, enabled, created_at, last_login_at`

func (s *pgStore) Authenticate(ctx context.Context, email, password string) (*User, string, error) {
	email = normalizeEmail(email)
	var u User
	var hash string
	err := s.pool.QueryRow(ctx, `SELECT `+userColumns+`, password_hash FROM users WHERE email = $1`, email).
		Scan(&u.ID, &u.Email, &u.Name, &u.Enabled, &u.CreatedAt, &u.LastLoginAt, &hash)
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

func (s *pgStore) Register(ctx context.Context, email, password, name string) (*User, error) {
	email = normalizeEmail(email)
	name = strings.TrimSpace(name)
	if err := validateRegistration(email, password, name); err != nil {
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
	u, err := scanUser(tx.QueryRow(ctx, `INSERT INTO users (email, password_hash, name) VALUES ($1,$2,$3)
		ON CONFLICT (email) DO NOTHING RETURNING `+userColumns, email, string(hash), name))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, errEmailTaken
	}
	if err != nil {
		return nil, err
	}
	// Every new user gets one funded demo account.
	if _, err := tx.Exec(ctx, `INSERT INTO accounts (login, user_id, type_id, currency, balance)
		VALUES (nextval('account_login_seq'), $1, $2, 'USD', $3)`, u.ID, demoAccountType, demoStartBalance); err != nil {
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
	u, err := scanUser(s.pool.QueryRow(ctx, `SELECT u.id, u.email, u.name, u.enabled, u.created_at, u.last_login_at FROM users u
		JOIN sessions se ON se.user_id = u.id
		WHERE se.token_hash = $1 AND se.expires_at > now() AND u.enabled`, hashToken(token)))
	if err != nil {
		return nil, false
	}
	return u, true
}

func (s *pgStore) Accounts(ctx context.Context, userID int64) ([]Account, error) {
	rows, err := s.pool.Query(ctx, `SELECT login, user_id, type_id, currency, balance, created_at FROM accounts WHERE user_id = $1 ORDER BY login`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Account
	for rows.Next() {
		var a Account
		if err := rows.Scan(&a.Login, &a.UserID, &a.TypeID, &a.Currency, &a.Balance, &a.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

func (s *pgStore) AccountByLogin(ctx context.Context, login int64) (*Account, bool) {
	var a Account
	err := s.pool.QueryRow(ctx, `SELECT login, user_id, type_id, currency, balance, created_at FROM accounts WHERE login = $1`, login).
		Scan(&a.Login, &a.UserID, &a.TypeID, &a.Currency, &a.Balance, &a.CreatedAt)
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
		if err := rows.Scan(&u.ID, &u.Email, &u.Name, &u.Enabled, &u.CreatedAt, &u.LastLoginAt); err != nil {
			return nil, err
		}
		out = append(out, u)
	}
	return out, rows.Err()
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
}

type session struct {
	userID    int64
	expiresAt time.Time
}

func newMemStore() *memStore {
	s := &memStore{users: map[int64]*User{}, hashes: map[int64]string{}, byEmail: map[string]int64{}, accounts: map[int64]Account{}, sessions: map[string]session{}, nextID: 1, nextLogin: 100001}
	u, _ := s.Register(context.Background(), seedEmail, seedPassword, seedName)
	if u != nil {
		// Replace the auto-created account with the documented seed set.
		s.mu.Lock()
		for login, a := range s.accounts {
			if a.UserID == u.ID {
				delete(s.accounts, login)
			}
		}
		for _, a := range seedAccounts {
			a.UserID = u.ID
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

func (s *memStore) Register(_ context.Context, email, password, name string) (*User, error) {
	email = normalizeEmail(email)
	name = strings.TrimSpace(name)
	if err := validateRegistration(email, password, name); err != nil {
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
	u := &User{ID: s.nextID, Email: email, Name: name, Enabled: true, CreatedAt: time.Now()}
	s.nextID++
	s.users[u.ID] = u
	s.hashes[u.ID] = string(hash)
	s.byEmail[email] = u.ID
	s.accounts[s.nextLogin] = Account{Login: s.nextLogin, UserID: u.ID, TypeID: demoAccountType, Currency: "USD", Balance: demoStartBalance, CreatedAt: time.Now()}
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
