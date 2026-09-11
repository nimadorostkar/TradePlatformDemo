package appdata

import (
	"context"
	"encoding/json"
	"os"
	"testing"
	"time"

	"github.com/nimadorostkar/TradePlatformDemo/backend/internal/domain"
)

// These tests run the real SQL. They need a PostgreSQL to talk to and are
// skipped without one:
//
//	docker run -d --name opo-pg -e POSTGRES_PASSWORD=test -e POSTGRES_DB=opotest \
//	  -p 55432:5432 postgres:16-alpine
//	APPDATA_TEST_DSN='postgres://postgres:test@127.0.0.1:55432/opotest?sslmode=disable' \
//	  go test ./internal/store/appdata/
//
// Skipping rather than failing keeps `go test ./...` green on a machine with no
// database, while still exercising the schema and every query wherever one is
// available.
func testStore(t *testing.T) *Store {
	t.Helper()
	dsn := os.Getenv("APPDATA_TEST_DSN")
	if dsn == "" {
		t.Skip("APPDATA_TEST_DSN not set; skipping database-backed tests")
	}
	ctx := context.Background()
	s, err := New(ctx, dsn, 4)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	if err := s.Migrate(ctx); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	// Each test starts from a clean slate so ordering assertions hold.
	if _, err := s.pool.Exec(ctx, `TRUNCATE price_alerts, workspaces`); err != nil {
		t.Fatalf("truncate: %v", err)
	}
	t.Cleanup(s.Close)
	return s
}

