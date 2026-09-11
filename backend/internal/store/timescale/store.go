// Package timescale implements domain.PriceStore on PostgreSQL/TimescaleDB via
// pgx. It replaces the .NET SQL Server schema + stored procs (see
// docs/ARCHITECTURE.md §7): the intraday table is a Timescale hypertable, daily
// rows are upserted, intraday upserts use ON CONFLICT, and the 7-day retention
// is a DELETE (or a Timescale retention policy applied by Migrate).
package timescale

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/nimadorostkar/TradePlatformDemo/backend/internal/domain"
)

// Store is the price-history store.
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

// LatestTime returns the newest stored Time for symbol within [from,to], or 0.
func (s *Store) LatestTime(ctx context.Context, symbol string, from, to int64) (int64, error) {
	var t int64
	err := s.pool.QueryRow(ctx,
		`SELECT COALESCE(MAX(time),0) FROM price_history WHERE symbol=$1 AND time BETWEEN $2 AND $3`,
		symbol, from, to).Scan(&t)
	return t, err
}

// InsertCandles bulk-upserts intraday candles via the PostgreSQL binary COPY
// protocol (pgx CopyFrom) into an ON COMMIT DROP staging table, then a single
// INSERT … SELECT … ON CONFLICT upsert into the hypertable. COPY is the fastest
// ingestion path; the staging+upsert keeps the (symbol,time) merge semantics
// that COPY alone cannot express.
func (s *Store) InsertCandles(ctx context.Context, candles []domain.Candle) error {
	if len(candles) == 0 {
		return nil
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op after Commit

	if _, err := tx.Exec(ctx,
		`CREATE TEMP TABLE _ph_stage (
		    symbol text, time bigint,
		    open double precision, high double precision, low double precision,
		    close double precision, volume double precision
		 ) ON COMMIT DROP`); err != nil {
		return err
	}

	_, err = tx.CopyFrom(ctx,
		pgx.Identifier{"_ph_stage"},
		[]string{"symbol", "time", "open", "high", "low", "close", "volume"},
		pgx.CopyFromSlice(len(candles), func(i int) ([]any, error) {
			c := candles[i]
			return []any{c.Symbol, c.Time, c.Open, c.High, c.Low, c.Close, c.Volume}, nil
		}))
	if err != nil {
		return err
	}

	if _, err := tx.Exec(ctx,
		`INSERT INTO price_history (symbol,time,open,high,low,close,volume)
		 SELECT symbol,time,open,high,low,close,volume FROM _ph_stage
		 ON CONFLICT (symbol,time) DO UPDATE
		 SET open=EXCLUDED.open, high=EXCLUDED.high, low=EXCLUDED.low,
		     close=EXCLUDED.close, volume=EXCLUDED.volume`); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// DeleteOlderThan prunes intraday rows with Time < cutoff.
func (s *Store) DeleteOlderThan(ctx context.Context, cutoff int64) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM price_history WHERE time < $1`, cutoff)
	return err
}

// IntradayRange returns intraday candles for symbol within [from,to], newest first.
func (s *Store) IntradayRange(ctx context.Context, symbol string, from, to int64) ([]domain.Candle, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT time,open,high,low,close,volume FROM price_history
		 WHERE symbol=$1 AND time BETWEEN $2 AND $3 ORDER BY time DESC`,
		symbol, from, to)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []domain.Candle
	for rows.Next() {
		c := domain.Candle{Symbol: symbol}
		if err := rows.Scan(&c.Time, &c.Open, &c.High, &c.Low, &c.Close, &c.Volume); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// DailyRange returns aggregated daily candles for symbol within [from,to], asc.
func (s *Store) DailyRange(ctx context.Context, symbol string, from, to int64) ([]domain.DailyCandle, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT timestamp,open,high,low,close FROM daily_data
		 WHERE symbol=$1 AND timestamp BETWEEN $2 AND $3 ORDER BY timestamp ASC`,
		symbol, from, to)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []domain.DailyCandle
	for rows.Next() {
		d := domain.DailyCandle{Symbol: symbol}
		if err := rows.Scan(&d.Timestamp, &d.Open, &d.High, &d.Low, &d.Close); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

// AggregateDaily rolls intraday rows in [startUnix,endUnix] into one daily row
// per symbol (open=first, close=last, high=max, low=min).
func (s *Store) AggregateDaily(ctx context.Context, startUnix, endUnix int64, symbols []string) error {
	if len(symbols) == 0 {
		return nil
	}
	_, err := s.pool.Exec(ctx,
		`INSERT INTO daily_data (symbol, timestamp, open, high, low, close)
		 SELECT ph.symbol, $1::bigint,
		        (array_agg(ph.open ORDER BY ph.time ASC))[1],
		        MAX(ph.high), MIN(ph.low),
		        (array_agg(ph.close ORDER BY ph.time DESC))[1]
		 FROM price_history ph
		 WHERE ph.symbol = ANY($3) AND ph.time >= $1 AND ph.time <= $2
		 GROUP BY ph.symbol
		 ON CONFLICT (symbol, timestamp) DO UPDATE
		 SET open=EXCLUDED.open, high=EXCLUDED.high, low=EXCLUDED.low, close=EXCLUDED.close`,
		startUnix, endUnix, symbols)
	return err
}

// TryLock acquires a PostgreSQL session advisory lock so only one instance runs
// a guarded job (e.g. the price-history fetch). Returns (acquired, release).
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

// DistinctSymbols returns the symbols present in the intraday table.
func (s *Store) DistinctSymbols(ctx context.Context) ([]string, error) {
	rows, err := s.pool.Query(ctx, `SELECT DISTINCT symbol FROM price_history`)
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

// InsertDailyCandles backfills daily rows the serving path fetched live from
// MT5 (the head of a chart request the store did not yet cover). DO NOTHING on
// conflict: a row the nightly aggregation wrote from real M1 always outranks a
// backfilled one, and a re-served page must never churn the table.
func (s *Store) InsertDailyCandles(ctx context.Context, candles []domain.DailyCandle) error {
	if len(candles) == 0 {
		return nil
	}
	bySymbol := map[string][]domain.DailyCandle{}
	for _, c := range candles {
		bySymbol[c.Symbol] = append(bySymbol[c.Symbol], c)
	}
	for symbol, rows := range bySymbol {
		ts := make([]int64, len(rows))
		opens := make([]float64, len(rows))
		highs := make([]float64, len(rows))
		lows := make([]float64, len(rows))
		closes := make([]float64, len(rows))
		for i, r := range rows {
			ts[i], opens[i], highs[i], lows[i], closes[i] = r.Timestamp, r.Open, r.High, r.Low, r.Close
		}
		if _, err := s.pool.Exec(ctx,
			`INSERT INTO daily_data (symbol, timestamp, open, high, low, close)
			 SELECT $1, unnest($2::bigint[]), unnest($3::float8[]),
			        unnest($4::float8[]), unnest($5::float8[]), unnest($6::float8[])
			 ON CONFLICT (symbol, timestamp) DO NOTHING`,
			symbol, ts, opens, highs, lows, closes); err != nil {
			return err
		}
	}
	return nil
}
