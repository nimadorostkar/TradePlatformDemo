package main

// Persistence for the demo broker's book: every account's balance, leverage,
// open positions, working orders, order history and deals, plus the ticket
// counters. Two backends share one contract:
//
//   - PostgreSQL (the same database as the users, whenever USERS_DSN is set):
//     relational tables, so a trader's history is queryable and survives the
//     container, not just the process.
//   - A JSON file (BROKER_STATE_FILE) for a laptop without a database.
//
// The engine holds the book in memory and hands the store a snapshot from
// its save loop; the store never sees the engine's mutex.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// BrokerStore persists brokerState snapshots.
type BrokerStore interface {
	// Load returns the persisted book, or nil when nothing has been saved yet.
	Load(ctx context.Context) (*brokerState, error)
	Save(ctx context.Context, st *brokerState) error
	Name() string
}

// snapshot deep-copies the book so Save can run outside the engine's lock.
// Caller holds b.mu.
func (b *demoBroker) snapshot() *brokerState {
	st := &brokerState{
		NextTicket: b.nextTicket, NextRequest: b.nextRequest,
		Accounts: make(map[int64]*account, len(b.accounts)),
	}
	for login, a := range b.accounts {
		c := &account{
			Login: a.Login, Balance: a.Balance, Credit: a.Credit, Leverage: a.Leverage, Currency: a.Currency,
			Positions: make(map[int64]*position, len(a.Positions)),
			Orders:    make(map[int64]*order, len(a.Orders)),
			History:   make([]*order, len(a.History)),
			Deals:     make([]*deal, len(a.Deals)),
		}
		for t, p := range a.Positions {
			cp := *p
			c.Positions[t] = &cp
		}
		for t, o := range a.Orders {
			co := *o
			c.Orders[t] = &co
		}
		for i, o := range a.History {
			co := *o
			c.History[i] = &co
		}
		for i, d := range a.Deals {
			cd := *d
			c.Deals[i] = &cd
		}
		st.Accounts[login] = c
	}
	return st
}

// ── JSON file ───────────────────────────────────────────────────────────────

type fileBrokerStore struct{ path string }

func (s fileBrokerStore) Name() string { return s.path }

