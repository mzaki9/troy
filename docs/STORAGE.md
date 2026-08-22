# Storage

One SQLite file, `${TROY_DATA}/troy.db` (default `./data/`). Opened with `bun:sqlite`,
WAL journal, `synchronous=NORMAL`, ~1 MiB page cache, autocheckpoint at 500 pages.

## Schema

| Table | Purpose |
|---|---|
| `connections` | provider accounts: id, provider, api_key, name, base_url, extra JSON, priority, is_active |
| `combos` | name UNIQUE → JSON array of specs + strategy (default `fallback`) |
| `models` | saved/chosen model specs |
| `kv` | settings blob, troy API key, dashboard password hash, custom providers |
| `usage_history` | one row per request: ts, provider, model, combo, status, latency_ms, tokens JSON, rtk_saved, rtk_seen |
| `state_events` | append-only cooldown/circuit log: kind (`fail`\|`success`\|`circuit_open`), conn_id, key, status, reason, until_ms, backoff_level |

Migrations are idempotent and run every boot; legacy provider ids get renamed in place
(`glm`→`zai`, `alims-intl`→`alibaba`, …) across connections and history.

Defaults for settings: `{rtk_on: 1, caveman_level: "off", ponytail_level: "off",
strategy: "fill-first"}`.

## Event sourcing for resilience

Every cooldown mutation and circuit open is appended to `state_events` **before** the
in-memory map changes (write-ahead ordering). At boot `foldStateEvents()` feeds the full log
into `CooldownStore.replay()` — cooldowns, backoff levels and open circuits survive crashes
with their remaining time intact. See [RESILIENCE.md](RESILIENCE.md).

## Log flush

Request logs queue in memory; a 2 s flusher drains them in one transaction. If the write
fails the batch re-queues, bounded to the last 10 000 rows.

## Retention

Hourly maintenance trims:

- `usage_history` older than 30 days — deleted
- `state_events` older than 24 h — pruned

## Stats

- `GET /api/stats` — one GROUP BY over usage history: totals + per-model/provider requests,
  ok rate, avg latency, p95 (nearest-rank over last 1000), token sums, RTK saved/seen/hits
- `GET /api/stats/daily?days=N` (≤ 30, default 7) — local-day bucketed, zero-filled counts

Related: [RESILIENCE.md](RESILIENCE.md) · [REFERENCE.md](REFERENCE.md)
