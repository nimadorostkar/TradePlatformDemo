# Real-time reconciliation

What the client can honestly guarantee about live trading state — and what it
cannot.

## The shape of the problem

The gateway is **snapshot-oriented, not an event log**. Every ~3 seconds it
pushes the full current answer for a subscription. There are no sequence
numbers, no versions, no event ids, and no deltas
(`GATEWAY/internal/realtime/{poller,hub,dispatch}.go`).

Three consequences follow directly, and the design is built around them:

1. **Absence is the close signal.** A position that disappears from a snapshot
   has been closed. Merging snapshots would resurrect it.
2. **Duplicate/out-of-order protection is not possible in the usual sense.**
   There is nothing to compare two frames against. Any claim of such protection
   would be false.
3. **A stale frame is indistinguishable from a fresh one by content alone.** The
   client must track arrival time itself.

## Ordering discipline

On login, account switch, and reconnect:

```
1. advance the session generation      ← everything older is now invalid
2. open the WebSocket subscriptions    ← frames BUFFER, they do not apply yet
3. fetch the authoritative REST snapshots
4. apply the REST snapshots
5. release the gates; apply the newest buffered frame if it is newer
6. apply frames live from here on
```

Step 2 **before** step 3 is deliberate. Opening the socket after the fetch
would lose every update that occurred during it. Buffering rather than applying
prevents an early frame from being overwritten by a snapshot that is actually
older.

Implemented in `src/app/providers/use-account-sync.ts` with
`SnapshotGate` and `SessionGenerationTracker`.

## Session generations

Every frame and every in-flight REST response carries the generation it was
requested under. `applyAccount`, `applyPositions`, and `applyOrders` drop
anything whose generation is not current
(`src/stores/trading-store.ts`).

This is what makes account switching safe. Without it, a position frame for
account A that arrives 200 ms after the user switches to account B would be
rendered as B's position — with B's balance beside it.

The switch sequence is:

```
resetForAccountSwitch(newGeneration)   ← wipe first, so nothing leaks even briefly
quoteStore.clear()
tear down old subscriptions
rebuild the suffix policy from the NEW account's type
open new subscriptions → fetch → apply
```

The suffix policy is rebuilt rather than reused, because the same display
symbol maps to a different gateway symbol per account group (`EURUSD.` vs
`EURUSD!`).

## Snapshot application

Collections are **replaced atomically**, never merged:

```ts
applyPositions(positions, generation, receivedAt); // full replacement
```

## After a trade

The client does **not** optimistically mutate local state. Every accepted
mutation calls `onStateChanged`, which refetches the authoritative snapshots.
The trader sees what the server says, not what the client hopes.

A timed-out mutation resolves to `unknown`, not to failure — the trade may well
have executed. The UI says "outcome unknown — reconciling" and directs the
trader to check Positions before retrying. **Trade mutations are never
auto-retried**. When the gateway advertises idempotency, an explicit retry uses
the same key; otherwise a replay could open a second position and is withheld.

## Staleness

`GatewaySubscriptionPool` arms a timer on every frame. If none arrives within
`VITE_QUOTE_STALE_AFTER_MS` (default 12 s = 4 cadences) while the socket is
still open, the subscription reports `stale`.

The header shows the **worst** state across the account, position, and order
streams, so a partially degraded session never looks healthy.

Connection states, all distinguished: `idle`, `connecting`, `connected`,
`reconnecting`, `stale`, `disconnected`, `auth-expired`, `failed`, plus browser
`offline`.

## Reconnection

- Exponential backoff with **full jitter**, capped at 30 s. Jitter matters:
  without it every socket in the pool retries in lockstep after a gateway
  restart.
- The retry counter resets only after a connection has been **stable** for 15 s,
  so a socket that opens and immediately drops does not reset the backoff.
- Intentional close (unsubscribe, dispose) never reconnects.
- Auth rejection (close code 1008/4401) never reconnects — hammering with a
  dead token is pointless.
- `online`/`offline` events clear the backoff and retry immediately.
- After reconnect the gates re-close and REST snapshots are refetched before
  the account is presented as synchronised again.

## Guarantees

**We do guarantee:**

- No frame from a previous account or session generation is ever applied.
- Local state after a snapshot equals that snapshot exactly.
- Stale data is visibly marked stale, with its age.
- A trade is never auto-retried.
- An order is never shown as `filled` without authoritative confirmation.
- Identical subscriptions share one socket, reference-counted.
- The access token never appears in any diagnostic, log, or UI surface.

**We do NOT guarantee:**

- Duplicate-event suppression — the server sends no event ids.
- Ordering _within_ a generation beyond "newest arrival wins" — there are no
  sequence numbers.
- That every intermediate state is observed. At a 3 s cadence a position opened
  and closed inside one interval may never appear. History is the record of
  record, not the live stream.
- Sub-second latency. The floor is the server's push cadence.
