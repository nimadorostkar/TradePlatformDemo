package mt5

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

// flapServer fakes the broker behavior observed live on 2026-08-24: an
// authenticated read is refused with 403 while a fresh handshake succeeds
// immediately. `refusals` is how many consecutive data-call 403s to serve
// before answering normally.
func flapServer(t *testing.T, refusals int32) (*httptest.Server, *atomic.Int32, *atomic.Int32) {
	t.Helper()
	var authStarts, dataCalls atomic.Int32
	remaining := atomic.Int32{}
	remaining.Store(refusals)

	mux := http.NewServeMux()
	mux.HandleFunc("/api/auth/start", func(w http.ResponseWriter, _ *http.Request) {
		authStarts.Add(1)
		_, _ = io.WriteString(w, `{"retcode":"0 Done","srv_rand":"a1b2c3d4e5f60718293a4b5c6d7e8f90"}`)
	})
	mux.HandleFunc("/api/auth/answer", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{"retcode":"0 Done"}`)
	})
	mux.HandleFunc("/api/symbol/get", func(w http.ResponseWriter, _ *http.Request) {
		dataCalls.Add(1)
		if remaining.Add(-1) >= 0 {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		_, _ = io.WriteString(w, `{"retcode":"0 Done","answer":[{"Symbol":"EURUSD"}]}`)
	})
	mux.HandleFunc("/api/dealer/send_request", func(w http.ResponseWriter, _ *http.Request) {
		dataCalls.Add(1)
		http.Error(w, "forbidden", http.StatusForbidden)
	})
	return httptest.NewServer(mux), &authStarts, &dataCalls
}

// A single flapped 403 on an allowlisted read is absorbed: the caller gets the
// data, the session stays authenticated, and nobody else pays for it.
func TestDo_ReplaysAllowlistedReadThroughSessionFlap(t *testing.T) {
	server, authStarts, dataCalls := flapServer(t, 1)
	defer server.Close()

	c := testConn(t, server.URL)
	c.cfg.Password = "test"
	c.authenticated.Store(true)

	body, err := c.do(context.Background(), http.MethodGet, "/api/symbol/get?symbol=EURUSD", nil)
	if err != nil {
		t.Fatalf("flapped read failed: %v", err)
	}
	if len(body) == 0 {
		t.Fatal("flapped read returned no body")
	}
	if !c.authenticated.Load() {
		t.Fatal("a single absorbed flap must not leave the session marked dead")
	}
	if got := authStarts.Load(); got != 1 {
		t.Fatalf("auth/start requests = %d, want exactly 1 (the in-place re-auth)", got)
	}
	if got := dataCalls.Load(); got != 2 {
		t.Fatalf("data requests = %d, want 2 (refusal + replay)", got)
	}
}

// A read refused AGAIN across a fresh handshake is a real rejection: the
// caller gets the error and the session is invalidated, exactly as before.
func TestDo_SecondRefusalIsARealSessionRejection(t *testing.T) {
	server, _, dataCalls := flapServer(t, 2)
	defer server.Close()

	c := testConn(t, server.URL)
	c.cfg.Password = "test"
	c.authenticated.Store(true)

	_, err := c.do(context.Background(), http.MethodGet, "/api/symbol/get?symbol=EURUSD", nil)
	var ue *UpstreamError
	if !errors.As(err, &ue) || ue.Status != http.StatusForbidden {
		t.Fatalf("err = %v, want UpstreamError 403", err)
	}
	if c.authenticated.Load() {
		t.Fatal("a read refused twice across a fresh handshake must invalidate the session")
	}
	if got := dataCalls.Load(); got != 2 {
		t.Fatalf("data requests = %d, want exactly 2 (no retry loop)", got)
	}
}

// Mutations are NEVER replayed — a refused dealer request errors immediately
// and invalidates the session, with no second submission.
func TestDo_NeverReplaysAMutation(t *testing.T) {
	server, authStarts, dataCalls := flapServer(t, 99)
	defer server.Close()

	c := testConn(t, server.URL)
	c.cfg.Password = "test"
	c.authenticated.Store(true)

	_, err := c.do(context.Background(), http.MethodPost, "/api/dealer/send_request", []byte(`{}`))
	var ue *UpstreamError
	if !errors.As(err, &ue) || ue.Status != http.StatusForbidden {
		t.Fatalf("err = %v, want UpstreamError 403", err)
	}
	if got := dataCalls.Load(); got != 1 {
		t.Fatalf("dealer requests = %d, want exactly 1 — a mutation must never be replayed", got)
	}
	if got := authStarts.Load(); got != 0 {
		t.Fatalf("auth/start requests = %d, want 0 — no in-place re-auth for mutations", got)
	}
	if c.authenticated.Load() {
		t.Fatal("a refused mutation must still invalidate the session")
	}
}
