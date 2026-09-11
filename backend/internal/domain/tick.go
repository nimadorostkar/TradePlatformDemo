package domain

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/nimadorostkar/TradePlatformDemo/backend/internal/httpapi/response"
	"github.com/nimadorostkar/TradePlatformDemo/backend/internal/mt5"
	"github.com/nimadorostkar/TradePlatformDemo/backend/internal/transform"
)

// TickService ports TickService.cs (market data + chart). When a PriceStore is
// provided it serves the DB-backed paths (ReadDataFromDbOrAPI=true and the
// pre-aggregated daily rows in GetHistoryBy1DResolution); otherwise it serves
// the live-API path (the production default, ReadDataFromDbOrAPI=false).
type TickService struct {
	c        MT5Client
	store    PriceStore
	readFrom bool // ReadDataFromDbOrAPI
	bookConv transform.BookConvention
	// clockSymbol is the symbol used to read the broker clock when a caller has
	// none of its own (the account-data services). Any liquid symbol works; the
	// resolved offset is a property of the trade server and cached globally.
	clockSymbol string

	brokerMu          sync.Mutex
	brokerOffset      int64 // broker_time - utc (seconds), rounded to the hour
	brokerCached      int64 // unix seconds when last measured (TTL anchor)
	brokerConfirmedAt int64 // unix seconds the held offset was last confirmed by a reading
	brokerHasOffset   bool  // an offset has been read at least once
	brokerWarnedAt    int64 // unix seconds of the last fallback warning
	brokerRefreshing  bool  // a background refresh of an expired offset is in flight

	bookSubscribe bool // attempt book/subscribe before book/get
	bookMu        sync.Mutex
	bookSubAt     map[string]int64 // symbol -> unix seconds of last successful subscribe
	bookRefusedAt map[string]int64 // symbol -> unix seconds subscription was refused
	bookWarned    map[string]bool  // symbol -> a subscribe refusal has been logged
}

// TickOption customizes a TickService.
type TickOption func(*TickService)

// WithBookConvention selects how upstream market-depth side codes are numbered
// (see transform.BookConvention). Default is the MQL5 numbering.
func WithBookConvention(c transform.BookConvention) TickOption {
	return func(s *TickService) { s.bookConv = c }
}

// WithClockSymbol sets the symbol BrokerOffset reads the broker clock from.
func WithClockSymbol(symbol string) TickOption {
	return func(s *TickService) {
		if symbol != "" {
			s.clockSymbol = symbol
		}
	}
}

// WithBookSubscribe controls whether GetMarketDepth subscribes to a symbol's
// order book before reading it. On by default; see ensureBookSubscription.
func WithBookSubscribe(enabled bool) TickOption {
	return func(s *TickService) { s.bookSubscribe = enabled }
}

// NewTickService constructs a TickService. store may be nil (API-only).
func NewTickService(c MT5Client, store PriceStore, readFromDB bool, opts ...TickOption) *TickService {
	s := &TickService{
		c:             c,
		store:         store,
		readFrom:      readFromDB,
		bookConv:      transform.BookConventionMQL5,
		bookSubscribe: true,
		bookSubAt:     make(map[string]int64),
		bookRefusedAt: make(map[string]int64),
		bookWarned:    make(map[string]bool),
	}
	for _, opt := range opts {
		opt(s)
	}
	return s
}

const (
	brokerOffsetTTL = 30 // seconds a measured broker offset is reused
	// maxPlausibleBrokerOffset bounds a believable trade-server timezone.
	maxPlausibleBrokerOffset = 14 * 3600
	// defaultBrokerOffset is the assumption of last resort: this broker runs
	// EET/EEST. Used only when the clock has never been read, and logged.
	defaultBrokerOffset = 3 * 3600

	// liveChartLookback is how far back each live-chart push reaches. The .NET
	// original used 120s, which at a 3s cadence is ample for the forming candle
	// but leaves a permanent hole the moment a client misses ~2 minutes. Five
	// minutes of M1 is a handful of extra rows per push and covers the ordinary
	// interruptions — a backgrounded tab, a brief reconnect — with no client
	// change at all.
	liveChartLookback = 300
	// maxLiveChartLookback bounds what a client may ask the live window to
	// backfill in one push.
	maxLiveChartLookback = 24 * 3600
	// brokerFallbackWarnEvery throttles the unreadable-clock warning.
	brokerFallbackWarnEvery = 60
	// brokerReanchorWindow is how long a held offset survives without a
	// confirming reading before a LOWER reading may replace it. Long enough
	// that a weekend of closed markets cannot drag the clock down; short
	// enough that a genuine server timezone/DST change lands within a day.
	brokerReanchorWindow = 24 * 3600
)

// MT5 selects and stamps chart data in the trade server's own clock, which is
// not UTC (Opogroup-Server1 runs UTC+3). Everything above the MT5 boundary —
// the REST query strings a client sends, the `time` on every bar returned, and
// the rows written to the price store — is UTC; fetchChartUTC is the single
// place the two bases meet.
//
// Getting this wrong is not a rounding error. The chart used to hand MT5 the
// client's UTC window unconverted, so it selected bars from `offset` seconds
// earlier and returned them stamped in the broker's base, while the live
// subscription (which built its own window from the broker clock) returned bars
// stamped `offset` ahead. History and live disagreed by exactly the broker
// offset, which is the gap that opened in the chart on every login.

