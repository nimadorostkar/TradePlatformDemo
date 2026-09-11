package domain

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/nimadorostkar/TradePlatformDemo/backend/internal/httpapi/response"
	"github.com/nimadorostkar/TradePlatformDemo/backend/internal/mt5"
	"github.com/nimadorostkar/TradePlatformDemo/backend/internal/transform"
)

// SymbolService ports SymbolService.cs.
//
// NOTE: the .NET IMemoryCache layer (24h symbol-detail cache, 60m group cache)
// is an optimization with subtle cross-call accumulation semantics. Its
// read-through form remains deferred; what exists here is narrower and serves
// a different master — availability. Every successful by-name/by-mask answer
// is remembered, and when the upstream refuses (the 2026-08-24 stall cycles:
// healthy for minutes, then every call slow-fails until the breaker opens),
// the remembered answer is served with a warning instead of taking the
// terminal's symbol resolution — and with it the whole chart — down. Symbol
// specifications change on the order of never; an hours-stale contract size
// beats a dead trading screen in every scenario that matters.
type SymbolService struct {
	c                 MT5Client
	defaultSymbolList string
	stale             staleCache
}

// NewSymbolService constructs a SymbolService.
func NewSymbolService(c MT5Client, defaultSymbolList string) *SymbolService {
	return &SymbolService{c: c, defaultSymbolList: defaultSymbolList}
}

// staleCacheMaxEntries bounds the fallback cache. Keys are MT5 request paths
// (symbol names and mask lists), a set bounded by the broker's instrument
// catalogue; the cap is a guard against a pathological caller, not a tuning
// knob.
const staleCacheMaxEntries = 8192

type staleEntry struct {
	body []byte
	at   time.Time
}

// staleCache remembers the last successful upstream body per request path,
// for serving THROUGH an upstream failure. It is never consulted while the
// upstream answers, so it cannot make fresh data stale — only dead data live.
type staleCache struct {
	mu      sync.RWMutex
	entries map[string]staleEntry
}

func (sc *staleCache) put(path string, body []byte) {
	sc.mu.Lock()
	defer sc.mu.Unlock()
	if sc.entries == nil {
		sc.entries = make(map[string]staleEntry)
	}
	if _, exists := sc.entries[path]; !exists && len(sc.entries) >= staleCacheMaxEntries {
		return
	}
	stored := make([]byte, len(body))
	copy(stored, body)
	sc.entries[path] = staleEntry{body: stored, at: time.Now()}
}

func (sc *staleCache) get(path string) (body []byte, age time.Duration, ok bool) {
	sc.mu.RLock()
	defer sc.mu.RUnlock()
	e, ok := sc.entries[path]
	if !ok {
		return nil, 0, false
	}
	return e.body, time.Since(e.at), true
}

// fetchGetStale is fetchGet with the availability fallback: a successful
// answer refreshes the cache; a failed one is answered from the cache when a
// previous success is remembered, as the success it once was.
func (s *SymbolService) fetchGetStale(ctx context.Context, path string) (response.GlobalResponse, []byte, bool) {
	env, body, ok := fetchGet(ctx, s.c, path)
	if ok {
		s.stale.put(path, body)
		return env, body, ok
	}
	cached, age, hit := s.stale.get(path)
	if !hit {
		return env, body, ok
	}
	slog.Warn("serving stale symbol record; upstream failed",
		slog.String("endpoint", "/api/symbol/get"),
		slog.String("age", age.Round(time.Second).String()))
	msg := SuccessMessage
	return response.GlobalResponse{Success: true, Message: &msg, Data: string(cached)}, cached, true
}

// GetSymbolList → GET /api/symbol/list → OBJECT<MT5SymbolResponse>.
func (s *SymbolService) GetSymbolList(ctx context.Context) response.GlobalResponse {
	env, body, ok := fetchGet(ctx, s.c, mt5.PathSymbolList)
	if !ok {
		return env
	}
	env.Data = json.RawMessage(body)
	return env
}

// GetSymbolsByName → GET /api/symbol/get?symbol=. tv → []TVSymbolResponse (1);
// else → OBJECT<SymbolByAnswerRoot>.
func (s *SymbolService) GetSymbolsByName(ctx context.Context, symbol, source string) response.GlobalResponse {
	env, body, ok := s.fetchGetStale(ctx, fmt.Sprintf(mt5.PathSymbolGet, symbol))
	if !ok {
		return env
	}
	var root transform.SymbolByAnswerRoot
	if err := json.Unmarshal(body, &root); err != nil {
		return env
	}
	if strings.EqualFold(source, SourceTV) {
		env.Data = []transform.TVSymbolResponse{transform.SymbolByNameToTV(root.Answer)}
		env.Success = true
	} else {
		env.Data = json.RawMessage(body)
	}
	return env
}

// GetSymbolsByMask → GET /api/symbol/get?mask=. tv → []TVSymbolResponse;
// mt5 → OBJECT<SymbolByMaskRoot>; other source → RAW_STRING.
func (s *SymbolService) GetSymbolsByMask(ctx context.Context, mask, source string) response.GlobalResponse {
	if strings.TrimSpace(mask) == "" || mask == "*" {
		mask = s.defaultSymbolList
	}
	env, body, ok := s.fetchGetStale(ctx, fmt.Sprintf(mt5.PathSymbolMask, mask))
	if !ok {
		return env
	}
	var root transform.SymbolByMaskRoot
	if err := json.Unmarshal(body, &root); err != nil {
		return env
	}
	switch {
	case strings.EqualFold(source, SourceTV):
		out := make([]transform.TVSymbolResponse, 0, len(root.Answer))
		for _, a := range root.Answer {
			out = append(out, transform.SymbolByMaskToTV(a))
		}
		env.Data = out
		env.Success = true
	case source == SourceMT5:
		env.Data = json.RawMessage(body)
	default:
		env.Data = string(body)
	}
	return env
}

// GetSymbolsByGroup → GET /api/symbol/get_group. tv → []TVSymbolResponse (1);
// else → OBJECT<SymbolByAnswerRoot>.
func (s *SymbolService) GetSymbolsByGroup(ctx context.Context, symbol, group, source string) response.GlobalResponse {
	env, body, ok := fetchGet(ctx, s.c, fmt.Sprintf(mt5.PathSymbolByGroup, symbol, group))
	if !ok {
		return env
	}
	var root transform.SymbolByAnswerRoot
	if err := json.Unmarshal(body, &root); err != nil {
		return env
	}
	if strings.EqualFold(source, SourceTV) {
		env.Data = []transform.TVSymbolResponse{transform.SymbolByGroupToTV(root.Answer)}
		env.Success = true
	} else {
		env.Data = json.RawMessage(body)
	}
	return env
}

// GetGroup → GET /api/group/get (RAW_STRING).
func (s *SymbolService) GetGroup(ctx context.Context, group string) response.GlobalResponse {
	env, _, _ := fetchGet(ctx, s.c, fmt.Sprintf(mt5.PathGroupGet, group))
	return env
}
