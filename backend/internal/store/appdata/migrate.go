package appdata

import "context"

// schema is the idempotent DDL applied on startup.
const schema = `
CREATE TABLE IF NOT EXISTS price_alerts (
    id              bigserial PRIMARY KEY,
    login           text   NOT NULL,
    symbol          text   NOT NULL,
    "condition"     text   NOT NULL CHECK ("condition" IN ('above','below')),
    price           double precision NOT NULL,
    note            text   NOT NULL DEFAULT '',
    status          text   NOT NULL DEFAULT 'active' CHECK (status IN ('active','triggered')),
    created_at      timestamptz NOT NULL DEFAULT now(),
    triggered_at    timestamptz,
    triggered_price double precision
);
CREATE INDEX IF NOT EXISTS idx_price_alerts_login ON price_alerts (login, id DESC);
-- The evaluator's hot path: every active alert on a symbol, per tick sweep.
CREATE INDEX IF NOT EXISTS idx_price_alerts_active ON price_alerts (symbol) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_price_alerts_triggered ON price_alerts (login, triggered_at)
    WHERE triggered_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS workspaces (
    login      text   PRIMARY KEY,
    document   jsonb  NOT NULL,
    version    bigint NOT NULL DEFAULT 1,
    updated_at timestamptz NOT NULL DEFAULT now()
);
`

// Migrate applies the schema.
func (s *Store) Migrate(ctx context.Context) error {
	_, err := s.pool.Exec(ctx, schema)
	return err
}

// TryLock acquires a PostgreSQL session advisory lock so only one instance runs
// a guarded job (the alert evaluator). Returns (acquired, release).
func (s *Store) TryLock(ctx context.Context, key int64) (bool, func(), error) {
	conn, err := s.pool.Acquire(ctx)
	if err != nil {
		return false, func() {}, err
	}
	var ok bool
	if err := conn.QueryRow(ctx, `SELECT pg_try_advisory_lock($1)`, key).Scan(&ok); err != nil {
		conn.Release()
		return false, func() {}, err
	}
	if !ok {
		conn.Release()
		return false, func() {}, nil
	}
	release := func() {
		_, _ = conn.Exec(context.Background(), `SELECT pg_advisory_unlock($1)`, key)
		conn.Release()
	}
	return true, release, nil
}