// brokerOffsetSeconds returns broker_clock − utc, cached for brokerOffsetTTL.
//
// This resolver mirrors the .NET service's, which was hardened after the same
// clock drift froze its chart 30–60 minutes behind the market (see that repo's
// BUG_REPORT_Chart_Candle_Lag.md). Its three defenses are all load-bearing:
//
//   - Round to the nearest whole hour. The reading is the last tick's time,
//     which trails "now" by however long ago that tick printed — on an illiquid
//     or closed symbol, by many minutes. Hour rounding recovers the true offset
//     from a tick up to ~30 minutes stale, where a finer rounding would enshrine
//     the staleness and drag every chart with it. This broker runs EET/EEST, and
//     whole hours are what MT5 server timezones are.
//   - Reject an implausible offset rather than adopt it: no trade server sits
//     more than 14 hours from UTC, so a bogus tick keeps the last known good
//     value instead of throwing the chart across the world.
//   - Never silently return "no offset". An unread clock falls back to the last
//     known value, and failing that to EEST — with a warning, because a wrong
//     guess here is exactly what freezes a chart.
func (s *TickService) brokerOffsetSeconds(ctx context.Context, symbol string) int64 {
	utcNow := time.Now().UTC().Unix()

	s.brokerMu.Lock()
	if s.brokerHasOffset && utcNow-s.brokerCached < brokerOffsetTTL {
		offset := s.brokerOffset
		s.brokerMu.Unlock()
		return offset
	}
	if s.brokerHasOffset {
		// The TTL has lapsed but a known value is held. The offset is a whole
		// server hour that changes at most twice a year, so the held value is
		// almost certainly still right — serve it NOW and refresh it off the
		// request path. Blocking here was the 2026-08-24 outage's queue: this
		// resolver sits on getServerTime, deals, history and positions, and one
		// stalled upstream read under brokerMu backed every one of them up for
		// the full connect timeout.
		if !s.brokerRefreshing {
			s.brokerRefreshing = true
			go s.refreshBrokerOffset(symbol)
		}
		offset := s.brokerOffset
		s.brokerMu.Unlock()
		return offset
	}
	s.brokerMu.Unlock()

	// Never read: the one case worth waiting for, because guessing EEST here
	// mislabels the broker's trading day for every early caller. The read is
	// bounded by the transport's dial timeout and the circuit breaker, and it
	// deliberately happens OUTSIDE brokerMu so concurrent callers queue on the
	// upstream, not on each other's mutex.
	secs := s.readBrokerTickSeconds(ctx, symbol)

	s.brokerMu.Lock()
	defer s.brokerMu.Unlock()
	if secs > 0 && (!s.brokerHasOffset || utcNow-s.brokerCached >= brokerOffsetTTL) {
		s.acceptBrokerReadingLocked(secs, utcNow, symbol)
	}
	return s.offsetLocked(symbol)
}

// refreshBrokerOffset re-reads an EXPIRED-but-known broker offset in the
// background so no request ever waits on it. Single-flight via
// brokerRefreshing; a failed read simply leaves the held value standing until
// the next caller triggers another attempt.
func (s *TickService) refreshBrokerOffset(symbol string) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	secs := s.readBrokerTickSeconds(ctx, symbol)

	s.brokerMu.Lock()
	defer s.brokerMu.Unlock()
	s.brokerRefreshing = false
	if secs > 0 {
		s.acceptBrokerReadingLocked(secs, time.Now().UTC().Unix(), symbol)
	}
}

// observeBrokerClock folds a reading into the cache from a tick the caller has
// already fetched, and returns the offset to use.
//
// The quote path pulls /api/tick/last on every push, and that response carries
// the broker's clock. Deriving the offset from it keeps the hottest path at one
// upstream call instead of two — asking brokerOffsetSeconds here would fetch
// the very same endpoint a second time on every cache miss — and it keeps the
// cache warm for the chart path at no cost.
func (s *TickService) observeBrokerClock(answer []transform.TicklastAnswer, symbol string) int64 {
	utcNow := time.Now().UTC().Unix()

	s.brokerMu.Lock()
	defer s.brokerMu.Unlock()

	if secs := brokerTickSeconds(answer); secs > 0 && (!s.brokerHasOffset || utcNow-s.brokerCached >= brokerOffsetTTL) {
		s.acceptBrokerReadingLocked(secs, utcNow, symbol)
	}
	return s.offsetLocked(symbol)
}

// acceptBrokerReadingLocked adopts a reading if it is plausible. Caller holds
// brokerMu.
//
// A quote is stamped in the broker's PAST, never its future, so a reading can
// only ever understate the true offset — by exactly how stale the tick is. The
// cache is global and readings arrive from whatever symbol happens to refresh
// it, including closed markets whose last tick is hours old: adopting every
// reading let one stock that stopped trading yesterday drag the clock down and
// shift every chart on the terminal by the staleness (observed live as the
// offset flapping +3h → +2h → −1h → −14h across an afternoon). A LOWER reading
// is therefore evidence of a stale tick, not of a clock change, and is ignored
// while the held value keeps being confirmed. Only when nothing has confirmed
// it for brokerReanchorWindow may a lower reading re-anchor the clock — which
// is how a genuine server timezone/DST change still lands.
func (s *TickService) acceptBrokerReadingLocked(brokerSecs, utcNow int64, symbol string) {
	rounded := roundToHour(brokerSecs - utcNow)
	if rounded > maxPlausibleBrokerOffset || rounded < -maxPlausibleBrokerOffset {
		slog.Warn("implausible broker clock offset ignored; keeping the last known value",
			slog.String("symbol", symbol), slog.Int64("offset_seconds", rounded))
		return
	}
	if s.brokerHasOffset && rounded < s.brokerOffset &&
		utcNow-s.brokerConfirmedAt < brokerReanchorWindow {
		// Stale-tick reading: keep the held offset, refresh the TTL anchor so
		// the next read happens on schedule rather than on every push.
		s.brokerCached = utcNow
		return
	}
	if !s.brokerHasOffset || s.brokerOffset != rounded {
		slog.Info("broker clock offset resolved",
			slog.String("symbol", symbol),
			slog.Int64("offset_seconds", rounded),
			slog.Int("ttl_seconds", brokerOffsetTTL))
	}
	s.brokerOffset, s.brokerCached, s.brokerHasOffset = rounded, utcNow, true
	s.brokerConfirmedAt = utcNow
}

