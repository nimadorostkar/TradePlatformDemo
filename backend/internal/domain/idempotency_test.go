package domain

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"
)

// countingMT5 records how many dealer submissions actually reached upstream —
// the number that matters for "a retry must not open a second position".
type countingMT5 struct {
	mu    sync.Mutex
	posts int
}

func (c *countingMT5) Get(_ context.Context, path string) ([]byte, error) {
	if strings.HasPrefix(path, "/api/dealer/get_request_result") {
		return []byte(`{"retcode":"0 Done","answer":{"777":[{"result":"0"},{"result":"0","answer":` +
			`{"Order":"100002","Symbol":"EURUSD","Type":"0","Volume":10000,"ResultRetcode":"10009 Done","ResultPrice":1.085,"ResultVolume":10000}}]}}`), nil
	}
	return []byte(`{"retcode":"0 Done","answer":{}}`), nil
}

func (c *countingMT5) Post(_ context.Context, _ string, _ []byte) ([]byte, error) {
	c.mu.Lock()
	c.posts++
	c.mu.Unlock()
	return []byte(`{"retcode":"0 Done","answer":{"Id":777}}`), nil
}

func (c *countingMT5) count() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.posts
}

func idempotentTradeService(c MT5Client) *TradeService {
	return NewTradeService(c, WithIdempotency(NewMemoryIdempotencyStore(), time.Minute))
}

// The point of the feature: retrying a submission that timed out on the client
// side must return the original result, not open a second position.
func TestSendRequestReplaysOnRepeatedKey(t *testing.T) {
	up := &countingMT5{}
	svc := idempotentTradeService(up)
	body := []byte(`{"Symbol":"EURUSD","Volume":10000,"source":"tv"}`)

	first := svc.SendRequestWithKey(context.Background(), body, "tv", "1010:abc")
	if first.Replayed {
		t.Error("the first submission is not a replay")
	}
	second := svc.SendRequestWithKey(context.Background(), body, "tv", "1010:abc")
	if !second.Replayed {
		t.Error("a repeat of the same key must be served from the window")
	}
	if up.count() != 1 {
		t.Errorf("dealer was called %d times; a retry must not reach it twice", up.count())
	}

	firstJSON, _ := json.Marshal(first.Response)
	secondJSON, _ := json.Marshal(second.Response)
	if string(firstJSON) != string(secondJSON) {
		t.Errorf("replay differs from the original:\n %s\n %s", firstJSON, secondJSON)
	}
}

// Different keys are different orders, and no key at all is the legacy
// behavior: every call goes through.
func TestSendRequestSubmitsForDistinctOrNoKey(t *testing.T) {
	up := &countingMT5{}
	svc := idempotentTradeService(up)
	body := []byte(`{"Symbol":"EURUSD","Volume":10000}`)

	svc.SendRequestWithKey(context.Background(), body, "tv", "1010:a")
	svc.SendRequestWithKey(context.Background(), body, "tv", "1010:b")
	svc.SendRequestWithKey(context.Background(), body, "tv", "")
	if up.count() != 3 {
		t.Errorf("dealer calls = %d, want 3", up.count())
	}
}

// Two accounts picking the same client key must never see each other's trade.
func TestIdempotencyKeysAreScopedPerAccount(t *testing.T) {
	up := &countingMT5{}
	svc := idempotentTradeService(up)
	body := []byte(`{"Symbol":"EURUSD","Volume":10000}`)

	svc.SendRequestWithKey(context.Background(), body, "tv", "1010:same-key")
	other := svc.SendRequestWithKey(context.Background(), body, "tv", "2020:same-key")
	if other.Replayed {
		t.Error("another account's key must not be replayed")
	}
	if up.count() != 2 {
		t.Errorf("dealer calls = %d, want 2", up.count())
	}
}

// A store that cannot answer must not lead to a submission: refusing is
// recoverable, a duplicate position is not.
//
// The refusal is reported as "not_submitted", not "unknown": nothing reached
// the dealer, so no order can exist. A client told "unknown" would have to
// reconcile against Positions for an order that was never sent.
func TestSendRequestRefusesWhenIdempotencyStoreFails(t *testing.T) {
	up := &countingMT5{}
	svc := NewTradeService(up, WithIdempotency(failingIdemStore{}, time.Minute))

	res := svc.SendRequestWithKey(context.Background(), []byte(`{}`), "tv", "1010:abc")
	if res.Response.Success {
		t.Error("a failed idempotency claim must not report success")
	}
	if up.count() != 0 {
		t.Error("nothing may be submitted when the key cannot be claimed")
	}
	if got := outcomeOf(t, res.Response.Data); got != "not_submitted" {
		t.Errorf("outcome = %q, want not_submitted", got)
	}
	if res.Response.Message == nil || res.Response.ErrorMessage == nil {
		t.Errorf("envelope message/errorMessage must not be null: %+v", res.Response)
	}
}

