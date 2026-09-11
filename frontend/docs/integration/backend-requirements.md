# Backend requirements

What the gateway would need for the features currently gated off or degraded in
the terminal. Ordered by trader-visible impact.

Each item states **why it is blocked**, the **contract needed**, and what the UI
already does while it waits. Nothing here is required for the terminal to run —
every gap has an honest fallback today.

> **Status 2026-07-31 — items 1–12 shipped to production.** Verified against the
> live gateway and against `tradeplatform-mt-socket-new`. The client now adopts the
> new contracts; see the delivery notes at the bottom for what changed on this
> side, including one workaround that had to be REMOVED rather than kept.
> Item 13 (news / calendar) remains unimplemented and its panels stay gated off.
> Item 14 was found during this pass and fixed in the gateway.

---

## 1. Fix the WebSocket order-status table ⚠️ correctness

**Priority: highest.** This is not a new feature; it is a defect that makes the
terminal report less than it knows.

`internal/transform/funcs.go`:

```go
// OrdersToTVStd  (REST /Order/get_page)
Status: MT5ToTVStatus(int(item.State))   // ✅ status table

// OrdersToTVV2   (WS GetPagebyPageOrder)
Status: MT5ToTVType(int(order.State))    // ❌ ORDER-TYPE table
```

`MT5ToTVType` maps order _types_, not states. Applied to a state it collapses
distinct meanings into one number:

| WS `status` | could mean                       |
| ----------- | -------------------------------- |
| `1`         | CANCELED **or** PARTIALLY FILLED |
| `3`         | FILLED **or** REJECTED           |

So over the WebSocket, **filled and rejected are indistinguishable**.

**Change:** use `MT5ToTVStatus(int(order.State))` in `OrdersToTVV2`, matching
the REST path.

**Meanwhile:** every ambiguous value maps to `unknown` and renders as
"Unknown", never as "Filled". Orders resolve on the next REST snapshot.

---

## 2. Settle the trade-response shape ⚠️ correctness

`POST /api/Trade/send_request` can return three different shapes, and the client
accepts all three because we could not establish which one each environment
actually sends:

1. `PlaceOrderAnswer` — raw MT5, carries `ResultRetcode` (authoritative)
2. `PlacedOrder` — the Go `source=tv` transform, `status: 5` means rejected
3. `{ order, mTresult, answer }` — the .NET-era shape the working integration reads

**What we need:** confirmation of which shape production returns, ideally with
`ResultRetcode` always present — it is the only field that states MT5's own
verdict unambiguously.

**Meanwhile:** anything not positively recognised as accepted is treated as a
rejection. Safe, but it means a successful trade in an unrecognised shape would
surface as an error.

---

## 3. Swap and commission on open positions

Neither position shape carries them:

```go
// PositionsToTVWs → Id, profit, qty, side, symbol, type, last, price, timeCreate
// PositionsToTVPage → the same, plus priceSL/priceTP
```

**Change:** add `swap` (MT5 `Storage`) and `commission` to both mappings.

**Meanwhile:** both columns render `Unavailable`. They are never shown as `0`,
because a real zero and a missing value mean different things to a trader
reconciling costs.

---

## 4. Stop-loss and take-profit on the WebSocket position stream

`PositionsToTVWs` omits `priceSL` / `priceTP`; `PositionsToTVPage` includes them.

**Change:** add both to the WS mapping.

**Meanwhile:** SL/TP show as `Unavailable` between REST snapshots rather than as
`0`, which would claim a protective level that does not exist. Reconciliation
refreshes them after every mutation.

---

## 5. Order expiration

The TV order shape has no expiration field, so `TypeTime` / `TimeExpiration`
never reach the client. The order ticket therefore cannot offer GTD/GTC.

**Change:** add `expiration` (unix seconds, `0` = GTC) and `typeTime` to the
order mappings, and accept `typetime` / `expiration` on `send_request`.

**Meanwhile:** every pending order is submitted with `typetime: 0` and the
column shows `Unavailable`.

---

## 6. Market depth (DOM)

`GET /api/Tick/get_marketdepth` exists and is proxied through, but its response
is passed to the client raw and its shape is not documented or verified against
a live book.

**What we need:** the response schema — ideally

```json
{
  "answer": {
    "bids": [{ "price": 1.1, "volume": 100000 }],
    "asks": [{ "price": 1.1002, "volume": 250000 }]
  }
}
```

with the volume unit stated (MT5 units or lots — see §9).

**Meanwhile:** the DOM widget is registered but capability-gated off and says
exactly why. An unverified ladder could misstate available liquidity.

