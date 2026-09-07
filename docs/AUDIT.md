# Audit — troy (graph-grounded)

Generated: 2026-09-02 | Graph: `docs/GRAPH.md` + `docs/GRAPH.json` (67 files, static import parse) | Scope: `src/*`, `dashboard/*`, `test/*`
Method: dependency graph first, then 3 parallel slices (Arch / Perf / Security) every finding cites a graph edge or metric.

## Executive Summary

- **Graph shape:** DAG, zero SCCs. `src/app.ts` fan-out 15 (48KB god module) and `src/proxy/route.ts` fan-out 11 (27KB hub) dominate. `docs/GRAPH.md:68-69` flagged "cycles" are layer inversions/diamonds, not runtime circular imports — but same layering cost.
- **External deps lean:** 15 `dependencies` all React/dashboard UI; server runtime only `bun`, `bun:sqlite`, `node:*`. Zero unused deps.
- **Top risks (across slices):** login IP spoof, SSRF via dashboard session + loopback carve-out, CORS wildcard on authenticated `/api/*`, sync SQLite INSERT per cooldown transition blocking event loop, body-limit bypass on chunked requests, duplicated SSRF guard.
- **Dashboard isolation:** confirmed — `dashboard/*` zero `src/*` imports; HTTP via `dashboard/components/api.ts` only.
- **Total findings:** 34 (Arch 11 + Perf 11 + Security 12) → consolidated 14 ranked below (deduplicated).

## Graph Summary (from `docs/GRAPH.md`)

- **Layers:** `server.ts → app.ts (hub) → proxy/{route,stream,cooldown,registry,rateLimit} + rtk → providers/{anthropic,responses,freebuff,reasoning,commandcode,inject} → store/{db,migrations} → shared/{logger,modelsdev,dash/*}`. `dashboard/*` isolated.
- **Fan-in highest:** `logger.ts` 7, `store/db.ts` 6, `proxy/registry.ts` 6. **Fan-out highest:** `app.ts` 15, `route.ts` 11. Blast radius: break in either covers entire proxy.
- **Size hotspots:** `app.ts` 48KB (1,245 lines), `route.ts` 27KB, `commandcode.ts` 20KB, `freebuff.ts` 17.6KB, `store/db.ts` 17KB, `modelsdev.ts` 14.9KB — top 2 = 28% of `src`.
- **Violations:** `providers/anthropic.ts → proxy/route.ts` (HIGH), `providers/responses.ts → proxy/{route,stream}` (HIGH), `store/db.ts → proxy/registry.ts` (MED, type-only) — all inversions/diamonds, not SCCs.

## 1. Architectural Findings (vs graph)

| # | Severity | Title | Graph grounding | Location | Fix sketch |
|---|----------|-------|-----------------|----------|------------|
| A1 | HIGH | Provider leaves import router (`anthropic → route`) | `providers/anthropic.ts:2` → `route` (GRAPH.json:70) | `src/providers/anthropic.ts:2` | Extract `ChatDeps`/`Provider` to `src/proxy/types.ts`; both `route` and providers import types |
| A2 | HIGH | `responses → route+stream` same inversion + `stream` diamond | `providers/responses.ts:1-3` → `route,stream` | `src/providers/responses.ts:1-3` | Same `types.ts` + move `stream` helpers to shared `src/proxy/sse.ts` |
| A3 | MED | `store/db → registry` low-layer imports mid | `store/db.ts:3` → `registry` | `src/store/db.ts:3` | Move `Provider` type to `src/types/provider.ts` |
| A4 | HIGH | `app.ts` god module 48KB/1,245 lines mixed 5 responsibilities | fan-out 15, largest file | `src/app.ts:188-1245` | Split `src/server/router.ts` + `src/dash/api/*` + `src/dash/session.ts` + `src/providers/modelCache.ts` |
| A5 | HIGH | `route.ts` hub 27KB 5 concerns in one function | fan-out 11 | `src/proxy/route.ts:36-658` | Extract `chain.ts`, `pool.ts`, `forward.ts`, `orchestrator.ts` + `ProviderDriver` |
| A6 | MED | `store/db.ts` mixes CRUD + kv `rrchain` + log batch + event sourcing | fan-in 6 | `src/store/db.ts:345-513` | Split `connections.ts`, `usage.ts`, `stateEvents.ts`; move `rrchain` to `proxy/rrStore.ts` |
| A7 | MED | Duplicated `isPrivateHostname` | `app.ts:90` + `route.ts:43` identical | `src/app.ts:90`, `src/proxy/route.ts:43` | Share `src/lib/net.ts` |
| A8 | HIGH | `app` + `route` hub coupling blast radius | fan-out 15/11 | `src/app.ts`, `src/proxy/route.ts` | Same splits as A4/A5 |

