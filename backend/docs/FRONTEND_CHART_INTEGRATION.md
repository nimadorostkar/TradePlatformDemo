# Frontend handoff — chart times, live candles, gaps

The gateway's chart contract changed. This is what a client has to do about it,
why, and — at the end — prompts you can hand to Claude in the frontend repo.

Gateway commits: `00a322e` (one clock), `821716c` (offset resolver), `6ea211b`
(quote timestamps + healing window), `7cbbbe9` (daily candle boundary).

---

## 1. What the wire looks like now

**Every time the gateway emits is UTC unix seconds.** Bars, quotes, windows.
There is no broker-time value anywhere in the API.

| Endpoint | Field | Base |
|---|---|---|
| `/api/Tick/get` (M1) | `time` on each bar | UTC seconds |
| `/api/Tick/getHistoryby1Dresolution` | `time` on each bar | UTC seconds |
| `/api/Tick/last?source=tv` | **`time`** (new) | UTC seconds |
| all of the above | `from` / `to` you send | UTC seconds |

`GET /api/Tick/last?source=tv` now returns a `time` on every quote — when the
broker printed it. Every other field is unchanged and in the same order.

```json
{ "symbolname": "XAUUSD", "status": "Ok", "bid": 4264.78, "ask": 4264.99,
  "lastprice": 4264.78, "volume": 1, "time": 1786029053 }
```

### The live chart window

`to=1` means "up to now". What it pairs with matters:

| `from` | You get | When to use it |
|---|---|---|
| `0` | the last **5 minutes** of M1 | steady state |
| `T` (UTC seconds) | `[T, now]`, capped at 24h | after any interruption |

Anything older than the window you ask for is **never re-sent**. That is the
whole mechanism behind a permanent hole: miss more than the lookback, and those
bars are gone until someone asks for them by time.

Push cadence is 3s (`WS_PUSH_CADENCE`). The gateway polls MT5, so no data
arrives faster than that, however the client is written.

---

## 2. Read this before deploying

**Search the frontend for compensating time offsets and delete them.**

Until this week the gateway returned history and live bars on two different
clocks (history effectively UTC-numbered but three hours stale, live bars
stamped three hours ahead). If anyone patched around that in the frontend — a
`+ 3 * 3600`, a `- 10800`, a `addHours(3)`, a `dayjs.utc().add(3,'hour')`, a
"broker time" helper — that patch is now a bug. The backend is correct, so a
client-side correction **double-counts** and will put the chart three hours off
in the opposite direction.

This is the single highest-risk item in the whole change, and it is a five
minute grep.

---

## 3. What the frontend should do

### 3.1 Let the chart library do the timezone (do not do it yourself)

TradingView's contract is: **bar `time` is a UTC timestamp, and
`symbolInfo.timezone` decides what the axis shows.** The gateway already
returns the right value — `/api/Symbol/getsymbolsbyname?source=tv` includes:

```json
{ "timezone": "Europe/Istanbul", "session": "0000-2400:2|0000-2400:3|..." }
```

So pass `timezone` and `session` straight from the symbol response into
`LibrarySymbolInfo`. Do not hardcode `UTC+3` and do not shift the data. The
trader then sees broker time on the axis — the same clock as MT5 desktop —
while every number on the wire stays UTC.

`session` matters for gaps too: with the correct session string the library
knows the market is closed and closes the space up instead of drawing a hole
across the weekend.

### 3.2 Drive the forming candle from quotes

This is what makes the chart tick-by-tick instead of stepping once per poll,
and it is why quotes now carry `time`.

The standard datafeed shape:

- `getBars()` → `/api/Tick/get` or `/getHistoryby1Dresolution` (history).
- `subscribeBars()` → on every quote from the WS `GetQuotes` stream, update the
  forming bar: bucket `quote.time` to the resolution, then set
  `close = quote.lastprice`, `high = max(high, …)`, `low = min(low, …)`, and
  open a new bar when the bucket key advances.

Use `quote.time` for the bucket, not `Date.now()`. The trader's machine clock
is not the broker's, and using it is how a forming candle drifts away from the
bars underneath it.

### 3.3 Backfill on reconnect instead of hoping

Whenever the chart subscription restarts — socket reconnect, tab foregrounded,
network resumed, market reopening — resubscribe with `from` set to **the newest
bar time you already hold**, not `0`. The gateway serves `[from, now]` and the
hole closes on the next push. With `from=0` you get the last 5 minutes and
anything older stays missing forever.

A tab backgrounded for an hour is the common case, and it is invisible in
testing because nobody backgrounds a tab while watching a chart.

### 3.4 Show stale quotes as stale

`quote.time` makes this possible for the first time. If `now - quote.time` is
larger than a minute or two, the market is closed or the feed is stalled —
label it. Rendering a Friday quote as a live price is how a trader ends up
believing a stale number.

### 3.5 Debounce the workspace autosave

Measured on production: **52 of 120** gateway calls in one short session were
`POST /api/Workspace/save` — 43%. Every panel switch and chart change fires
several, and each one is a database write. Debounce to one save a few seconds
after the layout settles.

---

## 4. Prompts for Claude in the frontend repo

Each is self-contained — paste one at a time, in order. They assume no
knowledge of this document.

### Prompt 1 — the pre-deploy safety check (do this first)