---

## 7. Price alerts

No endpoint exists. Alerts held only in a browser tab stop working the moment it
closes, which is worse than not offering them.

**What we need:**

```
GET    /api/Alert/list?login=
POST   /api/Alert/create   { login, symbol, condition: "above"|"below", price, note }
DELETE /api/Alert/delete?id=
```

Plus delivery — a WS `TP` for alert events, or push/email from the server. The
UI can render them; it cannot be the thing that keeps them alive.

**Meanwhile:** capability-gated off with the reason shown.

---

## 8. Executions (per-fill feed)

There is no per-fill stream, so TradingView's execution markers are empty.

**What we need:** either a WS subscription for deal events, or a
`GET /api/Deal/since?login=&after=` for incremental polling.

**Meanwhile:** `executions()` returns an empty list. Synthesising executions
from the deal page would misreport fill prices on partially-filled orders.

---

## 9. Document the volume unit on every field

This one caused a production defect. MT5 reports volume at **two different
scales**, and mixing them is silent:

| Field                                 | Scale           |
| ------------------------------------- | --------------- |
| `VolumeMin` / `Max` / `Step`          | 1/10000 lot     |
| `VolumeMinExt` / `MaxExt` / `StepExt` | 1/100000000 lot |
| Trade request `volume`                | 1/10000 lot     |

Reading `VolumeMin: 100` as lots made the order ticket demand a 100-lot minimum
and blocked all trading.

**Ask:** state the unit for each field in `docs/API.md`. Better still, have the
`source=tv` transform emit **lots**, so the client never converts.

---

## 10. Account-type suffix policy for types 11 and 26

`internal/auth/crm.go` admits CRM account types `{11, 26, 57–67}`, but only
`57–67` have a known symbol suffix (`.` ECN, `!` Standard, `#` Social, none for
ECNPRO).

**What we need:** the suffix for types 11 and 26, or confirmation they are not
tradable through this terminal.

**Meanwhile:** they are filtered out of the account selector. Trading a group
whose suffix is unknown would send wrong symbol names to MT5.

---

## 11. Idempotency on trade submission

`send_request` forwards straight to MT5's dealer endpoint. A timed-out request
has genuinely unknown outcome, and a retry can open a second position.

**What would help:** accept a client-supplied key —
`Idempotency-Key: <uuid>` or a `clientRequestId` body field — and return the
original result for a repeat within a short window.

**Meanwhile:** trade mutations are **never** auto-retried. A timeout resolves to
"outcome unknown — reconciling" and the trader is told to check Positions before
retrying. Correct, but it puts the work on them.

---

## 12. Workspace and chart persistence (optional)

Layouts, chart drawings, studies, and journal notes are all in `localStorage`,
so they do not follow a trader between devices and are lost when the browser is
cleared. The UI says so.

**What would help:**

```
GET  /api/Workspace/get?login=
POST /api/Workspace/save   { login, document }
```

An opaque JSON blob per login is enough — the client versions and migrates it
already. The persistence layer is behind an interface, so a server adapter drops
in without any component changing.

---

## 13. News and economic calendar

No endpoint. Both would be straightforward proxies to whichever provider is
already licensed.

**Meanwhile:** not offered at all, rather than shown empty.

---

## 14. CORS allow-list omits the headers the client sends ✅ RESOLVED 2026-07-31

`internal/httpapi/middleware/cors.go` sets a fixed allow-list:

```go
w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
```

The terminal sends two more on every request: `X-Request-Id` (correlation, on
all requests) and `Idempotency-Key` (trade mutations only). Both are
non-simple headers, so a cross-origin browser preflights and the gateway
rejects the preflight — including on plain GETs.

**This does not affect production today.** Production serves the UI and the
gateway from the same origin through Caddy (`/gateway`), and dev proxies
through Vite the same way, so no preflight ever happens. It is filed because
it is a trap rather than a current fault: the moment anyone points the UI
straight at the gateway origin — a split-domain deployment, or a developer
running against staging without the proxy — **every request fails**, and the
symptom (a CORS error on a GET that has no body) does not look like a header
problem.

**Fixed** on gateway branch `fix/cors-allow-client-headers`
(`internal/httpapi/middleware/cors.go`). The allow-list now names all four
headers, and the middleware additionally:

- caches the preflight (`Access-Control-Max-Age: 600`), so a browser no longer
  preflights before every trade submission;
- refuses to cache a **denied** preflight, so a misconfiguration cannot outlive
  its own fix inside browser caches;
