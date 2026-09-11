// Package appdata implements the gateway's own persistence — price alerts and
// workspace documents — on PostgreSQL via pgx. It is deliberately separate from
// the price store (internal/store/timescale): that one holds market data and is
// sized for time-series ingestion, this one holds small per-trader rows and can
// point at an ordinary Postgres.
package appdata

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/nimadorostkar/TradePlatformDemo/backend/internal/domain"
)

// Store is the alert + workspace store.
type Store struct {
	pool *pgxpool.Pool
}

// New opens a pgx pool for the given DSN.
func New(ctx context.Context, dsn string, maxConns int32) (*Store, error) {
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, fmt.Errorf("parse dsn: %w", err)
	}
	if maxConns > 0 {
		cfg.MaxConns = maxConns
	}
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("connect: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping: %w", err)
	}
	return &Store{pool: pool}, nil
}

// Ping verifies connectivity (for readiness).
func (s *Store) Ping(ctx context.Context) error { return s.pool.Ping(ctx) }

// Close releases the pool.
func (s *Store) Close() { s.pool.Close() }

// ── Alerts ───────────────────────────────────────────────────────────────────

// "condition" is quoted throughout: it is a reserved word in the SQL standard,
// and quoting costs nothing while removing any doubt about how a given server
// parses it.
const alertColumns = `id, login, symbol, "condition", price, note, status, created_at, triggered_at, triggered_price`

// ListAlerts returns every alert for a login, newest first.
func (s *Store) ListAlerts(ctx context.Context, login string) ([]domain.Alert, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT `+alertColumns+` FROM price_alerts WHERE login=$1 ORDER BY id DESC`, login)
	if err != nil {
		return nil, err
	}
	return scanAlerts(rows)
}

// ListAlertsTriggeredSince returns alerts that fired strictly after ts.
func (s *Store) ListAlertsTriggeredSince(ctx context.Context, login string, ts time.Time) ([]domain.Alert, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT `+alertColumns+` FROM price_alerts
		 WHERE login=$1 AND triggered_at IS NOT NULL AND triggered_at > $2
		 ORDER BY triggered_at ASC`, login, ts)
	if err != nil {
		return nil, err
	}
	return scanAlerts(rows)
}

// CreateAlert stores a new active alert.
func (s *Store) CreateAlert(ctx context.Context, a domain.Alert) (domain.Alert, error) {
	row := s.pool.QueryRow(ctx,
		`INSERT INTO price_alerts (login, symbol, "condition", price, note, status, created_at)
		 VALUES ($1,$2,$3,$4,$5,$6,now())
		 RETURNING `+alertColumns,
		a.Login, a.Symbol, a.Condition, a.Price, a.Note, domain.AlertActive)
	return scanAlert(row)
}

// DeleteAlert removes an alert owned by login.
func (s *Store) DeleteAlert(ctx context.Context, id int64, login string) (bool, error) {
	tag, err := s.pool.Exec(ctx, `DELETE FROM price_alerts WHERE id=$1 AND login=$2`, id, login)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

// ActiveAlertSymbols returns the distinct symbols with at least one active alert.
func (s *Store) ActiveAlertSymbols(ctx context.Context) ([]string, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT DISTINCT symbol FROM price_alerts WHERE status=$1`, domain.AlertActive)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var sym string
		if err := rows.Scan(&sym); err != nil {
			return nil, err
		}
		out = append(out, sym)
	}
	return out, rows.Err()
}

// ActiveAlertsForSymbol returns the active alerts on one symbol.
func (s *Store) ActiveAlertsForSymbol(ctx context.Context, symbol string) ([]domain.Alert, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT `+alertColumns+` FROM price_alerts WHERE symbol=$1 AND status=$2 ORDER BY id`,
		symbol, domain.AlertActive)
	if err != nil {
		return nil, err
	}
	return scanAlerts(rows)
}

// MarkAlertTriggered flips an alert to triggered, reporting whether this call
// won the race. The status guard in the WHERE clause is what makes concurrent
// evaluators on different replicas safe: exactly one UPDATE can match.
func (s *Store) MarkAlertTriggered(ctx context.Context, id int64, at time.Time, price float64) (bool, error) {
	tag, err := s.pool.Exec(ctx,
		`UPDATE price_alerts SET status=$1, triggered_at=$2, triggered_price=$3
		 WHERE id=$4 AND status=$5`,
		domain.AlertTriggered, at, price, id, domain.AlertActive)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

func scanAlerts(rows pgx.Rows) ([]domain.Alert, error) {
	defer rows.Close()
	out := []domain.Alert{}
	for rows.Next() {
		a, err := scanAlert(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// scanner is satisfied by both pgx.Row and pgx.Rows.
type scanner interface{ Scan(dest ...any) error }

func scanAlert(row scanner) (domain.Alert, error) {
	var a domain.Alert
	err := row.Scan(&a.ID, &a.Login, &a.Symbol, &a.Condition, &a.Price, &a.Note,
		&a.Status, &a.CreatedAt, &a.TriggeredAt, &a.TriggeredPrice)
	return a, err
}

// ── Workspace ────────────────────────────────────────────────────────────────

// GetWorkspace returns the stored layout document for a login.
func (s *Store) GetWorkspace(ctx context.Context, login string) (domain.Workspace, bool, error) {
	var w domain.Workspace
	err := s.pool.QueryRow(ctx,
		`SELECT login, document, version, updated_at FROM workspaces WHERE login=$1`, login).
		Scan(&w.Login, &w.Document, &w.Version, &w.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.Workspace{}, false, nil
	}
	if err != nil {
		return domain.Workspace{}, false, err
	}
	return w, true, nil
}

// SaveWorkspace upserts the document, bumping the stored version so a client
// can tell whether the copy it holds is the one on the server.
//
// The document is bound as a string with an explicit ::jsonb cast, not as
// []byte: pgx encodes a byte slice as bytea, which a jsonb column rejects.
func (s *Store) SaveWorkspace(ctx context.Context, login string, document []byte) (domain.Workspace, error) {
	var w domain.Workspace
	err := s.pool.QueryRow(ctx,
		`INSERT INTO workspaces (login, document, version, updated_at)
		 VALUES ($1,$2::jsonb,1,now())
		 ON CONFLICT (login) DO UPDATE
		 SET document=EXCLUDED.document, version=workspaces.version+1, updated_at=now()
		 RETURNING login, document, version, updated_at`,
		login, string(document)).Scan(&w.Login, &w.Document, &w.Version, &w.UpdatedAt)
	return w, err
}
