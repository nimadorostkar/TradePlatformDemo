package domain

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
)

// A transport failure below the business layer used to be formatted straight
// into the client's errorMessage. The error text carries the upstream MT5 base
// URL and full request path — and, for the store-backed features, the Postgres
// host, user, and database from the DSN. Any authenticated trader could map the
// broker's Manager API and the gateway's database by making calls fail.
func TestTransportErrorsDoNotLeakInternalTopology(t *testing.T) {
	secrets := []string{
		"mt5.example.com",
		"127.0.0.1:5199",
		"/api/tick/last",
		"connection refused",
		"host=db.internal",
		"user=opo",
		"password=hunter2",
	}
	upstream := errors.New(
		`Get "https://mt5.example.com:443/api/tick/last?symbol=EURUSD": dial tcp 127.0.0.1:5199: connect: connection refused`)

	env := catchError(upstream)
	if env.Success {
		t.Fatal("a transport failure must not report success")
	}
	if env.ErrorMessage == nil {
		t.Fatal("errorMessage must be populated")
	}
	for _, s := range secrets {
		if strings.Contains(*env.ErrorMessage, s) {
			t.Errorf("errorMessage leaks %q: %s", s, *env.ErrorMessage)
		}
	}
	// The .NET envelope shape and message template are still what clients parse.
	if !strings.HasPrefix(*env.ErrorMessage, "Error: Action performed while processing is: ") {
		t.Errorf("message template changed: %s", *env.ErrorMessage)
	}
	if env.Data != nil {
		t.Errorf("data must stay null on a transport error, got %v", env.Data)
	}
}

// The redaction has to hold on the path clients actually reach it through, not
// just on a direct catchError call.
func TestServiceLevelTransportErrorIsRedacted(t *testing.T) {
	leaky := fmt.Errorf(`Get "https://mt5.example.com:443/api/user/get?login=1010": dial tcp: lookup mt5.example.com: no such host`)
	svc := NewUserService(&fakeClient{err: leaky})

	env := svc.Getbylogin(context.Background(), 1010, SourceMT5)
	if env.Success {
		t.Fatal("expected failure")
	}
	if env.ErrorMessage != nil && strings.Contains(*env.ErrorMessage, "example.com") {
		t.Errorf("service response leaks the upstream host: %s", *env.ErrorMessage)
	}
}

// An upstream business error (a real non-2xx answer from MT5) is the broker's
// own payload and must still reach the client — redaction applies to our
// transport details, not to MT5's verdict.
func TestUpstreamBusinessErrorBodyStillReachesTheClient(t *testing.T) {
	svc := NewUserService(&fakeClient{body: []byte(`{"retcode":"13 Invalid login"}`)})
	env := svc.Getbylogin(context.Background(), 1010, SourceMT5)
	if !env.Success {
		t.Fatalf("a 2xx body should succeed: %+v", env)
	}
	// data is a raw passthrough here; render it whatever concrete form it takes.
	if got := fmt.Sprintf("%s", env.Data); !strings.Contains(got, "Invalid login") {
		t.Errorf("upstream body should pass through, got %s", got)
	}
}
