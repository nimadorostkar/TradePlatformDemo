package main

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// TestPostgresBookRoundTrip needs a database: DEMOMARKET_TEST_DSN=postgres://…
// (for example the `make dev` container, postgres://tradeplatform:dev@127.0.0.1:55432/tradeplatform?sslmode=disable).
// It works in its own schema and drops it afterwards.
func TestPostgresBookRoundTrip(t *testing.T) {
	dsn := os.Getenv("DEMOMARKET_TEST_DSN")
	if dsn == "" {
		t.Skip("set DEMOMARKET_TEST_DSN to run against PostgreSQL")
	}
	pinWeekday(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if _, err := pool.Exec(ctx, `DROP SCHEMA IF EXISTS broker_test CASCADE; CREATE SCHEMA broker_test; SET search_path TO broker_test`); err != nil {
		t.Fatal(err)
	}
	// Every connection of the pool must see the scratch schema.
	pool.Close()
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = "broker_test"
	pool, err = pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	t.Cleanup(func() { _, _ = pool.Exec(context.Background(), `DROP SCHEMA IF EXISTS broker_test CASCADE`) })

	store, err := openPGBrokerStore(ctx, pool)
	if err != nil {
		t.Fatal(err)
	}
	if st, err := store.Load(ctx); err != nil || st != nil {
		t.Fatalf("fresh database: Load = %v, %v; want nil, nil", st, err)
	}

	p := &fixedProvider{ticks: map[string]Tick{}}
	p.set("EURUSD", 1.10000, 1.10010)
	b := newDemoBroker(p, newMemStore(), store)
	// A fill, a partial close (history + deals + a mutated position), and a
	// resting pending order: every table gets a row.
	an := submit(t, b, map[string]any{"Action": "200", "Login": "1010", "Symbol": "EURUSD", "Type": 0, "Volume": 20000})
	wantRetcode(t, an, "10009")
	posID := int64(num(an["Order"]))
	p.set("EURUSD", 1.10100, 1.10110)
	an = submit(t, b, map[string]any{"Action": "200", "Login": "1010", "Symbol": "EURUSD", "Type": 1, "Volume": 10000, "Position": posID})
	wantRetcode(t, an, "10009")
	submit(t, b, map[string]any{"Action": "201", "Login": "1010", "Symbol": "EURUSD", "Type": 2, "Volume": 10000, "PriceOrder": 1.09})
	b.save()
	// A second save with nothing new must not duplicate history.
	b.mu.Lock()
	b.dirty = true
	b.mu.Unlock()
	b.save()

	var deals, history, working, positions int
	if err := pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM broker_deals), (SELECT count(*) FROM broker_orders WHERE NOT working),
		(SELECT count(*) FROM broker_orders WHERE working), (SELECT count(*) FROM broker_positions)`).
		Scan(&deals, &history, &working, &positions); err != nil {
		t.Fatal(err)
	}
	if deals != 2 || history != 2 || working != 1 || positions != 1 {
		t.Fatalf("rows: deals=%d history=%d working=%d positions=%d; want 2/2/1/1", deals, history, working, positions)
	}

	again := newDemoBroker(p, newMemStore(), &pgBrokerStore{pool: pool, persisted: map[int64]persistedCounts{}})
	if again.PositionCount(1010) != 1 || again.OrderCount(1010) != 1 {
		t.Fatal("book not restored from PostgreSQL")
	}
	sum := summaryOf(t, again, 1010)
	if got := num(sum["Balance"]); got != 10090 {
		t.Fatalf("restored balance = %v, want 10090 (1 lot closed 9 pips up)", got)
	}
	an = submit(t, again, map[string]any{"Action": "200", "Login": "1010", "Symbol": "EURUSD", "Type": 0, "Volume": 10000})
	if int64(num(an["Order"])) <= posID+3 {
		t.Fatalf("ticket %v reused after restore", an["Order"])
	}

	// An admin reset empties the tables, not just the memory.
	again.Reset(1010, demoStartBalance)
	again.save()
	if err := pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM broker_deals), (SELECT count(*) FROM broker_orders), (SELECT count(*) FROM broker_positions)`).
		Scan(&deals, &history, &positions); err != nil {
		t.Fatal(err)
	}
	if deals != 0 || history != 0 || positions != 0 {
		t.Fatalf("after reset: deals=%d orders=%d positions=%d; want 0/0/0", deals, history, positions)
	}
}
