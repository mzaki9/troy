# Dependency Graph — troy

Generated: 2026-09-02 (updated post quick-wins) | Source: static import parse (69 files)

## Module Import Graph

```mermaid
graph TD
  %% Entry
  server["src/server.ts<br/>2.5KB"]
  app["src/app.ts<br/>48KB - GOD MODULE"]
  logger["src/logger.ts<br/>1.5KB"]
  auth["src/dash/auth.ts"]
  stats["src/dash/stats.ts"]
  modelsdev["src/modelsdev.ts<br/>14.9KB"]
  db["src/store/db.ts<br/>17KB"]
  migrations["src/store/migrations.ts"]
  route["src/proxy/route.ts<br/>27KB"]
  stream["src/proxy/stream.ts<br/>13.7KB"]
  cooldown["src/proxy/cooldown.ts<br/>12KB"]
  registry["src/proxy/registry.ts<br/>12KB"]
  rateLimit["src/proxy/rateLimit.ts<br/>2.8KB"]
  rtk["src/rtk.ts<br/>12KB"]
  anthropic["src/providers/anthropic.ts"]
  responses["src/providers/responses.ts"]
  freebuff["src/providers/freebuff.ts<br/>17.6KB"]
  reasoning["src/providers/reasoning.ts"]
  commandcode["src/providers/commandcode.ts<br/>20KB"]
  inject["src/providers/inject.ts"]
  ompPlugin["src/omp-plugin.ts"]
  dshPlugin["src/dsh-plugin.ts"]
  openCodePlugin["src/opencode-plugin.ts"]
  dashApp["dashboard/app.tsx"]
  dashPages["dashboard/components/pages/*"]
  %% Edges — post Q1-Q2 quick-wins
  server --> app
  server --> auth
  server --> logger
  app --> auth
  app --> stats
  app --> dshPlugin
  app --> ompPlugin
  app --> openCodePlugin
  app --> anthropic
  app --> freebuff
  app --> responses
  app --> cooldown
  app --> rateLimit
  app --> registry
  app --> route
  app --> db
  app --> modelsdev
  app --> logger
  app --> net
  stats --> modelsdev
  stats --> registry
  stats --> db
  modelsdev --> reasoning
  route --> logger
  route --> modelsdev
  route --> commandcode
  route --> freebuff
  route --> inject
  route --> reasoning
  route --> rtk
  route --> db
  route --> cooldown
  route --> registry
  route --> stream
  route --> net
  route --> types
  anthropic -.->|now via types + route handleChat| route
  anthropic --> types
  anthropic --> stream
  responses -.->|now via types + route handleChat| route
  responses --> types
  responses --> stream
  types --> db
  types --> cooldown
  net["src/lib/net.ts — SSRF guard"]
  types["src/proxy/types.ts — ChatDeps/LogRow"]
  db --> logger
  db --> registry
  db --> migrations
  cooldown --> db
  dashApp --> dashPages
  classDef hot fill:#ff6b6b,stroke:#c92a2a,color:#fff
  classDef cycle fill:#ffd43b,stroke:#f59f00
  classDef fixed fill:#51cf66,stroke:#2b8a3e,color:#fff
  class app,route hot
  class anthropic,responses,db cycle
  class net,types fixed
```

## Layering & Direction

```
Entry:       src/server.ts -> src/app.ts
Orchestrator: src/app.ts (hub) -> all layers
Dashboard:   dashboard/* (isolated, only React + api.ts -> HTTP)
Store:       src/store/db.ts + migrations.ts
Proxy:       src/proxy/{route,stream,cooldown,registry,rateLimit,types} + src/rtk.ts + src/lib/net.ts
Providers:   src/providers/{anthropic,responses,freebuff,reasoning,commandcode,inject}
Plugins:     src/omp-plugin.ts, src/dsh-plugin.ts, src/opencode-plugin.ts
Shared:      src/logger.ts, src/modelsdev.ts, src/dash/*
Tests:       test/* -> src/*
```

## Cycles & Layering Violations

| Edge | Severity | Status | Note |
|------|----------|--------|------|
| providers/anthropic.ts -> proxy/route.ts | **HIGH** | **PARTIAL FIX** | Now `providers/anthropic.ts` imports `ChatDeps` from `proxy/types.ts` (type-only); `handleChat` still from `route.ts` — remaining coupling is runtime, next step inject `handleChat` via `ChatDeps` or app wiring to fully break. |
| providers/responses.ts -> proxy/route.ts + proxy/stream.ts | **HIGH** | **PARTIAL FIX** | Same: `ChatDeps` now from `types.ts`; `handleChat` + `stream` remain. |
| store/db.ts -> proxy/registry.ts | **MEDIUM** | OPEN | Store (low) imports mid `registry` type — move `Provider` to shared `src/types/provider.ts` (M). |
| app.ts:90 / route.ts:43 `isPrivateHostname` dup | **MED** | **FIXED** | Deduplicated to `src/lib/net.ts` (Q1). |
Cycle closure: previously `route -> anthropic/responses -> route`; now `ChatDeps` via `types.ts` reduces type-coupling, but runtime `handleChat` edge remains — full break needs injection (see `docs/OPTIMIZATION.md`).

## Quick-Wins Applied (2026-09-02)

| Win | File | Change |
|-----|------|--------|
| Q1 | `src/lib/net.ts` (new) | Extracted `isPrivateHostname` + `assertPublicUrl` from `app.ts:90-124` / `route.ts:43-61` |
| Q2 | `src/proxy/types.ts` (new) | `ChatDeps`/`LogRow` moved from `route.ts`; providers now import types, not router |
| Q3 | `src/app.ts` | `json()` no default CORS `*`, `readBody` pathname-based, `clientIp` gated by `TROY_TRUST_PROXY`, `providerModelsCache` FIFO 100 |

## Size Hotspots

| Rank | File | Size |
|------|------|------|
| 1 | src/app.ts | 48KB (1,245 lines) |
| 2 | src/proxy/route.ts | 27KB |
| 3 | src/providers/commandcode.ts | 20KB |
| 4 | src/providers/freebuff.ts | 17.6KB |
| 5 | src/store/db.ts | 17KB |
| 6 | src/modelsdev.ts | 14.9KB |

Top 2 files = 75KB (~28% of src). God-module concentration.

## External Dependency Weight

All 15 dependencies are React/dashboard UI (radix, cmdk, recharts, lucide). Zero runtime server deps beyond bun/bun:sqlite/node:* — lean. No unused deps. Dashboard pulls 29 react edges.

## Coupling Metrics

- Fan-in highest: src/logger.ts (7 importers), src/store/db.ts (6), src/proxy/registry.ts (6).
- Fan-out highest: src/app.ts (15), src/proxy/route.ts (11).
- Blast radius: app.ts or route.ts break covers entire proxy.

## Raw Adjacency JSON

See docs/GRAPH.json (full 69-file adjacency).