// A repeat that lands while the original submission is still in flight is the
// opposite case: that order may well be live, so it stays "unknown".
func TestSendRequestInFlightRepeatIsUnknown(t *testing.T) {
	store := NewMemoryIdempotencyStore()
	svc := NewTradeService(&countingMT5{}, WithIdempotency(store, time.Minute))
	const key = "1010:in-flight"
	if claimed, err := store.Claim(context.Background(), key, time.Minute); err != nil || !claimed {
		t.Fatalf("seed claim: %v %v", claimed, err)
	}

	// Cancelled context so awaitResult gives up at once rather than polling 2s.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	res := svc.SendRequestWithKey(ctx, []byte(`{}`), "tv", key)
	if got := outcomeOf(t, res.Response.Data); got != "unknown" {
		t.Errorf("outcome = %q, want unknown", got)
	}
}

type failingIdemStore struct{}

func (failingIdemStore) Load(context.Context, string) ([]byte, bool, error) {
	return nil, false, nil
}
func (failingIdemStore) Claim(context.Context, string, time.Duration) (bool, error) {
	return false, context.DeadlineExceeded
}
func (failingIdemStore) Store(context.Context, string, []byte, time.Duration) error { return nil }
func (failingIdemStore) Release(context.Context, string) error                      { return nil }

func outcomeOf(t *testing.T, data any) string {
	t.Helper()
	b, err := json.Marshal(data)
	if err != nil {
		t.Fatal(err)
	}
	var probe struct {
		Outcome string `json:"outcome"`
	}
	if err := json.Unmarshal(b, &probe); err != nil {
		t.Fatalf("data is not an object: %s", b)
	}
	return probe.Outcome
}

func TestMemoryIdempotencyStore(t *testing.T) {
	ctx := context.Background()
	s := NewMemoryIdempotencyStore()

	claimed, err := s.Claim(ctx, "k", time.Minute)
	if err != nil || !claimed {
		t.Fatalf("first claim: %v %v", claimed, err)
	}
	if again, _ := s.Claim(ctx, "k", time.Minute); again {
		t.Error("a claimed key must not be claimable twice")
	}
	// An in-flight claim is not a result.
	if _, found, _ := s.Load(ctx, "k"); found {
		t.Error("an in-flight claim must not load as a result")
	}

	if err := s.Store(ctx, "k", []byte(`{"success":true}`), time.Minute); err != nil {
		t.Fatal(err)
	}
	payload, found, err := s.Load(ctx, "k")
	if err != nil || !found || string(payload) != `{"success":true}` {
		t.Errorf("load after store: %s %v %v", payload, found, err)
	}

	// A released claim frees the key for an immediate retry.
	if _, err := s.Claim(ctx, "r", time.Minute); err != nil {
		t.Fatal(err)
	}
	if err := s.Release(ctx, "r"); err != nil {
		t.Fatal(err)
	}
	if claimed, _ := s.Claim(ctx, "r", time.Minute); !claimed {
		t.Error("a released key must be claimable again")
	}
}

func TestMemoryIdempotencyStoreExpires(t *testing.T) {
	ctx := context.Background()
	s := NewMemoryIdempotencyStore()
	if err := s.Store(ctx, "k", []byte(`{}`), time.Nanosecond); err != nil {
		t.Fatal(err)
	}
	time.Sleep(2 * time.Millisecond)
	if _, found, _ := s.Load(ctx, "k"); found {
		t.Error("an expired entry must not be replayed")
	}
	if claimed, _ := s.Claim(ctx, "k", time.Minute); !claimed {
		t.Error("an expired key must be claimable again")
	}
}

func TestMemoryIdempotencyStoreAmortizesBulkSweep(t *testing.T) {
	ctx := context.Background()
	s := NewMemoryIdempotencyStore()

	if err := s.Store(ctx, "expired-a", []byte(`{}`), time.Nanosecond); err != nil {
		t.Fatal(err)
	}
	if err := s.Store(ctx, "expired-b", []byte(`{}`), time.Nanosecond); err != nil {
		t.Fatal(err)
	}
	time.Sleep(2 * time.Millisecond)

	// Normal access inside the sweep interval removes its requested key only;
	// it does not repeatedly walk the full map.
	if _, found, _ := s.Load(ctx, "expired-a"); found {
		t.Fatal("requested expired key was returned")
	}
	if _, exists := s.entries["expired-b"]; !exists {
		t.Fatal("bulk sweep ran again inside its interval")
	}

	// Once the scheduled sweep is due, the next access clears unrelated
	// expired entries as well.
	s.nextSweep = time.Time{}
	if _, _, err := s.Load(ctx, "missing"); err != nil {
		t.Fatal(err)
	}
	if _, exists := s.entries["expired-b"]; exists {
		t.Fatal("due bulk sweep retained an expired entry")
	}
}
