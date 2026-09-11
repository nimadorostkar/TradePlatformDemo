// Package observability wires structured logging, health/readiness, and (later)
// metrics and tracing. It replaces the .NET Serilog setup with stdlib log/slog.
package observability

import (
	"io"
	"log/slog"
	"os"
	"strings"

	"gopkg.in/natefinch/lumberjack.v2"
)

// LogConfig configures log destination and rotation.
type LogConfig struct {
	Level      string
	Format     string // json | text
	File       string // empty = stdout; otherwise a rotating file
	MaxSizeMB  int
	MaxBackups int
	MaxAgeDays int
}

// NewLogger builds a slog.Logger writing to stdout (used by tests/dev).
func NewLogger(level, format string) *slog.Logger {
	return NewLoggerFor(LogConfig{Level: level, Format: format})
}

// NewLoggerFor builds a slog.Logger. When cfg.File is set it writes to a
// size-rotated, compressed file (lumberjack) so logs never fill the disk;
// otherwise it writes to stdout.
func NewLoggerFor(cfg LogConfig) *slog.Logger {
	var w io.Writer = os.Stdout
	if strings.TrimSpace(cfg.File) != "" {
		w = &lumberjack.Logger{
			Filename:   cfg.File,
			MaxSize:    orDefault(cfg.MaxSizeMB, 50),
			MaxBackups: orDefault(cfg.MaxBackups, 5),
			MaxAge:     orDefault(cfg.MaxAgeDays, 14),
			Compress:   true,
		}
	}
	opts := &slog.HandlerOptions{Level: parseLevel(cfg.Level)}
	var handler slog.Handler
	if strings.EqualFold(cfg.Format, "text") {
		handler = slog.NewTextHandler(w, opts)
	} else {
		handler = slog.NewJSONHandler(w, opts)
	}
	return slog.New(handler)
}

func orDefault(v, def int) int {
	if v <= 0 {
		return def
	}
	return v
}

func parseLevel(level string) slog.Level {
	switch strings.ToLower(strings.TrimSpace(level)) {
	case "debug":
		return slog.LevelDebug
	case "warn", "warning":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}