// offsetLocked returns the offset in force: the cached value, else the EEST
// assumption. Caller holds brokerMu.
//
// The fallback warning is throttled. Every chart and quote push resolves the
// offset, so on a broker whose clock cannot be read this line would otherwise
// repeat several times a second and bury the rest of the log.
func (s *TickService) offsetLocked(symbol string) int64 {
	if s.brokerHasOffset {
		return s.brokerOffset
	}
	if now := time.Now().Unix(); now-s.brokerWarnedAt >= brokerFallbackWarnEvery {
		s.brokerWarnedAt = now
		slog.Warn("broker clock could not be read; assuming EEST for chart times — the chart will drift if this broker is not on UTC+3",
			slog.String("symbol", symbol), slog.Int64("assumed_offset_seconds", defaultBrokerOffset))
	}
	return defaultBrokerOffset
}

// readBrokerTickSeconds reads the broker's clock off its latest quote. It
// performs an upstream call and must be invoked WITHOUT brokerMu held — a
// stalled upstream under that mutex serializes every clock-dependent endpoint
// behind one dead read.
func (s *TickService) readBrokerTickSeconds(ctx context.Context, symbol string) int64 {
	body, err := s.c.Get(ctx, fmt.Sprintf(mt5.PathTickLast, symbol, 0))
	if err != nil {
		return 0
	}
	var root transform.TicklastRoot
	if json.Unmarshal(body, &root) != nil {
		return 0
	}
	return brokerTickSeconds(root.Answer)
}

// brokerTickSeconds is the broker-stamped time of the first usable tick.
func brokerTickSeconds(answer []transform.TicklastAnswer) int64 {
	for _, a := range answer {
		if msc, err := strconv.ParseInt(a.DatetimeMsc, 10, 64); err == nil && msc > 0 {
			return msc / 1000
		}
		if secs, err := strconv.ParseInt(a.Datetime, 10, 64); err == nil && secs > 0 {
			return secs
		}
	}
	return 0
}

func roundToHour(seconds int64) int64 {
	const h = 3600
	if seconds < 0 {
		return -roundToHour(-seconds)
	}
	return (seconds + h/2) / h * h
}

// chartChunkSeconds bounds one upstream /api/chart/get window. MT5 caps a
// single answer at roughly a year of M1 rows and silently truncates past it —
// observed live as a five-year weekly chart whose bars stopped 56 weeks after
// `from` with a multi-year hole to the present. 120 days (~124k rows) keeps
// every chunk far inside that cap.
const chartChunkSeconds int64 = 120 * 24 * 3600

// maxChartChunks bounds the upstream fan-out of one client request (~8 years
// of M1). Past it the oldest data is simply not returned; TradingView asks
// again with an older window if the user keeps scrolling.
const maxChartChunks = 25

// fetchChartUTCRange pulls M1 candles for an arbitrary UTC window, fanning a
// window larger than one upstream request can honestly answer into bounded
// chunks, NEWEST first. Newest-first matters for failure honesty: if an older
// chunk errors, what has already been collected is still contiguous from `to`
// backwards — a shorter chart, never one with an interior hole presented as
// complete. An EMPTY older chunk means the broker's history is exhausted and
// iteration stops. Bars come back ascending and deduplicated by time (chunk
// boundaries overlap by one bar upstream).
func (s *TickService) fetchChartUTCRange(ctx context.Context, symbol string, fromUTC, toUTC int64, data string) ([]transform.TVTickResponse, int64, response.GlobalResponse, bool) {
	if toUTC-fromUTC <= chartChunkSeconds {
		return s.fetchChartUTC(ctx, symbol, fromUTC, toUTC, data)
	}

	var collected []transform.TVTickResponse
	var offset int64
	end := toUTC
	for chunk := 0; chunk < maxChartChunks && end > fromUTC; chunk++ {
		start := end - chartChunkSeconds
		if start < fromUTC {
			start = fromUTC
		}
		bars, off, env, ok := s.fetchChartUTC(ctx, symbol, start, end, data)
		offset = off
		if !ok {
			if len(collected) > 0 {
				slog.Warn("chart chunk failed; returning newest-contiguous partial history",
					slog.String("symbol", symbol), slog.Int64("failed_from", start), slog.Int64("failed_to", end))
				break
			}
			return nil, off, env, false
		}
		if len(bars) == 0 {
			break // nothing this far back: the broker's history ends here
		}
		collected = append(collected, bars...)
		end = start - 1
	}

	sort.Slice(collected, func(i, j int) bool { return collected[i].Time < collected[j].Time })
	deduped := collected[:0]
	for i, b := range collected {
		if i > 0 && b.Time == collected[i-1].Time {
			continue
		}
		deduped = append(deduped, b)
	}
	msg := SuccessMessage
	return deduped, offset, response.GlobalResponse{Success: true, Message: &msg}, true
}

// fetchChartUTC pulls M1 candles from MT5 for a window given in UTC seconds and
// returns them stamped in UTC, along with the offset that was applied (callers
// that need the broker's calendar — the daily/weekly buckets — convert back).
func (s *TickService) fetchChartUTC(ctx context.Context, symbol string, fromUTC, toUTC int64, data string) ([]transform.TVTickResponse, int64, response.GlobalResponse, bool) {
	offset := s.brokerOffsetSeconds(ctx, symbol)
	env, body, ok := fetchGet(ctx, s.c, fmt.Sprintf(mt5.PathChartGet, symbol, fromUTC+offset, toUTC+offset, data))
	if !ok {
		return nil, offset, env, false
	}
	var chart transform.TickChartResponse
	if err := json.Unmarshal(body, &chart); err != nil {
		return nil, offset, catchError(err), false
	}
	bars := transform.ChartToTV(chart.Answer)
	for i := range bars {
		bars[i].Time -= offset
	}
	return bars, offset, env, true
}

// GetQuotes → GET /api/tick/last. tv → []Quote; else → OBJECT<TicklastRoot>.
func (s *TickService) GetQuotes(ctx context.Context, symbol string, id int64, source string) response.GlobalResponse {
	env, body, ok := fetchGet(ctx, s.c, fmt.Sprintf(mt5.PathTickLast, symbol, id))
	if !ok {
		return env
	}
	var root transform.TicklastRoot
	if err := json.Unmarshal(body, &root); err != nil {
		return env
	}
	if strings.EqualFold(source, SourceTV) {
		env.Data = transform.QuotesToTV(root.Answer, s.observeBrokerClock(root.Answer, symbol))
	} else {
		env.Data = json.RawMessage(body)
	}
	env.Success = true
	return env
}

