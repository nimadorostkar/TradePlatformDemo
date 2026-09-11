package domain

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
)

// switchableClient answers with body until failed is set, then errors — the
// shape of the 2026-08-24 upstream stall cycles.
type switchableClient struct {
	body   []byte
	failed bool
}

func (c *switchableClient) Get(_ context.Context, _ string) ([]byte, error) {
	if c.failed {
		return nil, errors.New("upstream stalled")
	}
	return c.body, nil
}
func (c *switchableClient) Post(_ context.Context, _ string, _ []byte) ([]byte, error) {
	return c.Get(nil, "")
}

const symbolBody = `{"retcode":"0 Done","answer":{"Symbol":"EURUSD","Digits":5,"ContractSize":100000}}`
const maskBody = `{"retcode":"0 Done","answer":[{"Symbol":"EURUSD"},{"Symbol":"XAUUSD"}]}`

// A symbol once answered stays answerable through an upstream failure: the
// chart's resolveSymbol — and with it the whole trading surface — must not go
// down because the broker is having a bad minute.
func TestGetSymbolsByName_ServesStaleThroughUpstreamFailure(t *testing.T) {
	client := &switchableClient{body: []byte(symbolBody)}
	svc := NewSymbolService(client, "EURUSD")

	if env := svc.GetSymbolsByName(context.Background(), "EURUSD!", SourceMT5); !env.Success {
		t.Fatal("healthy upstream: expected success")
	}

	client.failed = true
	env := svc.GetSymbolsByName(context.Background(), "EURUSD!", SourceMT5)
	if !env.Success {
		t.Fatal("a symbol served once must survive the upstream failing")
	}
	if raw, ok := env.Data.(json.RawMessage); !ok || string(raw) != symbolBody {
		t.Fatalf("stale data = %#v, want the remembered body", env.Data)
	}

	// The tv transform must work from the stale body too.
	tv := svc.GetSymbolsByName(context.Background(), "EURUSD!", SourceTV)
	if !tv.Success {
		t.Fatal("tv transform of the stale record failed")
	}
}

func TestGetSymbolsByMask_ServesStaleThroughUpstreamFailure(t *testing.T) {
	client := &switchableClient{body: []byte(maskBody)}
	svc := NewSymbolService(client, "EURUSD")

	if env := svc.GetSymbolsByMask(context.Background(), "*USD*", SourceTV); !env.Success {
		t.Fatal("healthy upstream: expected success")
	}

	client.failed = true
	env := svc.GetSymbolsByMask(context.Background(), "*USD*", SourceTV)
	if !env.Success {
		t.Fatal("a mask answered once must survive the upstream failing")
	}
}

// A path never answered has nothing to serve: the failure passes through
// unchanged, never an invented success.
func TestGetSymbolsByName_NoCacheNoInvention(t *testing.T) {
	client := &switchableClient{failed: true}
	svc := NewSymbolService(client, "EURUSD")

	env := svc.GetSymbolsByName(context.Background(), "GBPUSD!", SourceMT5)
	if env.Success {
		t.Fatal("an unseen symbol must fail when the upstream fails")
	}
}

// The cache is keyed by the full request path: one symbol's record must never
// answer for another.
func TestStaleCache_KeyedPerSymbol(t *testing.T) {
	client := &switchableClient{body: []byte(symbolBody)}
	svc := NewSymbolService(client, "EURUSD")
	_ = svc.GetSymbolsByName(context.Background(), "EURUSD!", SourceMT5)

	client.failed = true
	if env := svc.GetSymbolsByName(context.Background(), "XAUUSD!", SourceMT5); env.Success {
		t.Fatal("XAUUSD answered from EURUSD's cached record")
	}
}
