package domain

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

// The TIME-001 contract, service by service: windows a client sends in UTC
// reach MT5 on the broker's clock, and broker-stamped times come back in UTC.
// A UTC+3 offset reproduces the production observation (a fresh trade
// invisible to "today" for three hours, positions shown 3h in the future).

const testBrokerOffset = 3 * 3600

// pathRecordingClient captures the MT5 path and serves a fixed body.
type pathRecordingClient struct {
	path string
	body []byte
}

func (f *pathRecordingClient) Get(_ context.Context, path string) ([]byte, error) {
	f.path = path
	return f.body, nil
}
func (f *pathRecordingClient) Post(_ context.Context, path string, _ []byte) ([]byte, error) {
	f.path = path
	return f.body, nil
}

func fixedClock(offset int64) BrokerClock {
	return func(context.Context) int64 { return offset }
}

func TestDealPage_WindowShiftedInTimesShiftedOut(t *testing.T) {
	c := &pathRecordingClient{body: []byte(`{"retcode":"0 Done","answer":[{"Deal":"11","Time":1754844000,"TimeMsc":1754844000123}]}`)}
	svc := NewDealService(c, WithDealBrokerClock(fixedClock(testBrokerOffset)))

	env := svc.GetDealPagebyPage(context.Background(), 42, "1754833200", "1754833300", 0, 100)
	if !env.Success {
		t.Fatalf("expected success: %+v", env)
	}
	// The window MT5 sees is the broker's clock: +3h.
	if !strings.Contains(c.path, "from=1754844000") || !strings.Contains(c.path, "to=1754844100") {
		t.Errorf("window not shifted onto the broker clock: %s", c.path)
	}
	// The deal times the client sees are UTC: −3h.
	data := marshal(t, env.Data)
	if !strings.Contains(data, `"Time":1754833200`) || !strings.Contains(data, `"TimeMsc":1754833200123`) {
		t.Errorf("deal times not restated in UTC: %s", data)
	}
}

func TestDealPage_NoClockIsLegacyPassthrough(t *testing.T) {
	c := &pathRecordingClient{body: []byte(`{"retcode":"0 Done","answer":[{"Time":1754844000}]}`)}
	env := NewDealService(c).GetDealPagebyPage(context.Background(), 42, "1754833200", "1754833300", 0, 100)
	if !strings.Contains(c.path, "from=1754833200") {
		t.Errorf("nil clock must not rewrite the window: %s", c.path)
	}
	if data := marshal(t, env.Data); !strings.Contains(data, `"Time":1754844000`) {
		t.Errorf("nil clock must not rewrite deal times: %s", data)
	}
}

func TestHistoryPage_TVTimesAreUTC(t *testing.T) {
	c := &pathRecordingClient{body: []byte(`{"retcode":"0 Done","answer":[{"Order":"7","TimeSetup":1754844000,"State":3}]}`)}
	svc := NewHistoryService(c, WithHistoryBrokerClock(fixedClock(testBrokerOffset)))

	env := svc.ClosedOrderPageByPage(context.Background(), 42, 1754833200, 1754833300, 0, 100, SourceTV)
	if !strings.Contains(c.path, "from=1754844000") || !strings.Contains(c.path, "to=1754844100") {
		t.Errorf("history window not shifted onto the broker clock: %s", c.path)
	}
	data := marshal(t, env.Data)
	if !strings.Contains(data, `"timeSetup":1754833200`) {
		t.Errorf("closed-order timeSetup not UTC: %s", data)
	}
}

func TestHistoryPage_OpenEndedWindowStaysOpen(t *testing.T) {
	c := &pathRecordingClient{body: []byte(`{"retcode":"0 Done","answer":[]}`)}
	svc := NewHistoryService(c, WithHistoryBrokerClock(fixedClock(testBrokerOffset)))
	svc.ClosedOrderPageByPage(context.Background(), 42, 0, 0, 0, 100, SourceTV)
	// from=0/to=0 are "unbounded" markers, not epochs; shifting them would
	// silently narrow the query to 03:00 on 1970-01-01.
	if !strings.Contains(c.path, "from=0") || !strings.Contains(c.path, "to=0") {
		t.Errorf("unbounded window must pass through: %s", c.path)
	}
}

func TestPositionsPage_TimeCreateIsUTC(t *testing.T) {
	c := &pathRecordingClient{body: []byte(`{"retcode":"0 Done","answer":[{"Position":106085337,"Symbol":"EURUSD","TimeCreate":1754844000}]}`)}
	svc := NewPositionService(c, WithPositionBrokerClock(fixedClock(testBrokerOffset)))

	env := svc.GetPagebyPagePosition(context.Background(), 42, 0, 100, SourceTV)
	data := marshal(t, env.Data)
	if !strings.Contains(data, `"timeCreate":1754833200`) {
		t.Errorf("position timeCreate not UTC: %s", data)
	}
}

func TestExecutionsSince_WindowAndCursorOnOneClock(t *testing.T) {
	c := &pathRecordingClient{body: []byte(`{"retcode":"0 Done","answer":[{"Deal":"11","Action":0,"Time":1754844000,"TimeMsc":1754844000123}]}`)}
	svc := NewDealService(c, WithDealBrokerClock(fixedClock(testBrokerOffset)))

	env := svc.ExecutionsSince(context.Background(), 42, 1754833100, 10)
	if !env.Success {
		t.Fatalf("expected success: %+v", env)
	}
	// The window sent to MT5 starts at the UTC cursor restated on the broker
	// clock (+3h).
	if !strings.Contains(c.path, "from=1754843900") {
		t.Errorf("executions window not on the broker clock: %s", c.path)
	}
	data := marshal(t, env.Data)
	if !strings.Contains(data, `"timeSeconds":1754833200`) {
		t.Errorf("execution cursor time not UTC: %s", data)
	}
}

func TestTradeExpiration_ShiftedToBrokerClock(t *testing.T) {
	// A GTD order whose UTC deadline is 1754833200 must reach the dealer as
	// broker-clock 1754844000, or it expires three hours early.
	body := shiftExpirationToBroker(
		normalizeTradeRequest([]byte(`{"Action":"200","TypeTime":2,"TimeExpiration":1754833200}`)),
		testBrokerOffset)
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(body, &fields); err != nil {
		t.Fatalf("body does not parse: %v", err)
	}
	if got := strings.TrimSpace(string(fields["TimeExpiration"])); got != "1754844000" {
		t.Errorf("TimeExpiration = %s, want 1754844000", got)
	}

	// No expiry stays no expiry.
	body = shiftExpirationToBroker([]byte(`{"Action":"200","TimeExpiration":0}`), testBrokerOffset)
	if err := json.Unmarshal(body, &fields); err != nil {
		t.Fatalf("body does not parse: %v", err)
	}
	if got := strings.TrimSpace(string(fields["TimeExpiration"])); got != "0" {
		t.Errorf("zero TimeExpiration must pass through, got %s", got)
	}
}