// LastPrice returns the price a symbol is currently quoted at, using the same
// rule the terminal displays (Last when the venue publishes one, Bid
// otherwise). Server-side consumers — the alert evaluator — compare against
// this so a triggered alert matches the number the trader was looking at when
// they set the level.
func (s *TickService) LastPrice(ctx context.Context, symbol string) (float64, error) {
	body, err := s.c.Get(ctx, fmt.Sprintf(mt5.PathTickLast, symbol, 0))
	if err != nil {
		return 0, err
	}
	var root transform.TicklastRoot
	if err := json.Unmarshal(body, &root); err != nil {
		return 0, err
	}
	for _, q := range root.Answer {
		if !strings.EqualFold(q.Symbol, symbol) && q.Symbol != "" {
			continue
		}
		if float64(q.Last) > 0 {
			return float64(q.Last), nil
		}
		if float64(q.Bid) > 0 {
			return float64(q.Bid), nil
		}
	}
	return 0, fmt.Errorf("no quote for %s", symbol)
}

// GetQuotesByGroup → GET /api/tick/last_group (RAW_STRING).
func (s *TickService) GetQuotesByGroup(ctx context.Context, symbol, group string, id int64) response.GlobalResponse {
	env, _, _ := fetchGet(ctx, s.c, fmt.Sprintf(mt5.PathTickLastGroup, symbol, group, id))
	return env
}

// GetStatistics → GET /api/tick/stat (RAW_STRING).
func (s *TickService) GetStatistics(ctx context.Context, symbol string, id int64) response.GlobalResponse {
	env, _, _ := fetchGet(ctx, s.c, fmt.Sprintf(mt5.PathTickStat, symbol, id))
	return env
}

// GetTickHistory → GET /api/tick/history (RAW_STRING).
func (s *TickService) GetTickHistory(ctx context.Context, symbol string, from, to int64, data string) response.GlobalResponse {
	env, _, _ := fetchGet(ctx, s.c, fmt.Sprintf(mt5.PathTickHistory, symbol, from, to, data))
	return env
}

// GetMarketDepth → GET /api/book/get → OBJECT<transform.MarketDepth>.
//
// The upstream book used to be forwarded raw, with no documented shape and no
// stated volume unit. It is now normalized into one ladder — bids best-first,
// asks best-first, every volume in lots — so a DOM widget can be built against
// a contract instead of against a guess. An undecodable book is a failure, not
// an empty ladder: silently showing no liquidity would be indistinguishable
// from a genuinely empty book.
func (s *TickService) GetMarketDepth(ctx context.Context, symbol string) response.GlobalResponse {
	// Depth is delivered to SUBSCRIBERS. Without this, book/get answers with an
	// empty book for every symbol forever — which is exactly what this gateway
	// did, and what made a broker with no Level 2 indistinguishable from a
	// gateway that never asked for any.
	//
	// The OUTCOME travels with the ladder. Subscribing and then quietly
	// returning an empty book on failure recreated the same confusion one layer
	// up: the terminal said "not every instrument publishes depth" over symbols
	// whose subscribe had answered 504.
	subscribed, subErr := s.ensureBookSubscription(ctx, symbol)

	env, body, ok := fetchGet(ctx, s.c, fmt.Sprintf(mt5.PathBookGet, symbol))
	if !ok {
		return env
	}
	var root transform.BookRoot
	if err := json.Unmarshal(body, &root); err != nil {
		return failWith("Failed to parse market depth response.")
	}
	depth := transform.BookToMarketDepth(root.Answer, symbol, s.bookConv)
	depth.Subscribed = subscribed
	depth.SubscribeError = subErr
	env.Data = depth
	env.Success = true
	return env
}

// bookSubscribeTTL is how long a successful book subscription is assumed to
// still be live. Subscriptions belong to the MT5 CONNECTION, so a reconnect
// silently drops them; re-asserting on a timer costs at most one request per
// minute per watched symbol and needs no reconnect hook to stay correct.
const bookSubscribeTTL = 60

// bookSubscribeIdle is how long an unrequested symbol is remembered. It bounds
// the bookkeeping maps for a session that browses many instruments.
const bookSubscribeIdle = 4 * bookSubscribeTTL

// bookSubscribeRetry is how long a REFUSED symbol is left alone.
//
// Much longer than the success TTL on purpose. A refusal is usually permanent —
// the instrument has no book, or this server has no such command — so retrying
// it on the success cadence would spend a request a minute, forever, per symbol
// the DOM ever touched, to be told the same thing. Long enough to be
// negligible, finite so a genuinely transient refusal (a session still warming
// up, as seen right after a restart) still heals on its own.
const bookSubscribeRetry = 30 * 60

