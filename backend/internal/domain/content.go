package domain

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/nimadorostkar/TradePlatformDemo/backend/internal/httpapi/response"
)

// News and the economic calendar are pass-through: whichever provider the firm
// already licenses is the source of truth, and the gateway's only jobs are to
// keep the API key off the client, bound the request, and cache the answer so a
// hundred open terminals are one upstream call.

// ContentProvider configures one upstream feed.
type ContentProvider struct {
	// URL is the provider endpoint. Empty disables the feed — the endpoint then
	// says so explicitly instead of returning an empty list, which would look
	// like "no news today".
	URL string
	// APIKey is sent in APIKeyHeader (or as the `apikey` query parameter when
	// the header name is empty). It never reaches the client.
	APIKey       string
	APIKeyHeader string
}

// Configured reports whether the feed can be served.
func (p ContentProvider) Configured() bool { return strings.TrimSpace(p.URL) != "" }

// ContentConfig configures the news + calendar service.
type ContentConfig struct {
	News     ContentProvider
	Calendar ContentProvider
	CacheTTL time.Duration
	Timeout  time.Duration
}

// ContentService proxies the news and economic-calendar feeds.
type ContentService struct {
	cfg    ContentConfig
	client *http.Client

	mu    sync.Mutex
	cache map[string]cachedContent
}

type cachedContent struct {
	payload json.RawMessage
	expires time.Time
}

// forwardedParams is the allowlist of query parameters passed upstream. It is
// an allowlist rather than a copy of the client's query string so a client can
// never inject an API key, an alternate host, or a pagination bomb into the
// provider request.
var forwardedParams = []string{"symbol", "symbols", "from", "to", "limit", "lang", "country", "importance", "category"}

// NewContentService constructs the service.
func NewContentService(cfg ContentConfig) *ContentService {
	if cfg.CacheTTL <= 0 {
		cfg.CacheTTL = time.Minute
	}
	if cfg.Timeout <= 0 {
		cfg.Timeout = 10 * time.Second
	}
	return &ContentService{
		cfg:    cfg,
		client: &http.Client{Timeout: cfg.Timeout},
		cache:  map[string]cachedContent{},
	}
}

// NewsEnabled reports whether a news provider is configured.
func (s *ContentService) NewsEnabled() bool { return s != nil && s.cfg.News.Configured() }

// CalendarEnabled reports whether a calendar provider is configured.
func (s *ContentService) CalendarEnabled() bool { return s != nil && s.cfg.Calendar.Configured() }

// News → GET /api/News/list
func (s *ContentService) News(ctx context.Context, query url.Values) response.GlobalResponse {
	return s.fetch(ctx, "news", s.cfg.News, query,
		"News is unavailable: no news provider is configured on this gateway.")
}

// Calendar → GET /api/Calendar/list
func (s *ContentService) Calendar(ctx context.Context, query url.Values) response.GlobalResponse {
	return s.fetch(ctx, "calendar", s.cfg.Calendar, query,
		"The economic calendar is unavailable: no calendar provider is configured on this gateway.")
}

func (s *ContentService) fetch(ctx context.Context, kind string, p ContentProvider, query url.Values, disabledMsg string) response.GlobalResponse {
	if !p.Configured() {
		return failWith(disabledMsg)
	}
	forwarded := filterParams(query)
	key := kind + "?" + forwarded.Encode()
	if payload, ok := s.cached(key); ok {
		return response.Success(payload, SuccessMessage)
	}

	target, err := url.Parse(p.URL)
	if err != nil {
		return catchError(err)
	}
	merged := target.Query()
	for name, values := range forwarded {
		for _, v := range values {
			merged.Add(name, v)
		}
	}
	if p.APIKey != "" && p.APIKeyHeader == "" {
		merged.Set("apikey", p.APIKey)
	}
	target.RawQuery = merged.Encode()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
	if err != nil {
		return catchError(err)
	}
	req.Header.Set("Accept", "application/json")
	if p.APIKey != "" && p.APIKeyHeader != "" {
		req.Header.Set(p.APIKeyHeader, p.APIKey)
	}

	resp, err := s.client.Do(req)
	if err != nil {
		return catchError(err)
	}
	defer resp.Body.Close()
	// Bounded read: an upstream that streams forever must not take the gateway
	// with it.
	body, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return catchError(err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return failWith("Provider returned " + resp.Status + " for the " + kind + " feed.")
	}
	if !json.Valid(body) {
		return failWith("Provider returned a non-JSON " + kind + " response.")
	}

	payload := json.RawMessage(body)
	s.store(key, payload)
	return response.Success(payload, SuccessMessage)
}

func (s *ContentService) cached(key string) (json.RawMessage, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e, ok := s.cache[key]
	if !ok || time.Now().After(e.expires) {
		return nil, false
	}
	return e.payload, true
}

func (s *ContentService) store(key string, payload json.RawMessage) {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	for k, e := range s.cache {
		if now.After(e.expires) {
			delete(s.cache, k)
		}
	}
	s.cache[key] = cachedContent{payload: payload, expires: now.Add(s.cfg.CacheTTL)}
}

// filterParams keeps only the allowlisted parameters, deduplicated and sorted
// so two equivalent client queries share one cache entry.
func filterParams(query url.Values) url.Values {
	out := url.Values{}
	for _, name := range forwardedParams {
		values := query[name]
		if len(values) == 0 {
			continue
		}
		cleaned := make([]string, 0, len(values))
		for _, v := range values {
			if v = strings.TrimSpace(v); v != "" {
				cleaned = append(cleaned, v)
			}
		}
		if len(cleaned) == 0 {
			continue
		}
		sort.Strings(cleaned)
		out[name] = cleaned
	}
	return out
}