Dashboard boundary: isolation confirmed; `dashboard/*` build-time coupling via `app.ts:391` `staticRoutes` only.

## 2. Performance Findings (hot path `app → route` + `cooldown → db` + `route → stream/freebuff`)

| # | Severity | Title | Graph grounding | Location | Impact | Fix sketch |
|---|----------|-------|-----------------|----------|--------|------------|
| P1 | HIGH | Sync SQLite INSERT per cooldown transition blocks loop | `route → cooldown → db` per attempt | `src/proxy/cooldown.ts:108-114` + `src/store/db.ts:484` | 20 inserts/s at 50 rps → 20-100ms blocked/s | Batch appends / async queue |
| P2 | HIGH | Sync `readFileSync`+`homedir()` on freebuff cold path | `route → freebuff` (`node:fs/os`) | `src/providers/freebuff.ts:182` + `src/proxy/route.ts:388` | 1-10ms block first freebuff req | Hoist `discoverFreebuffToken` to startup / async |
| P3 | HIGH | 2× `JSON.stringify` + spread per chain member + N+1 `listConnections` | `route` fan-out 11, `route → db` per spec | `src/proxy/route.ts:264,315,322` | body 4KB×5 → 20KB + 5 SELECTs | Cache `JSON.stringify`+`byteLength` and `listConnections` per request |
| P4 | HIGH | `readBody` + `freebuffJsonReply` string-concat O(n²) | `route → stream` | `src/proxy/stream.ts:97`, `src/providers/freebuff.ts:406` | 32MB → ~512MB moves | `Uint8Array` + `Buffer.concat` |
| P5 | MED | SSE `scanUsage`/`sseTranslate` string buf + `indexOf`/`slice` per line | `route → stream` leaf | `src/proxy/stream.ts:188,342` | 10k chunks → ~10MB extra copies | Binary line buffer |
| P6 | MED | `idleGuard` per-chunk Promise+timeout + per-stream interval | `route → stream` | `src/proxy/stream.ts:262` | 1k chunks → 1k timers | Single resettable timer |
| P7 | MED | `takeHead` first-byte timeout leaks reader | `route → stream` | `src/proxy/stream.ts:123` | Orphan TCP on hang | `reader.cancel()` on timeout |
| P8 | MED | Round-robin `nextChainStart` SELECT+INSERT per request | `cooldown → db` via `kv:rrchain` | `src/proxy/cooldown.ts:126` + `src/proxy/route.ts:246` | 2 DB ops per RR req | Keep `rrchain` in-mem, persist lazily |
| P9 | MED | `tryAutoBan` full table scan per auth fail | `route → db` | `src/proxy/route.ts:84` | 401 storm → scan amplification | `getConnectionById` single-row lookup |
| P10 | LOW | `providerModelsCache` unbounded Map, no LRU, probe no timeout | `app` hub | `src/app.ts:33` | Memory growth via custom providers | maxSize 100 + LRU + `AbortSignal.timeout(5000)` |
| P11 | LOW | `flushLogs`/`pruneStateEvents` ok | `db` internal | `src/store/db.ts:445` | — | Index `state_events.ts` if missing |

Cache notes: `providerModelsCache` TTL 300s, dashboard-only hit ~80% warm; `cooldown` `isEligible` ~100% eligible, `states`/`circuits` in-mem, durable `appendStateEvent` 100% of transitions.

## 3. Security Findings (trust boundaries vs graph)

Entry points: `/v1/*` (proxy), `/api/*` (dashboard), static/health. Guards: `isPrivateHostname`/`assertPublicUrl`, `BODY_LIMIT_*`, `authed` session + `ApiAuth`.

