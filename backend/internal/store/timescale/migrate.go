package timescale

import "context"

// schema is the idempotent DDL applied on startup. It works on plain PostgreSQL;
// the Timescale-specific steps (extension, hypertable, retention) are applied
// best-effort so a non-Timescale Postgres still functions.
const schema = `
CREATE TABLE IF NOT EXISTS price_history (
    symbol text   NOT NULL,
    time   bigint NOT NULL,
    open   double precision NOT NULL,
    high   double precision NOT NULL,
    low    double precision NOT NULL,
    close  double precision NOT NULL,
    volume double precision NOT NULL DEFAULT 0,
    PRIMARY KEY (symbol, time)
);
CREATE INDEX IF NOT EXISTS idx_price_history_symbol_time ON price_history (symbol, time);

CREATE TABLE IF NOT EXISTS daily_data (
    symbol    text   NOT NULL,
    timestamp bigint NOT NULL,
    open  double precision NOT NULL,
    high  double precision NOT NULL,
    low   double precision NOT NULL,
    close double precision NOT NULL,
    PRIMARY KEY (symbol, timestamp)
);

CREATE TABLE IF NOT EXISTS logs (
    id         bigserial PRIMARY KEY,
    api_url    text NOT NULL,
    request    text NOT NULL,
    start_time timestamptz NOT NULL,
    end_time   timestamptz NOT NULL,
    is_success boolean NOT NULL
);
`

// Timescale-specific statements; failures are non-fatal (plain Postgres).
var timescaleStmts = []string{
	`CREATE EXTENSION IF NOT EXISTS timescaledb`,
	`SELECT create_hypertable('price_history','time', chunk_time_interval => 86400, if_not_exists => TRUE, migrate_data => TRUE)`,
	`SELECT add_retention_policy('price_history', BIGINT '604800', if_not_exists => TRUE)`,
}

// Migrate applies the schema. The core DDL is required; the Timescale steps are
// best-effort.
func (s *Store) Migrate(ctx context.Context) error {
	if _, err := s.pool.Exec(ctx, schema); err != nil {
		return err
	}
	for _, stmt := range timescaleStmts {
		// Best-effort: ignore errors so a non-Timescale Postgres still works.
		_, _ = s.pool.Exec(ctx, stmt)
	}
	return nil
}