```
Our backend gateway used to return chart bar times on two different clocks: the
historical bars were effectively UTC-numbered but three hours stale, and the
live-streaming bars were stamped three hours ahead (the broker runs UTC+3).
That has now been fixed backend-side — every time the API returns is UTC unix
seconds, for history, live bars, and quotes alike.

If anyone previously compensated for that in this frontend, that compensation
is now a bug that will push the chart three hours off in the other direction.

Search the whole codebase for any client-side time adjustment applied to market
data: literals like 3*3600, 10800, 3600*3; addHours/subtractHours; dayjs or
date-fns .add(3,'hour') / .subtract(3,'hour'); any helper named like brokerTime,
serverTime, toBrokerTime, adjustTime, TIME_OFFSET, TZ_OFFSET; and any manual
timezone maths in the chart datafeed, the WebSocket handlers, and the quote and
candle mappers.

For each hit, report the file and line, what it does, and whether it is applied
to market-data timestamps (bars, quotes, chart windows) or to something
unrelated like UI display of user dates. Do not change anything yet — give me
the list and your recommendation first.
```

### Prompt 2 — timezone and session from the symbol response

```
In our TradingView chart datafeed, bar times from our API are UTC unix seconds.
TradingView's contract is that bar time is a UTC timestamp and
symbolInfo.timezone controls what the axis displays.

Our symbol endpoint GET /api/Symbol/getsymbolsbyname?symbol=<SYM>&source=tv
already returns the correct values, e.g.:
  { "timezone": "Europe/Istanbul", "session": "0000-2400:2|0000-2400:3|0000-2400:4|0000-2400:5|0000-2400:6", ... }

Find where we build LibrarySymbolInfo in the datafeed and make it pass the
API's `timezone` and `session` through, instead of any hardcoded value. Do not
shift or convert the bar timestamps anywhere — they are already correct.

Then confirm: the time axis shows broker time (UTC+3 in summer), the current
candle sits at the current broker wall-clock minute, and weekends are closed up
rather than drawn as empty space.
```

### Prompt 3 — tick-driven forming candle

```
Our chart currently updates only when a new batch of OHLC bars arrives from the
WebSocket poll, so the price steps once every ~3 seconds instead of moving with
the market. We want the forming candle to advance on every quote, which is how
charting clients normally work.

Our quote stream (WebSocket, methodtype=GetQuotes, source=tv) now delivers:
  { "symbolname": "XAUUSD", "status": "Ok", "bid": 4264.78, "ask": 4264.99,
    "lastprice": 4264.78, "volume": 1, "time": 1786029053 }
where `time` is when the broker printed the quote, in UTC unix seconds — the
same base as bar times.

In the TradingView datafeed's subscribeBars, merge each quote into the forming
bar: bucket quote.time to the subscribed resolution, and if the bucket matches
the current bar, update close = lastprice and extend high/low; if the bucket
has advanced, emit a new bar opening at that price. Always bucket on
quote.time, never on Date.now() — the user's machine clock is not the broker's.

Keep getBars (history) exactly as it is. Show me the diff before applying.
```

### Prompt 4 — heal gaps on reconnect

```
Our chart's live WebSocket subscription requests a window with from=0&totime=1,
and the backend answers with the last 5 minutes of one-minute bars. Anything
older than that window is never re-sent, so if the subscription is interrupted
for longer than the lookback — a backgrounded tab, a dropped socket, a network
change, the market reopening after the weekend — the bars from that period are
missing from the chart permanently.

The backend now supports backfill: send `fromtime=<T>` with `totime=1` and it
returns every bar from T up to now, capped at 24 hours.

Change our chart subscription so that whenever it (re)subscribes or reconnects,
it sends fromtime = the time of the newest bar we already hold for that symbol
and resolution, rather than 0. Use 0 only on a genuinely fresh subscription
with no bars. Also trigger a resubscribe when the tab becomes visible again
(visibilitychange) and when the socket reconnects.

Then verify by backgrounding the tab for 10 minutes: on return, the chart
should fill the missing candles instead of showing a flat gap.
```

### Prompt 5 — stale-quote indicator

```
Our quote stream now includes `time` — when the broker printed the quote, in
UTC unix seconds. Previously quotes had no timestamp at all, so we had no way
to tell a live price from a frozen one.

Add staleness handling: if (Date.now()/1000 - quote.time) exceeds a threshold
(start with 90 seconds, make it a constant), treat the quote as stale — dim the
price in the watchlist and the order ticket, and show a "market closed / no
recent quotes" state rather than presenting an old number as a live price.
Clear it as soon as a fresh quote arrives.

Note our clock and the broker's may differ by a second or two; the threshold
should be well above that. Don't block trading on it — just label it.
```

### Prompt 6 — debounce the workspace autosave

```
Measured against production: in one short session, 52 of 120 API calls from
this app were POST /api/Workspace/save — 43% of all traffic. Every panel
switch, tab change and chart interaction fires several, and each one is a
database write on the gateway.

Find where the workspace is saved and debounce it: one save a few seconds after
the layout stops changing, rather than one per interaction. Coalesce bursts,
skip the save entirely when the serialized workspace is unchanged from the last
one sent, and still flush on page unload so nothing is lost.

Show me where the save is triggered from before changing it.
```
