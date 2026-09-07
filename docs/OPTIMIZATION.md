# Optimization Proposals — graph-grounded

Source: `docs/GRAPH.md` (67 nodes) + `docs/AUDIT.md` (14 ranked findings). Each proposal cites graph edge that makes it matter.

## Quick-wins (low risk, implement now) — next section

| # | Title | Graph edge | Cost | Impact |
|---|-------|------------|------|--------|
| Q1 | Extract `src/lib/net.ts` dedupe `isPrivateHostname` + `assertPublicUrl` | `app.ts:90` dup `route.ts:43` | 1 file + 2 import rewrites | Single source for SSRF guard, removes drift |
| Q2 | Extract `src/proxy/types.ts` for `ChatDeps`/`Connection`/`Provider` shared type | `providers→route` (HIGH), `db→registry` (MED) | 1 file + 4 imports | Breaks leaf→mid inversions without behavior change |
| Q3 | Gate `X-Forwarded-For` behind `TRUST_PROXY`, fix CORS wildcard, pathname-based body limit | `server→app` | 3 lines in `app.ts` | Closes S1/S3/S4 highs |
| Q4 | Cache `listConnections(provider)` per request + single-row `getConnectionById` for `tryAutoBan` | `route→db` N+1 | 10 lines in `route.ts` + 1 method in `db.ts` | Removes N+1, halves DB QPS on auth storms |
| Q5 | Bound `providerModelsCache` (maxSize 100 + LRU) + `AbortSignal.timeout(5000)` on probe | `app` hub | 8 lines in `app.ts` | Prevents unbounded growth |

## Medium (next sprint)

| # | Title | Edge | Cost | Impact |
|---|-------|------|------|--------|
| M1 | Batch `appendStateEvent` (queue + flush interval) instead of sync INSERT per transition | `route→cooldown→db` (P1) | `cooldown.ts` queue + `db.ts` batch API | Removes per-attempt event-loop block; biggest tail-latency win |
| M2 | `Uint8Array` line buffer in `scanUsage`/`sseTranslate` + `takeHead` reader cancel | `route→stream` (P5/P7) | `stream.ts` rewrite ~80 lines | -15% CPU on streams, fixes leaked TCP |
| M3 | Single resettable timer in `idleGuard` | `route→stream` (P6) | `stream.ts:262` ~30 lines | Timer churn down 1000× |
| M4 | `rrchain` in-mem only, persist lazily | `cooldown→db` (P8) | `cooldown.ts:126` guard | -2 DB ops per RR request |
| M5 | Split `app.ts` router vs dash API vs session | fan-out 15 | File moves only | Testability, blast radius |

## Large (quarter)

| # | Title | Edge | Cost | Impact |
|---|-------|------|------|--------|
| L1 | `route.ts` → `chain/pool/forward/orchestrator` + `ProviderDriver` | fan-out 11 | ~4 files | Cohesion, testable routing |
| L2 | `store/db.ts` → per-domain modules + `Store` façade | fan-in 6 | ~5 files | Ownership clarity |
| L3 | Streaming body parse (no full `text +=` buffering) | `route→stream` | `stream.ts:97` | O(n²)→O(n) for 32MB |

## Not Proposed (graph says no)

- New server deps, dashboard→store direct coupling, deleting `rtk/commandcode/inject` (all live via `route`), splitting `registry/logger` (benign fan-in).