// ensureBookSubscription subscribes this connection to a symbol's order book,
// at most once per bookSubscribeTTL.
//
// Failure is deliberately non-fatal and never surfaces to the caller: not every
// MT5 deployment exposes this command, and a gateway that refused to serve
// depth because it could not subscribe would be strictly worse than today's
// behavior. It is logged instead — which is what makes "the broker publishes no
// Level 2" and "we never asked for it" tellable apart from the gateway's own
// logs.
// It reports whether the connection holds a subscription for the symbol, and
// why not when it does not — the caller puts that on the wire so a client can
// tell "this instrument has no book" from "we could not ask for one".
func (s *TickService) ensureBookSubscription(ctx context.Context, symbol string) (bool, string) {
	if !s.bookSubscribe || symbol == "" {
		return false, "Book subscription is disabled on this gateway."
	}
	now := time.Now().Unix()

	s.bookMu.Lock()
	for sym, at := range s.bookSubAt {
		if now-at > bookSubscribeIdle {
			delete(s.bookSubAt, sym)
			delete(s.bookWarned, sym)
		}
	}
	for sym, at := range s.bookRefusedAt {
		if now-at > bookSubscribeRetry {
			delete(s.bookRefusedAt, sym)
			delete(s.bookWarned, sym)
		}
	}
	live := false
	refused := false
	if at, ok := s.bookSubAt[symbol]; ok && now-at < bookSubscribeTTL {
		live = true
	}
	// A symbol inside its refusal window is not asked again.
	if at, ok := s.bookRefusedAt[symbol]; ok && now-at < bookSubscribeRetry {
		refused = true
	}
	s.bookMu.Unlock()
	if live {
		return true, ""
	}
	if refused {
		// Still inside the refusal window: the answer is known without asking.
		return false, refusalReason
	}

	_, _, ok := fetchGet(ctx, s.c, fmt.Sprintf(mt5.PathBookSubscribe, symbol))

	s.bookMu.Lock()
	defer s.bookMu.Unlock()
	if ok {
		s.bookSubAt[symbol] = now
		delete(s.bookRefusedAt, symbol)
		delete(s.bookWarned, symbol)
		return true, ""
	}
	// A cancelled context is the client hanging up mid-poll, not a fault, and
	// must not start a refusal window.
	if ctx.Err() != nil {
		return false, "The book subscription was cancelled."
	}

	s.bookRefusedAt[symbol] = now
	if !s.bookWarned[symbol] {
		s.bookWarned[symbol] = true
		// Says when it will be tried again, so a reader can tell a one-off from
		// a standing refusal without going back through the log. The previous
		// wording suppressed repeats without saying the attempt continued, which
		// hid a retry loop that was invalidating the shared Manager session.
		slog.Warn("market-depth subscribe refused; this symbol's book will stay empty until the next attempt",
			slog.String("symbol", symbol),
			slog.String("path", fmt.Sprintf(mt5.PathBookSubscribe, symbol)),
			slog.Int("retry_in_seconds", bookSubscribeRetry))
	}
	return false, refusalReason
}

// refusalReason is what a client is told when the trading server would not
// open a book subscription. Deliberately about the LINK rather than the
// instrument: the gateway does not know whether this symbol has depth, only
// that it was never able to ask.
const refusalReason = "The trading server did not accept a market-depth subscription for this symbol."

// GetM1History → []TVTickResponse from /api/chart/get, with the (from==0&&to==1)
// live-window trick (window = last 120s of broker time).
func (s *TickService) GetM1History(ctx context.Context, symbol string, from, to int64, data string) response.GlobalResponse {
	// `to == 1` is the live-chart sentinel: "up to now". The window is UTC like
	// every other window; fetchChartUTC shifts it onto the broker's clock. It
	// used to be built from the broker clock directly, which is what put live
	// bars `offset` ahead of history.
	if to == 1 {
		to = time.Now().UTC().Unix()
		// `from == 0` means "just the live edge". Anything older than the
		// lookback is never re-sent, so a client that misses a few pushes — a
		// slept tab, a dropped socket, a market reopening — keeps a hole in its
		// series forever. A client that knows where it left off can say so and
		// the hole heals on the next push; the default lookback covers the
		// short interruptions that need no client change at all.
		if from <= 0 || from > to {
			from = to - liveChartLookback
		} else if to-from > maxLiveChartLookback {
			// One client must not be able to ask MT5 for a year of minutes.
			from = to - maxLiveChartLookback
		}
	}

	// DB-backed branch: sync from MT5 into the store, then read back (newest
	// first, volume null), matching the .NET ReadDataFromDbOrAPI=true path.
	if s.readFrom && s.store != nil {
		_ = s.SyncSymbolHistoryData(ctx, symbol, from, to, data)
		rows, err := s.store.IntradayRange(ctx, symbol, from, to)
		if err != nil {
			return catchError(err)
		}
		out := make([]transform.TVTickResponse, 0, len(rows))
		for _, r := range rows {
			out = append(out, transform.TVTickResponse{Time: r.Time, Open: r.Open, High: r.High, Low: r.Low, Close: r.Close})
		}
		return response.GlobalResponse{Success: true, Data: out}
	}

	bars, _, env, ok := s.fetchChartUTCRange(ctx, symbol, from, to, data)
	if !ok {
		// Availability fallback, mirroring the symbol-record cache: the poller
		// keeps the store within minutes of live, so during an upstream
		// failure the stored minutes ARE the chart — minus only the last few.
		// Consulted on failure alone, so it can never make fresh data stale.
		if s.store != nil {
			if rows, serr := s.store.IntradayRange(ctx, symbol, from, to); serr == nil && len(rows) > 0 {
				slog.Warn("serving stored intraday candles; live fetch failed",
					slog.String("symbol", symbol), slog.Int("stored_rows", len(rows)))
				out := make([]transform.TVTickResponse, 0, len(rows))
				for _, r := range rows {
					out = append(out, transform.TVTickResponse{Time: r.Time, Open: r.Open, High: r.High, Low: r.Low, Close: r.Close})
				}
				// IntradayRange answers newest first (the .NET read order); the
				// live path answers ascending, and the two must not differ.
				sort.SliceStable(out, func(i, j int) bool { return out[i].Time < out[j].Time })
				return response.GlobalResponse{Success: true, Data: out}
			}
		}
		return env
	}
	env.Data = bars
	env.Success = true
	return env
}

// intradayStepSeconds maps a TradingView intraday resolution token ("5", "60",
// "120", …) to a bucket width in seconds. Zero means "do not aggregate": an
// absent token, "1", or anything that is not a plain minute count (the daily
// tokens go to GetHistoryBy1DResolution, never here).
func intradayStepSeconds(resolution string) int64 {
	minutes, err := strconv.Atoi(strings.TrimSpace(resolution))
	if err != nil || minutes <= 1 || minutes > 720 {
		return 0
	}
	return int64(minutes) * 60
}

