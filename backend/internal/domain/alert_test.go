package domain

import (
	"context"
	"encoding/json"
	"sort"
	"sync"
	"testing"
	"time"
)

// FakeAlertStore is an in-memory AlertStore standing in for Postgres.
type FakeAlertStore struct {
	mu     sync.Mutex
	nextID int64
	items  map[int64]Alert
}

// NewFakeAlertStore constructs an in-memory alert store.
func NewFakeAlertStore() *FakeAlertStore {
	return &FakeAlertStore{items: map[int64]Alert{}}
}

func (f *FakeAlertStore) ListAlerts(_ context.Context, login string) ([]Alert, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := []Alert{}
	for _, a := range f.items {
		if a.Login == login {
			out = append(out, a)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID > out[j].ID })
	return out, nil
}

func (f *FakeAlertStore) ListAlertsTriggeredSince(_ context.Context, login string, ts time.Time) ([]Alert, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := []Alert{}
	for _, a := range f.items {
		if a.Login == login && a.TriggeredAt != nil && a.TriggeredAt.After(ts) {
			out = append(out, a)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}

func (f *FakeAlertStore) CreateAlert(_ context.Context, a Alert) (Alert, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.nextID++
	a.ID = f.nextID
	a.Status = AlertActive
	a.CreatedAt = time.Now().UTC()
	f.items[a.ID] = a
	return a, nil
}

func (f *FakeAlertStore) DeleteAlert(_ context.Context, id int64, login string) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if a, ok := f.items[id]; ok && a.Login == login {
		delete(f.items, id)
		return true, nil
	}
	return false, nil
}

func (f *FakeAlertStore) ActiveAlertSymbols(context.Context) ([]string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	seen := map[string]struct{}{}
	out := []string{}
	for _, a := range f.items {
		if a.Status != AlertActive {
			continue
		}
		if _, dup := seen[a.Symbol]; !dup {
			seen[a.Symbol] = struct{}{}
			out = append(out, a.Symbol)
		}
	}
	sort.Strings(out)
	return out, nil
}

func (f *FakeAlertStore) ActiveAlertsForSymbol(_ context.Context, symbol string) ([]Alert, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := []Alert{}
	for _, a := range f.items {
		if a.Symbol == symbol && a.Status == AlertActive {
			out = append(out, a)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}

// MarkAlertTriggered reproduces the real store's compare-and-set, so a racing
// evaluator cannot fire the same alert twice.
func (f *FakeAlertStore) MarkAlertTriggered(_ context.Context, id int64, at time.Time, price float64) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	a, ok := f.items[id]
	if !ok || a.Status != AlertActive {
		return false, nil
	}
	a.Status = AlertTriggered
	a.TriggeredAt = &at
	a.TriggeredPrice = &price
	f.items[id] = a
	return true, nil
}

func TestAlertCreateValidation(t *testing.T) {
	svc := NewAlertService(NewFakeAlertStore())
	ctx := context.Background()

	bad := []AlertRequest{
		{Symbol: "EURUSD", Condition: AlertAbove, Price: 1.1},              // no login
		{Login: "1010", Condition: AlertAbove, Price: 1.1},                 // no symbol
		{Login: "1010", Symbol: "EURUSD", Condition: "sideways", Price: 1}, // bad condition
		{Login: "1010", Symbol: "EURUSD", Condition: AlertAbove, Price: 0}, // bad price
	}
	for _, req := range bad {
		if res := svc.Create(ctx, req); res.Success {
			t.Errorf("invalid request accepted: %+v", req)
		}
	}

	res := svc.Create(ctx, AlertRequest{Login: "1010", Symbol: "EURUSD", Condition: "ABOVE", Price: 1.1, Note: "watch"})
	if !res.Success {
		t.Fatalf("valid request rejected: %+v", res)
	}
	created := res.Data.(Alert)
	if created.ID == 0 || created.Status != AlertActive || created.Condition != AlertAbove {
		t.Errorf("created alert wrong: %+v", created)
	}
}

// Deleting by id alone would let any authenticated trader delete anyone's alert.
func TestAlertDeleteIsScopedToOwner(t *testing.T) {
	store := NewFakeAlertStore()
	svc := NewAlertService(store)
	ctx := context.Background()

	created := svc.Create(ctx, AlertRequest{Login: "1010", Symbol: "EURUSD", Condition: AlertAbove, Price: 1.1}).Data.(Alert)

	if res := svc.Delete(ctx, created.ID, "2020"); res.Success {
		t.Error("another account must not be able to delete this alert")
	}
	if res := svc.Delete(ctx, created.ID, "1010"); !res.Success {
		t.Errorf("the owner must be able to delete: %+v", res)
	}
}

// With no store the endpoints must say why, not return an empty list a trader
// would read as "you have no alerts".
func TestAlertsWithoutStoreReportUnavailable(t *testing.T) {
	svc := NewAlertService(nil)
	ctx := context.Background()
	if svc.Enabled() {
		t.Error("a nil store is not enabled")
	}
	for _, res := range []struct {
		name string
		got  any
	}{
		{"list", svc.List(ctx, "1010")},
		{"create", svc.Create(ctx, AlertRequest{Login: "1010", Symbol: "X", Condition: AlertAbove, Price: 1})},
		{"delete", svc.Delete(ctx, 1, "1010")},
	} {
		b, _ := json.Marshal(res.got)
		var probe struct {
			ErrorMessage *string `json:"errorMessage"`
			Success      bool    `json:"success"`
		}
		_ = json.Unmarshal(b, &probe)
		if probe.Success || probe.ErrorMessage == nil {
			t.Errorf("%s must fail with a reason: %s", res.name, b)
		}
	}
}

func TestAlertCrossedIsInclusive(t *testing.T) {
	cases := []struct {
		condition string
		level     float64
		quote     float64
		want      bool
	}{
		{AlertAbove, 1.1, 1.1001, true},
		{AlertAbove, 1.1, 1.1, true}, // reaching the level is reaching it
		{AlertAbove, 1.1, 1.0999, false},
		{AlertBelow, 1.1, 1.0999, true},
		{AlertBelow, 1.1, 1.1, true},
		{AlertBelow, 1.1, 1.1001, false},
		{"sideways", 1.1, 1.1, false},
	}
	for _, tc := range cases {
		if got := AlertCrossed(tc.condition, tc.level, tc.quote); got != tc.want {
			t.Errorf("AlertCrossed(%q,%v,%v) = %v", tc.condition, tc.level, tc.quote, got)
		}
	}
}

func TestAlertTriggeredSinceIsACursor(t *testing.T) {
	store := NewFakeAlertStore()
	svc := NewAlertService(store)
	ctx := context.Background()

	created := svc.Create(ctx, AlertRequest{Login: "1010", Symbol: "EURUSD", Condition: AlertAbove, Price: 1.1}).Data.(Alert)
	firedAt := time.Now().UTC()
	if _, err := store.MarkAlertTriggered(ctx, created.ID, firedAt, 1.1005); err != nil {
		t.Fatal(err)
	}

	before := svc.TriggeredSince(ctx, "1010", firedAt.Add(-time.Minute).Unix()).Data.([]Alert)
	if len(before) != 1 {
		t.Errorf("a trigger after the cursor must be delivered, got %d", len(before))
	}
	after := svc.TriggeredSince(ctx, "1010", firedAt.Add(time.Minute).Unix()).Data.([]Alert)
	if len(after) != 0 {
		t.Errorf("a trigger before the cursor must not be re-delivered, got %d", len(after))
	}
}
