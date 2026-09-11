package domain

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

// fakeClient returns a fixed body (and optional error) for any path.
type fakeClient struct {
	body []byte
	err  error
}

func (f *fakeClient) Get(_ context.Context, _ string) ([]byte, error) { return f.body, f.err }
func (f *fakeClient) Post(_ context.Context, _ string, _ []byte) ([]byte, error) {
	return f.body, f.err
}

func marshal(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return string(b)
}

// RAW_STRING passthrough: data must be a JSON-encoded STRING, not a nested object.
func TestOpenOrder_RawStringPassthrough(t *testing.T) {
	body := `{"retcode":"0 Done","answer":{"Order":"123"}}`
	svc := NewOrderService(&fakeClient{body: []byte(body)})
	env := svc.OpenOrder(context.Background(), 123)

	if !env.Success {
		t.Fatal("expected success")
	}
	got := marshal(t, env)
	// data is the escaped string form of the upstream body.
	wantData := `"data":` + mustQuote(body)
	if !strings.Contains(got, wantData) {
		t.Errorf("data not a JSON string\n got: %s\nwant substring: %s", got, wantData)
	}
	if !strings.Contains(got, `"message":"Success: Action performed successfully."`) {
		t.Errorf("missing success message: %s", got)
	}
}

// source=mt5 on a TV-capable endpoint: data must be a nested OBJECT.
func TestGetPage_MT5Object(t *testing.T) {
	body := `{"retcode":"0 Done","answer":[{"Order":"1","Symbol":"EURUSD","Type":0,"State":1}]}`
	svc := NewOrderService(&fakeClient{body: []byte(body)})
	env := svc.GetPage(context.Background(), 1, 0, 10, SourceMT5)
	got := marshal(t, env)
	if !strings.Contains(got, `"data":{"retcode":"0 Done"`) {
		t.Errorf("expected nested object data, got: %s", got)
	}
}

// source=tv: data must be the transformed array with TV fields.
func TestGetPage_TVTransform(t *testing.T) {
	body := `{"retcode":"0 Done","answer":[{"Order":"1","Symbol":"EURUSD","Type":2,"State":1,"VolumeInitial":5,"PriceOrder":1.1,"PriceSL":1.0,"PriceTP":1.2,"VolumeCurrent":3,"Comment":"hi","TimeSetup":1700}]}`
	svc := NewOrderService(&fakeClient{body: []byte(body)})
	env := svc.GetPage(context.Background(), 1, 0, 10, SourceTV)
	got := marshal(t, env)
	// Type 2 → TV Limit(1); State 1 (PLACED) → Working(6); side = 2%2==0 → 1.
	for _, want := range []string{`"type":1`, `"status":6`, `"side":1`, `"symbol":"EURUSD"`, `"limitPrice":1.1`, `"id":"1"`} {
		if !strings.Contains(got, want) {
			t.Errorf("TV output missing %s\n got: %s", want, got)
		}
	}
}

// mustQuote returns the JSON-encoded (quoted+escaped) form of s.
func mustQuote(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}