// aggregateIntradayM1 rolls M1 bars into stepSec-wide buckets aligned to the
// BROKER's clock (open=first, close=last, high=max, low=min, volume summed when
// any constituent carries one).
//
// Broker alignment, not UTC: MT5 cuts its own 2h/4h/… candles on the trade
// server's day, and this terminal's traders read it side by side with the MT5
// desktop. On a UTC+3 server a UTC-floored 2h bucket would open every candle an
// hour off desktop MT5 — same numbers, visibly "wrong" chart. The key is
// computed on the broker clock and restated in UTC, exactly like the 1D path.
// For steps that divide one hour the two alignments coincide (offsets are whole
// hours), so this only changes anything for the 2h+ resolutions.
func aggregateIntradayM1(bars []transform.TVTickResponse, stepSec, offset int64) []transform.TVTickResponse {
	if len(bars) == 0 {
		return []transform.TVTickResponse{}
	}
	sorted := make([]transform.TVTickResponse, len(bars))
	copy(sorted, bars)
	sort.SliceStable(sorted, func(i, j int) bool { return sorted[i].Time < sorted[j].Time })

	out := make([]transform.TVTickResponse, 0, len(sorted)/int(stepSec/60)+1)
	for _, b := range sorted {
		key := (b.Time+offset)/stepSec*stepSec - offset
		if n := len(out); n > 0 && out[n-1].Time == key {
			cur := &out[n-1]
			if b.High > cur.High {
				cur.High = b.High
			}
			if b.Low < cur.Low {
				cur.Low = b.Low
			}
			cur.Close = b.Close
			if b.Volume != nil {
				sum := *b.Volume
				if cur.Volume != nil {
					sum += *cur.Volume
				}
				cur.Volume = &sum
			}
			continue
		}
		bar := b
		bar.Time = key
		if b.Volume != nil {
			v := *b.Volume
			bar.Volume = &v
		}
		out = append(out, bar)
	}
	return out
}

// GetIntradayHistory is GetM1History plus optional server-side aggregation into
// the requested intraday resolution. Payload is the point: a 6-month 2h window
// as raw M1 is ~8 MB of JSON the client immediately folds 120:1; aggregated
// here it is a few hundred bars. An unrecognised or "1" resolution falls back
// to the raw M1 behaviour, so old clients keep working unchanged.
//
// The window is widened outward to whole bucket boundaries before fetching, so
// a bucket straddling a pagination edge is aggregated from ALL of its minutes.
// Without this, the client's page walk would show the boundary candle built
// from only the slice of M1 that happened to fall inside one page.
func (s *TickService) GetIntradayHistory(ctx context.Context, symbol string, from, to int64, data, resolution string) response.GlobalResponse {
	step := intradayStepSeconds(resolution)
	if step == 0 {
		return s.GetM1History(ctx, symbol, from, to, data)
	}
	offset := s.brokerOffsetSeconds(ctx, symbol)
	if to != 1 { // to==1 is GetM1History's live-window sentinel; never widen it
		from = (from+offset)/step*step - offset
		to = ((to+offset)/step+1)*step - offset - 1
	}
	env := s.GetM1History(ctx, symbol, from, to, data)
	if !env.Success {
		return env
	}
	if bars, ok := env.Data.([]transform.TVTickResponse); ok {
		env.Data = aggregateIntradayM1(bars, step, offset)
	}
	return env
}

// SyncSymbolHistoryData pulls M1 candles from MT5 into the store (advancing the
// window past the latest stored row), prunes >7-day-old rows, then upserts.
func (s *TickService) SyncSymbolHistoryData(ctx context.Context, symbol string, from, to int64, data string) error {
	if s.store == nil {
		return nil
	}
	if latest, err := s.store.LatestTime(ctx, symbol, from, to); err == nil && latest > from {
		from = latest
	}
	// Stored rows are UTC-stamped like everything else the gateway hands out;
	// IntradayRange and DailyRange are read back with UTC windows.
	bars, _, _, ok := s.fetchChartUTC(ctx, symbol, from, to, data)
	if !ok {
		return fmt.Errorf("chart fetch for %s failed", symbol)
	}
	candles := make([]Candle, 0, len(bars))
	for _, b := range bars {
		candles = append(candles, Candle{Symbol: symbol, Time: b.Time, Open: b.Open, High: b.High, Low: b.Low, Close: b.Close})
	}
	cutoff := time.Now().UTC().Add(-7 * 24 * time.Hour).Unix()
	_ = s.store.DeleteOlderThan(ctx, cutoff)
	return s.store.InsertCandles(ctx, candles)
}

// AggregateDaily rolls the previous day's intraday rows into daily rows for all
// stored symbols (batched), via the store.
func (s *TickService) AggregateDaily(ctx context.Context, day time.Time) error {
	if s.store == nil {
		return nil
	}
	symbols, err := s.store.DistinctSymbols(ctx)
	if err != nil {
		return err
	}
	if len(symbols) == 0 {
		return nil
	}

	// A daily candle is a trading day, and a trading day is the broker's day.
	// Cutting at UTC midnight instead blends the tail of one session into the
	// head of the next: on a UTC+3 broker the row would open at 03:00 broker
	// time and carry three hours of the previous day's range. Those rows are
	// merged into the 1D/1W/1M responses beside live bars that *are* cut on the
	// broker's calendar, and being first into the bucket, the aggregate's open
	// would win — so the wrong boundary shows up as a wrong daily open.
	//
	// The offset is a property of the trade server, not of any one symbol; any
	// symbol resolves it, and the value is cached across the whole service.
	offset := s.brokerOffsetSeconds(ctx, symbols[0])
	brokerDay := time.Unix(day.UTC().Unix()+offset, 0).UTC()
	brokerMidnight := time.Date(brokerDay.Year(), brokerDay.Month(), brokerDay.Day(), 0, 0, 0, 0, time.UTC).AddDate(0, 0, -1)
	start := time.Unix(brokerMidnight.Unix()-offset, 0).UTC() // restated in UTC
	end := start.AddDate(0, 0, 1)
	const batch = 100
	for i := 0; i < len(symbols); i += batch {
		j := i + batch
		if j > len(symbols) {
			j = len(symbols)
		}
		// The store's ranges are inclusive at both ends, so stop one second
		// short of the next day's midnight bar: it opens the following session
		// and would otherwise be counted in both days' candles.
		if err := s.store.AggregateDaily(ctx, start.Unix(), end.Unix()-1, symbols[i:j]); err != nil {
			return err
		}
	}
	return nil
}