| # | Severity | Title | Graph grounding | Location | Fix sketch |
|---|----------|-------|-----------------|----------|------------|
| S1 | HIGH | Login rate-limit bypass via spoofed `X-Forwarded-For` | `server → app` fan-out 15 | `src/app.ts:228` | Gate `x-forwarded-for` behind `TRUST_PROXY=1`; else `server.requestIP()` |
| S2 | HIGH | SSRF to localhost via dashboard session + `base_url` loopback carve-out | `app → registry`, `route → registry/db` | `src/app.ts:122,1066` + `src/proxy/route.ts:200` | Remove carve-out or `TROY_ALLOW_LOOPBACK=1` + log |
| S3 | HIGH | CORS wildcard on authenticated `json()` | `app` hub `json()` fan-out | `src/app.ts:80` | Per-request origin check, not `*` |
| S4 | MED | Body-limit bypass on chunked (char vs byte, `includes("/v1/")`) | `app → route` | `src/app.ts:126,435` | Stream with byte counter + `pathname.startsWith("/v1/")` |
| S5 | MED | `isPrivateHostname` gaps (IPv6, DNS rebinding) | `app`+`route` duplication | `src/app.ts:90`, `src/proxy/route.ts:43` | Shared `src/lib/net.ts` + resolve checks |
| S6 | MED | Credentials plaintext at rest + `extra` placeholder injection | `app → db`, `route → db/registry` | `src/store/db.ts:5`, `src/proxy/route.ts:162` | Warn at-rest + validate placeholders `^[a-zA-Z0-9._-]+$` |
| S7 | MED | Same cycle as A1/A2 (security blast radius) | `providers → route` | `src/providers/anthropic.ts:2` | Types extraction (same as A1) |
| S8 | LOW | `safeEqual` length leak, `extractApiKey` trim | `server → auth` | `src/dash/auth.ts:20` | Pad to fixed time |
| S9 | LOW | Session `Secure` conditional, no `__Host-` | `app` hub | `src/app.ts:76,498` | `__Host-troy_session` + unconditional `Secure` when not loopback |
| S10 | LOW | FreeBuff token world-readable + `Math.random` client ID | `app → freebuff`, `route → freebuff` | `src/providers/freebuff.ts:25,156` | Warn on `&0o077` + `crypto.randomUUID()` |

Dead code: none — `rtk`, `commandcode`, `inject` all live via `route` fan-in 1. Docs drift: `docs/GRAPH.md:103-104` overstates cycle (type-only, no `registry → route`), line-number drifts in `docs/ERRORS.md`, missing env vars in `docs/REFERENCE.md` (`TROY_RATE_LIMIT` etc.), `provider` count ~52 vs doc ~45.

## 4. Consolidated Ranked Findings (dedup, 14)

| Rank | Sev | Title | Primary file:line | Graph edge |
|------|-----|-------|-------------------|------------|
| 1 | HIGH | Login IP spoof (S1) | `src/app.ts:228` | `app` fan-out 15 |
| 2 | HIGH | SSRF localhost via session (S2) | `src/app.ts:122` + `src/proxy/route.ts:200` | `app→registry`, `route→db` |
| 3 | HIGH | CORS wildcard on auth responses (S3) | `src/app.ts:80` | `app` hub `json()` |
| 4 | HIGH | Sync DB INSERT per cooldown transition (P1) | `src/proxy/cooldown.ts:108` | `route→cooldown→db` |
| 5 | HIGH | God module `app.ts` 48KB (A4) | `src/app.ts:188` | fan-out 15 |
| 6 | HIGH | Hub `route.ts` 27KB (A5) | `src/proxy/route.ts:36` | fan-out 11 |
| 7 | HIGH | Provider → route inversions (A1/A2/S7) | `src/providers/anthropic.ts:2` | `providers→route` |
| 8 | MED | Body-limit bypass chunked (S4/P4) | `src/app.ts:126` + `src/proxy/stream.ts:97` | `app→route`, `route→stream` |
| 9 | MED | Duplicated SSRF guard (A7/S5) | `src/app.ts:90` + `src/proxy/route.ts:43` | `app`+`route` dup |
| 10 | MED | N+1 + double stringify per chain (P3/P8/P9) | `src/proxy/route.ts:264,322,84` | `route→db`, `cooldown→db` |
| 11 | MED | SSE buffering + timer churn (P5/P6/P7) | `src/proxy/stream.ts:123,186,262` | `route→stream` |
| 12 | MED | Store mixes `rrchain` + event log (A6) + `db→registry` (A3) | `src/store/db.ts:3,345` | `db→registry` |
| 13 | LOW | Cache unbounded + probe no timeout (P10) | `src/app.ts:33` | `app` hub |
| 14 | LOW | Session/secret hygiene (S8-S10) | `src/dash/auth.ts:20`, `src/app.ts:76` | `server→auth` |

## 5. What Not to Optimize (graph-pruned)

- No new runtime deps (graph shows zero server deps needed; `bun:sqlite` + `node:*` suffice).
- No dashboard→store coupling (isolation confirmed — keep HTTP boundary).
- `rtk`/`commandcode`/`inject` not dead — fan-in 1 via `route` is intentional, not deletion target.
- `registry`/`logger` fan-in 6-7 is benign; no split needed.
- Real SSCC count 0 — no bundler circular-import hazard; layer inversions fix via types, not restructuring.

## Verification

- Graph gates: `docs/GRAPH.md` (mermaid + metrics) + `docs/GRAPH.json` (67 nodes) regenerate via `python import parse`.
- Audit slices: `local://audit-arch.md` (11), `local://audit-perf.md` (11), `local://audit-security.md` (12) each cite file:line + graph edge.
- Next: `docs/OPTIMIZATION.md` (graph-grounded proposals) + quick-wins (net.ts dedupe, types extraction) with `bun check` + `bun test` + `lsp diagnostics`.
