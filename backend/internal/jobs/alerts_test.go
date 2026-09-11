package jobs

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"sort"
	"sync"
	"testing"
	"time"

	"github.com/nimadorostkar/TradePlatformDemo/backend/internal/domain"
)

// memAlertStore is an in-memory domain.AlertStore reproducing the real store's
// compare-and-set on MarkAlertTriggered.
type memAlertStore struct {
	mu     sync.Mutex
	nextID int64
	items  map[int64]domain.Alert
}

func newMemAlertStore() *memAlertStore {
	return &memAlertStore{items: map[int64]domain.Alert{}}
}

func (m *memAlertStore) add(login, symbol, condition string, price float64) domain.Alert {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.nextID++
	a := domain.Alert{
		ID: m.nextID, Login: login, Symbol: symbol, Condition: condition,
		Price: price, Status: domain.AlertActive, CreatedAt: time.Now().UTC(),
	}
	m.items[a.ID] = a
	return a
}

func (m *memAlertStore) get(id int64) domain.Alert {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.items[id]
}

func (m *memAlertStore) ListAlerts(context.Context, string) ([]domain.Alert, error) {
	return nil, nil
}

func (m *memAlertStore) ListAlertsTriggeredSince(context.Context, string, time.Time) ([]domain.Alert, error) {
	return nil, nil
}

func (m *memAlertStore) CreateAlert(_ context.Context, a domain.Alert) (domain.Alert, error) {
	return a, nil
}

func (m *memAlertStore) DeleteAlert(context.Context, int64, string) (bool, error) {
	return false, nil
}

func (m *memAlertStore) ActiveAlertSymbols(context.Context) ([]string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	seen := map[string]struct{}{}
	out := []string{}
	for _, a := range m.items {
		if a.Status != domain.AlertActive {
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

func (m *memAlertStore) ActiveAlertsForSymbol(_ context.Context, symbol string) ([]domain.Alert, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := []domain.Alert{}
	for _, a := range m.items {
		if a.Symbol == symbol && a.Status == domain.AlertActive {
			out = append(out, a)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}

func (m *memAlertStore) MarkAlertTriggered(_ context.Context, id int64, at time.Time, price float64) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	a, ok := m.items[id]
	if !ok || a.Status != domain.AlertActive {
		return false, nil
	}
	a.Status = domain.AlertTriggered
	a.TriggeredAt = &at
	a.TriggeredPrice = &price
	m.items[id] = a
	return true, nil
}

// fixedQuotes returns canned prices; a symbol absent from the map is
// unquotable (closed market, bad name).
type fixedQuotes struct {
	prices map[string]float64
	calls  int
}

func (f *fixedQuotes) LastPrice(_ context.Context, symbol string) (float64, error) {
	f.calls++
	p, ok := f.prices[symbol]
	if !ok {
		return 0, errors.New("no quote")
	}
	return p, nil
}

func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func TestAlertEvaluatorFiresCrossedAlerts(t *testing.T) {
	store := newMemAlertStore()
	above := store.add("1010", "EURUSD", domain.AlertAbove, 1.1000)
	below := store.add("1010", "EURUSD", domain.AlertBelow, 1.0900)
	other := store.add("2020", "XAUUSD", domain.AlertAbove, 2500)

	quotes := &fixedQuotes{prices: map[string]float64{"EURUSD": 1.1005, "XAUUSD": 2400}}
	ev := NewAlertEvaluator(store, quotes, nil, time.Second, testLogger())

	if err := ev.EvaluateOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := store.get(above.ID); got.Status != domain.AlertTriggered {
		t.Errorf("crossed alert not fired: %+v", got)
	} else if got.TriggeredPrice == nil || *got.TriggeredPrice != 1.1005 {
		// The market's price, not the level — a trader wants to see how far past it went.
		t.Errorf("triggered price = %v, want the quote 1.1005", got.TriggeredPrice)
	}
	if got := store.get(below.ID); got.Status != domain.AlertActive {
		t.Errorf("uncrossed alert must stay active: %+v", got)
	}
	if got := store.get(other.ID); got.Status != domain.AlertActive {
		t.Errorf("another symbol's uncrossed alert must stay active: %+v", got)
	}
}

// An alert must fire exactly once, however many sweeps run.
func TestAlertEvaluatorFiresOnce(t *testing.T) {
	store := newMemAlertStore()
	a := store.add("1010", "EURUSD", domain.AlertAbove, 1.1)
	quotes := &fixedQuotes{prices: map[string]float64{"EURUSD": 1.2}}
	ev := NewAlertEvaluator(store, quotes, nil, time.Second, testLogger())
	ctx := context.Background()

	for i := 0; i < 3; i++ {
		if err := ev.EvaluateOnce(ctx); err != nil {
			t.Fatal(err)
		}
	}
	fired := store.get(a.ID)
	if fired.Status != domain.AlertTriggered {
		t.Fatalf("alert not fired: %+v", fired)
	}
	// After the first sweep the symbol has no active alerts, so it is not
	// quoted again — the evaluator must not keep polling for a fired alert.
	if quotes.calls != 1 {
		t.Errorf("quote calls = %d, want 1", quotes.calls)
	}
}

// One unquotable symbol must not stop the sweep: the other symbols' alerts are
// still live.
func TestAlertEvaluatorSurvivesUnquotableSymbol(t *testing.T) {
	store := newMemAlertStore()
	store.add("1010", "BADSYM", domain.AlertAbove, 1)
	good := store.add("1010", "EURUSD", domain.AlertAbove, 1.1)

	quotes := &fixedQuotes{prices: map[string]float64{"EURUSD": 1.2}}
	ev := NewAlertEvaluator(store, quotes, nil, time.Second, testLogger())

	if err := ev.EvaluateOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if store.get(good.ID).Status != domain.AlertTriggered {
		t.Error("a quotable symbol's alert must still fire")
	}
}