// GetHistoryBy1DResolution rolls live M1 bars into the requested resolution
// buckets (open=first, close=last, high=max, low=min), ordered ascending.
// (Pre-aggregated daily DB rows are added in the data stage.)
func (s *TickService) GetHistoryBy1DResolution(ctx context.Context, symbol string, from, to int64, resolution string) response.GlobalResponse {
	// The store first. A daily/weekly chart asks for YEARS, and the old shape
	// of this method fetched that whole window as M1 from MT5 on every call —
	// a 6-year weekly request was observed taking 79 seconds against a slow
	// upstream (2026-08-24), for data that changes once a day. Stored daily
	// rows cover their span; the live fetch covers only the segments the store
	// does NOT: the head before its oldest row, and the tail after its newest.
	//
	// BOTH segments, deliberately. The first cut of this narrowing fetched the
	// tail alone, on the assumption that stored coverage always reaches the
	// request's start. It does not — this deployment's aggregation began on
	// 2026-06-17 — and the skipped head became a PERMANENT hole: TradingView
	// never re-asks inside a window it got an answer for, so the chart showed
	// 2018-2020, a six-year gap, then June 2026 onward (user report,
	// 2026-08-24 "there is gap on chart").
	var daily []DailyCandle
	if s.store != nil {
		if rows, derr := s.store.DailyRange(ctx, symbol, from, to); derr == nil {
			daily = rows
		}
	}

	type span struct{ from, to int64 }
	spans := []span{{from, to}}
	if len(daily) > 0 {
		spans = spans[:0]
		// The head, up TO the first stored day (inclusive boundary is fine:
		// the bucketing below merges duplicate coverage of a day, never
		// double-counts it).
		if first := daily[0].Timestamp; first > from {
			spans = append(spans, span{from, first})
		}
		// The tail, FROM the last stored day: that day may have been
		// aggregated mid-session, and refetching it completes the candle.
		if last := daily[len(daily)-1].Timestamp; last < to {
			spans = append(spans, span{last, to})
		}
	}

	var bars []transform.TVTickResponse
	var offset int64
	offsetKnown := false
	var failEnv response.GlobalResponse
	failedSpans := 0
	for _, sp := range spans {
		b, off, env, ok := s.fetchChartUTCRange(ctx, symbol, sp.from, sp.to, DefaultChartData)
		if !ok {
			failedSpans++
			failEnv = env
			slog.Warn("live history segment failed; continuing with what the store holds",
				slog.String("symbol", symbol), slog.Int64("from", sp.from), slog.Int64("to", sp.to))
			continue
		}
		bars = append(bars, b...)
		if !offsetKnown {
			offset = off
			offsetKnown = true
		}
		// Every successfully fetched segment is banked: the broker's outage
		// cycles are shorter than a multi-year head fetch, so a range that
		// survives one healthy window must never need fetching again. Coverage
		// grows monotonically until the store owns the whole history and the
		// head fetch stops existing.
		s.persistDailyBars(ctx, symbol, b, off)
	}
	if len(spans) > 0 && failedSpans == len(spans) && len(daily) == 0 {
		// Nothing live and nothing stored. The chart PAGES backward through
		// history, and during an outage the page that reaches past the store's
		// oldest row would error — which TradingView answers by discarding the
		// whole series it has already drawn (observed live: 36 served candles,
		// then one 400 on the 2014-2020 page, then "No data here"). When the
		// store proves the symbol HAS candles after this window, the truthful
		// degraded answer for the window itself is "nothing here", not "I am
		// broken".
		if s.store != nil {
			if newer, nerr := s.store.DailyRange(ctx, symbol, to, time.Now().UTC().Unix()); nerr == nil && len(newer) > 0 {
				slog.Warn("answering pre-coverage history page as empty; live fetch failed",
					slog.String("symbol", symbol))
				return response.GlobalResponse{
					Success: true,
					Message: ptr(NoDataFoundMessage),
					Data:    []transform.TVTickResponse{},
				}
			}
		}
		return failEnv
	}
	if !offsetKnown {
		// Every needed segment came from the store (or the live fetches all
		// failed but the store still answers). Degraded when live is down: the
		// chart gets every candle the store holds and misses only the live
		// edge — precisely the trade an outage forces.
		offset = s.brokerOffsetSeconds(ctx, symbol)
	}
	if failedSpans > 0 && len(daily) > 0 {
		slog.Warn("serving stored daily candles; live fetch failed",
			slog.String("symbol", symbol), slog.Int("stored_rows", len(daily)))
	}

	type bar = transform.TVTickResponse
	buckets := map[int64]*bar{}
	var order []int64

	// Pre-aggregated daily rows from the store (when available) are folded in
	// alongside the live M1 bars before bucketing.
	//
	// A trading day is the broker's day, not UTC's, so the bucket boundary is
	// computed on the broker's clock and the resulting key restated in UTC.
	// Bucketing the UTC stamps directly would silently move every daily,
	// weekly and monthly candle by the broker offset.
	addBar := func(t int64, o, h, l, c float64) {
		key := transform.BucketStart(t+offset, resolution) - offset
		if b, exists := buckets[key]; exists {
			if h > b.High {
				b.High = h
			}
			if l < b.Low {
				b.Low = l
			}
			b.Close = c
		} else {
			buckets[key] = &bar{Time: key, Open: o, High: h, Low: l, Close: c}
			order = append(order, key)
		}
	}
	for _, d := range daily {
		addBar(d.Timestamp, d.Open, d.High, d.Low, d.Close)
	}

	sort.SliceStable(bars, func(i, j int) bool { return bars[i].Time < bars[j].Time })
	for _, p := range bars {
		addBar(p.Time, p.Open, p.High, p.Low, p.Close)
	}
	sort.Slice(order, func(i, j int) bool { return order[i] < order[j] })
	// Clamp to the REQUESTED window's buckets. MT5's chart pages can overshoot
	// the asked window backwards, and a bucket assembled from that pre-window
	// spill is a candle OLDER than the caller asked for — observed live as a
	// weekly backfill for [Aug 16 → now] answering with an Aug 9 candle, which
	// TradingView rejects with a "time violation" on every replay (2026-08-24).
	minBucket := transform.BucketStart(from+offset, resolution) - offset
	out := make([]bar, 0, len(order))
	for _, k := range order {
		if k < minBucket {
			continue
		}
		out = append(out, *buckets[k])
	}

	msg := SuccessMessage
	if len(out) == 0 {
		msg = NoDataFoundMessage
	}
	return response.GlobalResponse{Success: true, Message: ptr(msg), Data: out}
}