func TestAlertLifecycle(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()

	created, err := s.CreateAlert(ctx, domain.Alert{
		Login: "1010", Symbol: "EURUSD", Condition: domain.AlertAbove, Price: 1.1, Note: "watch",
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if created.ID == 0 || created.Status != domain.AlertActive || created.CreatedAt.IsZero() {
		t.Fatalf("created alert wrong: %+v", created)
	}
	if created.TriggeredAt != nil || created.TriggeredPrice != nil {
		t.Errorf("a new alert has not triggered: %+v", created)
	}

	listed, err := s.ListAlerts(ctx, "1010")
	if err != nil || len(listed) != 1 {
		t.Fatalf("list: %v %+v", err, listed)
	}
	if other, _ := s.ListAlerts(ctx, "2020"); len(other) != 0 {
		t.Errorf("another login must not see this alert: %+v", other)
	}

	symbols, err := s.ActiveAlertSymbols(ctx)
	if err != nil || len(symbols) != 1 || symbols[0] != "EURUSD" {
		t.Fatalf("active symbols: %v %+v", err, symbols)
	}
	active, err := s.ActiveAlertsForSymbol(ctx, "EURUSD")
	if err != nil || len(active) != 1 {
		t.Fatalf("active for symbol: %v %+v", err, active)
	}

	// Only the first mark wins — this is what stops two replicas firing the
	// same alert twice.
	at := time.Now().UTC().Truncate(time.Millisecond)
	fired, err := s.MarkAlertTriggered(ctx, created.ID, at, 1.1005)
	if err != nil || !fired {
		t.Fatalf("first mark: %v %v", fired, err)
	}
	again, err := s.MarkAlertTriggered(ctx, created.ID, at, 1.2)
	if err != nil || again {
		t.Fatalf("second mark must not win: %v %v", again, err)
	}

	// A triggered alert leaves the evaluator's work list.
	if symbols, _ := s.ActiveAlertSymbols(ctx); len(symbols) != 0 {
		t.Errorf("a fired alert must not stay in the work list: %+v", symbols)
	}

	since, err := s.ListAlertsTriggeredSince(ctx, "1010", at.Add(-time.Minute))
	if err != nil || len(since) != 1 {
		t.Fatalf("triggered since: %v %+v", err, since)
	}
	if since[0].TriggeredPrice == nil || *since[0].TriggeredPrice != 1.1005 {
		t.Errorf("triggered price not stored: %+v", since[0])
	}
	if after, _ := s.ListAlertsTriggeredSince(ctx, "1010", at.Add(time.Minute)); len(after) != 0 {
		t.Errorf("the cursor must exclude older triggers: %+v", after)
	}
}

// Deleting must be scoped to the owner in the DELETE itself, not only in the
// service layer.
func TestDeleteAlertIsScopedToOwner(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()

	created, err := s.CreateAlert(ctx, domain.Alert{
		Login: "1010", Symbol: "EURUSD", Condition: domain.AlertBelow, Price: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	if deleted, err := s.DeleteAlert(ctx, created.ID, "2020"); err != nil || deleted {
		t.Fatalf("another login deleted the alert: %v %v", deleted, err)
	}
	if deleted, err := s.DeleteAlert(ctx, created.ID, "1010"); err != nil || !deleted {
		t.Fatalf("the owner could not delete: %v %v", deleted, err)
	}
	if deleted, _ := s.DeleteAlert(ctx, created.ID, "1010"); deleted {
		t.Error("deleting twice must report not-found")
	}
}

// The CHECK constraints are the last line of defence behind service validation.
func TestAlertConstraintsRejectBadValues(t *testing.T) {
	s := testStore(t)
	if _, err := s.CreateAlert(context.Background(), domain.Alert{
		Login: "1010", Symbol: "EURUSD", Condition: "sideways", Price: 1,
	}); err == nil {
		t.Error("an invalid condition must be rejected by the database too")
	}
}

func TestWorkspaceUpsert(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()

	if _, found, err := s.GetWorkspace(ctx, "1010"); err != nil || found {
		t.Fatalf("an unsaved workspace must report not-found: %v %v", found, err)
	}

	const doc = `{"layout": "grid", "charts": [{"symbol": "EURUSD"}]}`
	saved, err := s.SaveWorkspace(ctx, "1010", []byte(doc))
	if err != nil {
		t.Fatalf("save: %v", err)
	}
	if saved.Version != 1 {
		t.Errorf("first version = %d, want 1", saved.Version)
	}

	got, found, err := s.GetWorkspace(ctx, "1010")
	if err != nil || !found {
		t.Fatalf("get: %v %v", found, err)
	}
	// jsonb normalizes whitespace and key order, so compare semantically —
	// what must survive is the content, which is all the client relies on.
	var want, have any
	if err := json.Unmarshal([]byte(doc), &want); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(got.Document, &have); err != nil {
		t.Fatalf("stored document is not JSON: %s", got.Document)
	}
	if wantJSON, _ := json.Marshal(want); string(wantJSON) != mustMarshal(t, have) {
		t.Errorf("document changed:\n got: %s\nwant: %s", got.Document, doc)
	}

	// A second save updates in place and bumps the version.
	second, err := s.SaveWorkspace(ctx, "1010", []byte(`{"layout":"single"}`))
	if err != nil {
		t.Fatalf("second save: %v", err)
	}
	if second.Version != 2 {
		t.Errorf("second version = %d, want 2", second.Version)
	}
	if !second.UpdatedAt.After(saved.UpdatedAt) && !second.UpdatedAt.Equal(saved.UpdatedAt) {
		t.Errorf("updated_at went backwards: %v → %v", saved.UpdatedAt, second.UpdatedAt)
	}
}

func mustMarshal(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// The advisory lock is what keeps one replica evaluating alerts at a time.
func TestTryLock(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	const key = int64(0x4f504f414c525453)

	ok, release, err := s.TryLock(ctx, key)
	if err != nil || !ok {
		t.Fatalf("first lock: %v %v", ok, err)
	}
	second, releaseSecond, err := s.TryLock(ctx, key)
	if err != nil {
		t.Fatalf("second lock: %v", err)
	}
	if second {
		releaseSecond()
		t.Fatal("the lock must not be granted twice")
	}
	release()

	third, releaseThird, err := s.TryLock(ctx, key)
	if err != nil || !third {
		t.Fatalf("lock must be reacquirable after release: %v %v", third, err)
	}
	releaseThird()
}
