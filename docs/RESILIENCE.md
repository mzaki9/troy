# Resilience — cooldowns & circuit breakers

troy treats every upstream failure as data: classify it, cool the right thing down for the
right duration, and keep serving from what's still alive. All of this state survives restarts.

## Two state machines

### 1. Cooldowns (per account/connection)

Each failed attempt classifies the error and locks the account for a duration:

| Kind | Trigger | Duration |
|---|---|---|
| `short` | "request not allowed" | 5 s |
| `quota` | HTTP 402 or text match ("insufficient balance", "insufficient credits", "quota exceeded", "out of budget", "exceeded your current quota", "billing") | flat 120 s — **no escalation**, quota doesn't heal by retrying harder |
| `rate` | HTTP 429 or "rate limit", "too many requests", "capacity", "overloaded" | exponential: `2 s × 2^(level−1)`, capped at 5 min, symmetric ±10 % jitter |
| `auth` | 401 / 403 / 404 | 120 s |
| `transient` | everything else | 30 s |

Rules that matter:

- Backoff base 2 s, max level 15, max lock 5 minutes.
- An upstream **`Retry-After` header wins** over local backoff whenever it parses to a sane
  value (seconds or HTTP-date, ≤ max).
- Locks are keyed per model (`"*"` for whole-account). Success clears expired locks and prunes
  empty state shells.

### 2. Circuit breakers (per `provider/model`)

- ≥ 3 failures within a 60 s window → circuit **open for 30 s**
- Open circuits are skipped instantly during routing (`503` with the breaker message — no
  wasted upstream call)
- Any success closes the circuit; normal traffic acts as the half-open probe
- Every open persists a `circuit_open` event

## Selection policy

`pick()` implements **sticky round-robin**: while the combo strategy is `round-robin` and the
account pool has ≥ 2 members, requests stay on the same healthy account for 2 consecutive
successes, then advance. Any other strategy gets fill-first (first eligible account).
This spreads load without round-trip overhead per request.

## Durability — write-ahead + replay

Every fail/success/circuit-open is appended to the `state_events` table in SQLite **before**
the in-memory map mutates (write-ahead ordering). At boot:

```
CooldownStore.replay(store.foldStateEvents(), ...)
```

rebuilds all state: expired entries dropped, newest / max-`until` wins per key, open circuits
restored with their remaining time. A crash mid-storm costs you nothing.

The same event log powers the client-facing behavior: when an entire combo chain is exhausted,
`earliestRetryAfter()` (min future expiry across all relevant states) becomes the response's
`retry-after` header, and `lastFailReason()` is surfaced in the 503 body.

Related: [ROUTING.md](ROUTING.md) · [STORAGE.md](STORAGE.md)