- sends `Vary: Origin` even when the origin is refused — it was previously sent
  only on the reflected branch, so a shared cache keyed on URL alone could hand
  an allowed origin's response to a disallowed one.

The regression test was confirmed to FAIL against the previous constant rather
than merely to pass against the new one.

**Nothing was worked around on the client, deliberately.** Dropping
`X-Request-Id` would cost the correlation id that makes gateway logs joinable to
a trader's report, and dropping `Idempotency-Key` would give up duplicate
protection on the one call that moves money — both far worse than a
configuration line.

---

## Summary

| #   | Item                   | Type            | Impact                                          |
| --- | ---------------------- | --------------- | ----------------------------------------------- |
| 1   | WS order-status table  | **defect**      | filled vs rejected indistinguishable            |
| 2   | Trade-response shape   | **defect risk** | a success could read as an error                |
| 3   | Swap / commission      | missing field   | cost columns unavailable                        |
| 4   | WS position SL/TP      | missing field   | protective levels unavailable between snapshots |
| 5   | Order expiration       | missing field   | no GTD orders                                   |
| 6   | Market depth schema    | undocumented    | DOM disabled                                    |
| 7   | Price alerts           | no endpoint     | feature disabled                                |
| 8   | Executions feed        | no endpoint     | no fill markers                                 |
| 9   | Volume units in docs   | documentation   | caused a live outage                            |
| 10  | Suffix for types 11/26 | information     | those accounts excluded                         |
| 11  | Trade idempotency      | enhancement     | timeouts need manual reconciliation             |
| 12  | Workspace persistence  | enhancement     | layouts do not follow the trader                |
| 13  | News / calendar        | no endpoint     | not offered                                     |
| 14  | CORS header allow-list | **fixed**       | would break any cross-origin deployment         |

**1, 2 and 9 are the ones worth doing first** — they are correctness issues, not
features, and one of them has already caused a production incident.

---

## Delivery status — 2026-07-31

| #   | Item                   | Gateway     | Client                                          |
| --- | ---------------------- | ----------- | ----------------------------------------------- |
| 1   | WS order-status table  | ✅ shipped  | workaround **removed**, both transports unified |
| 2   | Trade-response shape   | ✅ shipped  | all three shapes still accepted (see below)     |
| 3   | Swap / commission      | ✅ shipped  | cost columns live from REST and WS              |
| 4   | WS position SL/TP      | ✅ shipped  | absent still renders `Unavailable`, by design   |
| 5   | Order expiration       | ✅ shipped  | `expiration` / `typeTime` parsed                |
| 6   | Market depth schema    | ✅ shipped  | `MarketDepthWidget` enabled                     |
| 7   | Price alerts           | ✅ shipped  | `AlertsWidget` enabled, server-persisted        |
| 8   | Executions feed        | ✅ shipped  | chart execution arrows enabled                  |
| 9   | Volume units in docs   | ✅ shipped  | `qtyLots` preferred, MT5 units as fallback      |
| 10  | Suffix for types 11/26 | ✅ shipped  | admitted once a suffix is defined               |
| 11  | Trade idempotency      | ✅ shipped  | `Idempotency-Key` sent on mutations             |
| 12  | Workspace persistence  | ✅ shipped  | `SyncedWorkspaceStore` mirrors layouts          |
| 13  | News / calendar        | not planned | panels remain capability-gated off              |
| 14  | CORS header allow-list | ✅ shipped  | no client workaround, and none wanted           |

### Three things worth knowing about the client side

**The item-1 workaround had to be deleted, not left in.** The client had a
`statusFromWsOrderStatus` table that resolved the gateway's ambiguous WS status
buckets to `unknown` rather than risk reporting a fill that never happened. Once
the gateway started emitting correct statuses, that table became _wrong in the
opposite direction_: it read a correct "working" (6) as `unknown` and a correct
"filled" (2) as `working`. A defensive workaround is only safe while the defect
it defends against exists.

**Nothing is assumed to exist.** Every optional feature is gated on
`GET /api/Capabilities`, not on a 404. A gateway that predates the endpoint
reports nothing and every optional panel stays off with a stated reason.
Capability and workspace requests also set `tolerateUnauthorized`, so a 401 from
an _optional_ probe cannot sign a trader out of a valid session — a dead token
is still caught immediately by the account, position and order requests.

**Backwards compatibility is retained deliberately.** `interpretTradeResult`
still accepts all three historical trade-response shapes, and volume still falls
back to MT5 unit conversion when `qtyLots` is absent. The staging backend has not
been re-verified, and a client that only speaks the newest contract would break
against it for no gain.