// persistDailyBars banks live-fetched bars as daily rows so the store's
// coverage grows with every healthy fetch. The current (still-forming) broker
// day is excluded — a frozen partial candle would be served as if final — and
// the insert is DO NOTHING on conflict, so neither an aggregated row nor a
// previous backfill is ever churned. Failures are logged and swallowed: this
// is a bank deposit on the side of a read path, never a reason to fail it.
func (s *TickService) persistDailyBars(ctx context.Context, symbol string, bars []transform.TVTickResponse, offset int64) {
	if s.store == nil || len(bars) == 0 {
		return
	}
	todayStart := transform.BucketStart(time.Now().UTC().Unix()+offset, "1D") - offset

	sorted := make([]transform.TVTickResponse, len(bars))
	copy(sorted, bars)
	sort.SliceStable(sorted, func(i, j int) bool { return sorted[i].Time < sorted[j].Time })

	var out []DailyCandle
	for _, b := range sorted {
		key := transform.BucketStart(b.Time+offset, "1D") - offset
		if key >= todayStart {
			continue
		}
		if n := len(out); n > 0 && out[n-1].Timestamp == key {
			cur := &out[n-1]
			if b.High > cur.High {
				cur.High = b.High
			}
			if b.Low < cur.Low {
				cur.Low = b.Low
			}
			cur.Close = b.Close
			continue
		}
		out = append(out, DailyCandle{Symbol: symbol, Timestamp: key, Open: b.Open, High: b.High, Low: b.Low, Close: b.Close})
	}
	if len(out) == 0 {
		return
	}
	if err := s.store.InsertDailyCandles(ctx, out); err != nil {
		slog.Warn("banking fetched daily candles failed", slog.String("symbol", symbol), slog.Any("error", err))
		return
	}
	slog.Info("banked fetched daily candles", slog.String("symbol", symbol), slog.Int("days", len(out)))
}

// GetLastDailyBar returns the current broker-day candle for TradingView's
// daily realtime subscription. The frontend takes the last array element.
func (s *TickService) GetLastDailyBar(ctx context.Context, symbol string) response.GlobalResponse {
	// "Today" is the broker's day — the session the trader is actually in — so
	// the boundary is found on the broker's clock and then expressed in UTC,
	// the base every window and bar time on this service uses.
	offset := s.brokerOffsetSeconds(ctx, symbol)
	toUTC := time.Now().UTC().Unix()
	brokerNow := time.Unix(toUTC+offset, 0).UTC()
	brokerDayStart := time.Date(brokerNow.Year(), brokerNow.Month(), brokerNow.Day(), 0, 0, 0, 0, time.UTC).Unix()
	return s.GetHistoryBy1DResolution(ctx, symbol, brokerDayStart-offset, toUTC, "1D")
}

// GetTickServiceData dispatches WS tick methods. Note "GetMarketDepth" returns
// RAW_STRING here (unlike the deserialized GetMarketDepth method).
func (s *TickService) GetTickServiceData(ctx context.Context, symbol, id, methodType, group, source string, from, to int64, data, resolution string) response.GlobalResponse {
	switch methodType {
	case "GetMarketDepth":
		// Same normalized ladder as the REST endpoint: a DOM fed by the stream
		// and one fed by a snapshot must not have different shapes.
		return s.GetMarketDepth(ctx, symbol)
	case "GetStatistics":
		env, _, _ := fetchGet(ctx, s.c, fmt.Sprintf(mt5.PathTickStat, symbol, atoi64(id)))
		return env
	case "GetQuotes":
		return s.GetQuotes(ctx, symbol, atoi64(id), source)
	case "GetQuotesByGroup":
		env, _, _ := fetchGet(ctx, s.c, fmt.Sprintf(mt5.PathTickLastGroup, symbol, group, atoi64(id)))
		return env
	case "GetM1History":
		return s.GetM1History(ctx, symbol, from, to, data)
	case "GetHistoryBy1DResolution":
		return s.GetHistoryBy1DResolution(ctx, symbol, from, to, resolution)
	case "GetLastDailyBar":
		return s.GetLastDailyBar(ctx, symbol)
	default:
		return response.GlobalResponse{}
	}
}

// brokerTimeSeconds is the broker's "now" — real time on the broker's clock,
// not the (possibly stale) timestamp of the last tick it was measured from.
func (s *TickService) brokerTimeSeconds(ctx context.Context, symbol string) int64 {
	return time.Now().UTC().Unix() + s.brokerOffsetSeconds(ctx, symbol)
}

// BrokerOffset satisfies BrokerClock for the account-data services (deals,
// history, positions, orders, trade expirations). It reads the clock off the
// configured clock symbol; the quote and chart paths keep the cache warm, so
// in steady state this never costs an upstream call.
func (s *TickService) BrokerOffset(ctx context.Context) int64 {
	symbol := s.clockSymbol
	if symbol == "" {
		symbol = "EURUSD"
	}
	return s.brokerOffsetSeconds(ctx, symbol)
}