func (s fileBrokerStore) Load(context.Context) (*brokerState, error) {
	data, err := os.ReadFile(s.path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var st brokerState
	if err := json.Unmarshal(data, &st); err != nil {
		return nil, fmt.Errorf("%s is not a state file: %w", s.path, err)
	}
	return &st, nil
}

func (s fileBrokerStore) Save(_ context.Context, st *brokerState) error {
	data, err := json.MarshalIndent(st, "", " ")
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.MkdirAll(filepath.Dir(s.path), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

// ── PostgreSQL ──────────────────────────────────────────────────────────────

const brokerSchema = `
CREATE TABLE IF NOT EXISTS broker_meta (
  id           SMALLINT PRIMARY KEY CHECK (id = 1),
  next_ticket  BIGINT NOT NULL,
  next_request BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS broker_accounts (
  login      BIGINT PRIMARY KEY,
  balance    DOUBLE PRECISION NOT NULL,
  credit     DOUBLE PRECISION NOT NULL DEFAULT 0,
  leverage   INTEGER NOT NULL,
  currency   TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS broker_positions (
  ticket      BIGINT PRIMARY KEY,
  login       BIGINT NOT NULL REFERENCES broker_accounts(login) ON DELETE CASCADE,
  symbol      TEXT NOT NULL,
  action      SMALLINT NOT NULL,
  time_create BIGINT NOT NULL,
  price_open  DOUBLE PRECISION NOT NULL,
  price_sl    DOUBLE PRECISION NOT NULL DEFAULT 0,
  price_tp    DOUBLE PRECISION NOT NULL DEFAULT 0,
  volume      BIGINT NOT NULL,
  storage     DOUBLE PRECISION NOT NULL DEFAULT 0,
  commission  DOUBLE PRECISION NOT NULL DEFAULT 0,
  comment     TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS broker_positions_login ON broker_positions(login);
CREATE TABLE IF NOT EXISTS broker_orders (
  ticket          BIGINT PRIMARY KEY,
  login           BIGINT NOT NULL REFERENCES broker_accounts(login) ON DELETE CASCADE,
  working         BOOLEAN NOT NULL,
  seq             INTEGER NOT NULL DEFAULT 0,
  symbol          TEXT NOT NULL,
  type            SMALLINT NOT NULL,
  state           SMALLINT NOT NULL,
  time_setup      BIGINT NOT NULL,
  time_done       BIGINT NOT NULL DEFAULT 0,
  price_order     DOUBLE PRECISION NOT NULL DEFAULT 0,
  price_trigger   DOUBLE PRECISION NOT NULL DEFAULT 0,
  price_sl        DOUBLE PRECISION NOT NULL DEFAULT 0,
  price_tp        DOUBLE PRECISION NOT NULL DEFAULT 0,
  volume_initial  BIGINT NOT NULL,
  volume_current  BIGINT NOT NULL,
  type_time       SMALLINT NOT NULL DEFAULT 0,
  time_expiration BIGINT NOT NULL DEFAULT 0,
  position_id     BIGINT NOT NULL DEFAULT 0,
  comment         TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS broker_orders_login ON broker_orders(login, working, seq);
CREATE TABLE IF NOT EXISTS broker_deals (
  ticket      BIGINT PRIMARY KEY,
  login       BIGINT NOT NULL REFERENCES broker_accounts(login) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  order_id    BIGINT NOT NULL DEFAULT 0,
  symbol      TEXT NOT NULL,
  action      SMALLINT NOT NULL,
  entry       SMALLINT NOT NULL,
  price       DOUBLE PRECISION NOT NULL,
  volume      BIGINT NOT NULL,
  time_msc    BIGINT NOT NULL,
  commission  DOUBLE PRECISION NOT NULL DEFAULT 0,
  storage     DOUBLE PRECISION NOT NULL DEFAULT 0,
  profit      DOUBLE PRECISION NOT NULL DEFAULT 0,
  position_id BIGINT NOT NULL DEFAULT 0,
  comment     TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS broker_deals_login ON broker_deals(login, seq);
`

// pgBrokerStore keeps the book in the users' database. History and deals are
// append-only in the engine (a reset empties them), so a save writes only the
// rows added since the last one; positions and working orders are small and
// are rewritten per account.
type pgBrokerStore struct {
	pool *pgxpool.Pool
	// persisted[login] = how many history orders / deals are already in the
	// database, so Save can append rather than rewrite.
	persisted map[int64]persistedCounts
}

type persistedCounts struct{ history, deals int }

func openPGBrokerStore(ctx context.Context, pool *pgxpool.Pool) (*pgBrokerStore, error) {
	if _, err := pool.Exec(ctx, brokerSchema); err != nil {
		return nil, fmt.Errorf("migrate broker schema: %w", err)
	}
	return &pgBrokerStore{pool: pool, persisted: map[int64]persistedCounts{}}, nil
}

func (s *pgBrokerStore) Name() string { return "postgresql" }

func (s *pgBrokerStore) Load(ctx context.Context) (*brokerState, error) {
	st := &brokerState{Accounts: map[int64]*account{}}
	err := s.pool.QueryRow(ctx, `SELECT next_ticket, next_request FROM broker_meta WHERE id = 1`).
		Scan(&st.NextTicket, &st.NextRequest)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}

	rows, err := s.pool.Query(ctx, `SELECT login, balance, credit, leverage, currency FROM broker_accounts`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		a := &account{Positions: map[int64]*position{}, Orders: map[int64]*order{}}
		if err := rows.Scan(&a.Login, &a.Balance, &a.Credit, &a.Leverage, &a.Currency); err != nil {
			rows.Close()
			return nil, err
		}
		st.Accounts[a.Login] = a
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	rows, err = s.pool.Query(ctx, `SELECT ticket, login, symbol, action, time_create, price_open, price_sl, price_tp,
		volume, storage, commission, comment FROM broker_positions`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		p := &position{}
		if err := rows.Scan(&p.Ticket, &p.Login, &p.Symbol, &p.Action, &p.TimeCreate, &p.PriceOpen, &p.PriceSL, &p.PriceTP,
			&p.Volume, &p.Storage, &p.Commission, &p.Comment); err != nil {
			rows.Close()
			return nil, err
		}
		if a, ok := st.Accounts[p.Login]; ok {
			a.Positions[p.Ticket] = p
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	rows, err = s.pool.Query(ctx, `SELECT ticket, login, working, symbol, type, state, time_setup, time_done, price_order,
		price_trigger, price_sl, price_tp, volume_initial, volume_current, type_time, time_expiration, position_id, comment
		FROM broker_orders ORDER BY login, seq, ticket`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		o := &order{}
		var working bool
		if err := rows.Scan(&o.Ticket, &o.Login, &working, &o.Symbol, &o.Type, &o.State, &o.TimeSetup, &o.TimeDone, &o.PriceOrder,
			&o.PriceTrigger, &o.PriceSL, &o.PriceTP, &o.VolumeInitial, &o.VolumeCurrent, &o.TypeTime, &o.TimeExpiration,
			&o.PositionID, &o.Comment); err != nil {
			rows.Close()
			return nil, err
		}
		a, ok := st.Accounts[o.Login]
		if !ok {
			continue
		}
		if working {
			a.Orders[o.Ticket] = o
		} else {
			a.History = append(a.History, o)
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	rows, err = s.pool.Query(ctx, `SELECT ticket, login, order_id, symbol, action, entry, price, volume, time_msc,
		commission, storage, profit, position_id, comment FROM broker_deals ORDER BY login, seq, ticket`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		d := &deal{}
		if err := rows.Scan(&d.Ticket, &d.Login, &d.Order, &d.Symbol, &d.Action, &d.Entry, &d.Price, &d.Volume, &d.TimeMsc,
			&d.Commission, &d.Storage, &d.Profit, &d.PositionID, &d.Comment); err != nil {
			rows.Close()
			return nil, err
		}
		if a, ok := st.Accounts[d.Login]; ok {
			a.Deals = append(a.Deals, d)
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	for login, a := range st.Accounts {
		s.persisted[login] = persistedCounts{history: len(a.History), deals: len(a.Deals)}
	}
	return st, nil
}

func (s *pgBrokerStore) Save(ctx context.Context, st *brokerState) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op after Commit

	if _, err := tx.Exec(ctx, `INSERT INTO broker_meta (id, next_ticket, next_request) VALUES (1, $1, $2)
		ON CONFLICT (id) DO UPDATE SET next_ticket = EXCLUDED.next_ticket, next_request = EXCLUDED.next_request`,
		st.NextTicket, st.NextRequest); err != nil {
		return err
	}

	next := make(map[int64]persistedCounts, len(st.Accounts))
	batch := &pgx.Batch{}
	for login, a := range st.Accounts {
		batch.Queue(`INSERT INTO broker_accounts (login, balance, credit, leverage, currency, updated_at)
			VALUES ($1, $2, $3, $4, $5, now())
			ON CONFLICT (login) DO UPDATE SET balance = EXCLUDED.balance, credit = EXCLUDED.credit,
			  leverage = EXCLUDED.leverage, currency = EXCLUDED.currency, updated_at = now()`,
			login, a.Balance, a.Credit, a.Leverage, a.Currency)

		batch.Queue(`DELETE FROM broker_positions WHERE login = $1`, login)
		for _, p := range a.Positions {
			batch.Queue(`INSERT INTO broker_positions (ticket, login, symbol, action, time_create, price_open, price_sl, price_tp,
				volume, storage, commission, comment) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
				p.Ticket, login, p.Symbol, p.Action, p.TimeCreate, p.PriceOpen, p.PriceSL, p.PriceTP,
				p.Volume, p.Storage, p.Commission, p.Comment)
		}

		batch.Queue(`DELETE FROM broker_orders WHERE login = $1 AND working`, login)
		for _, o := range a.Orders {
			queueOrder(batch, login, true, 0, o)
		}

		was := s.persisted[login]
		historyFrom, dealsFrom := was.history, was.deals
		if len(a.History) < was.history {
			// Emptied by an admin reset: the rows must go, not just stop growing.
			batch.Queue(`DELETE FROM broker_orders WHERE login = $1 AND NOT working`, login)
			historyFrom = 0
		}
		for i := historyFrom; i < len(a.History); i++ {
			queueOrder(batch, login, false, i, a.History[i])
		}
		if len(a.Deals) < was.deals {
			batch.Queue(`DELETE FROM broker_deals WHERE login = $1`, login)
			dealsFrom = 0
		}
		for i := dealsFrom; i < len(a.Deals); i++ {
			d := a.Deals[i]
			batch.Queue(`INSERT INTO broker_deals (ticket, login, seq, order_id, symbol, action, entry, price, volume, time_msc,
				commission, storage, profit, position_id, comment) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
				ON CONFLICT (ticket) DO NOTHING`,
				d.Ticket, login, i, d.Order, d.Symbol, d.Action, d.Entry, d.Price, d.Volume, d.TimeMsc,
				d.Commission, d.Storage, d.Profit, d.PositionID, d.Comment)
		}
		next[login] = persistedCounts{history: len(a.History), deals: len(a.Deals)}
	}
	if err := tx.SendBatch(ctx, batch).Close(); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	for login, c := range next {
		s.persisted[login] = c
	}
	return nil
}

// queueOrder upserts one order row. A working order that reaches history
// keeps its ticket, so the same row flips `working` rather than duplicating.
func queueOrder(batch *pgx.Batch, login int64, working bool, seq int, o *order) {
	batch.Queue(`INSERT INTO broker_orders (ticket, login, working, seq, symbol, type, state, time_setup, time_done,
		price_order, price_trigger, price_sl, price_tp, volume_initial, volume_current, type_time, time_expiration,
		position_id, comment) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
		ON CONFLICT (ticket) DO UPDATE SET working = EXCLUDED.working, seq = EXCLUDED.seq, state = EXCLUDED.state,
		  time_done = EXCLUDED.time_done, price_order = EXCLUDED.price_order, price_trigger = EXCLUDED.price_trigger,
		  price_sl = EXCLUDED.price_sl, price_tp = EXCLUDED.price_tp, volume_current = EXCLUDED.volume_current,
		  type_time = EXCLUDED.type_time, time_expiration = EXCLUDED.time_expiration, position_id = EXCLUDED.position_id,
		  comment = EXCLUDED.comment`,
		o.Ticket, login, working, seq, o.Symbol, o.Type, o.State, o.TimeSetup, o.TimeDone,
		o.PriceOrder, o.PriceTrigger, o.PriceSL, o.PriceTP, o.VolumeInitial, o.VolumeCurrent, o.TypeTime, o.TimeExpiration,
		o.PositionID, o.Comment)
}

// importStateFile seeds an empty database from a BROKER_STATE_FILE left by an
// earlier, file-backed run, so switching backends keeps every trader's book.
func importStateFile(ctx context.Context, path string, into BrokerStore) (*brokerState, error) {
	if path == "" {
		return nil, nil
	}
	st, err := fileBrokerStore{path: path}.Load(ctx)
	if err != nil || st == nil {
		return st, err
	}
	if err := into.Save(ctx, st); err != nil {
		return nil, fmt.Errorf("import %s: %w", path, err)
	}
	log.Printf("broker: imported %d account(s) from %s into %s", len(st.Accounts), path, into.Name())
	return st, nil
}
