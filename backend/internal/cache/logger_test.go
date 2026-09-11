package cache

import (
	"bytes"
	"context"
	"log/slog"
	"strings"
	"testing"
)

// go-redis logs connection-retry notices through a package-level logger that
// writes to stderr by default. The Windows service launcher surfaces a native
// program's stderr through PowerShell's error stream, so under
// $ErrorActionPreference = "Stop" a single such notice terminated the whole
// gateway at startup — an optional, degradable dependency taking down the
// service. SetLogger is what keeps stderr empty.
func TestRedisDiagnosticsGoToSlogNotStderr(t *testing.T) {
	var buf bytes.Buffer
	l := slogRedisLogger{
		log: slog.New(slog.NewTextHandler(&buf, nil)).With(slog.String("component", "redis")),
	}

	l.Printf(context.Background(), "failed to dial after %d attempts", 5)

	out := buf.String()
	// Formatting must happen inside the logger; passing the raw format string
	// through would put "%d" in the log instead of the value.
	if !strings.Contains(out, "failed to dial after 5 attempts") {
		t.Errorf("notice did not reach slog, or was not formatted: %q", out)
	}
	if !strings.Contains(out, "component=redis") {
		t.Errorf("notice is not attributed to redis: %q", out)
	}
}

// SetLogger must be safe to call before any client exists — main calls it
// during startup, right after the logger is built.
func TestSetLoggerIsSafeAtStartup(t *testing.T) {
	SetLogger(slog.New(slog.NewTextHandler(&bytes.Buffer{}, nil)))
}
