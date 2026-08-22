# Model catalog

Two jobs: **discovery** (what can I use?) and **enrichment** (what can this model actually do?).

## Discovery — providers own it

Each provider's `/models` endpoint is probed live (`GET /api/providers/<id>/models`, 15 s
timeout); providers without one serve their `staticModels`. Every model gets enriched with its
thinking flag on the way out.

## Enrichment — models.dev

[models.dev](https://models.dev) supplies two payloads:

- canonical `lab/model-id` catalog (~290 KB) with reasoning flags
- per-provider catalog (~4 MB) with real context/output limits, tool-call support, modalities

Refresh cycle: first sync 5 s after boot, then every 24 h. Each payload syncs independently,
30 s fetch timeout, 16 MB size cap, validated on ingest, atomic swap on success — previous
snapshot kept on failure (fail-open).

A seed snapshot ships inside the package (`src/modelsdev-seed.json`) so fresh installs work
offline; the provider catalog populates after the first successful sync.

### Lookup layers (`enrich(spec)`)

1. **provider-exact** — entry in the api.json provider catalog: reasoning/toolCall/modalities/limits/name
2. **canonical** — exact key → suffix-stripped (`-free`, `:free`, `-latest`, `-thinking`,
   `-max`, …) → cross-lab bare-model-part index (unique hit or unanimous flags)
3. **regex floor** — `isReasoningModel` heuristics on the bare id (o-series, gpt-5, r1/r2,
   "thinking"/"reasoner", deepseek v3+, gemini 2.5+, claude opus/sonnet 4, glm 4.6+, kimi-k2,
   minimax-m2…); tool-call/attachment assumed true

Layer usage counters are exposed via `GET /api/modelsdev/status`
(`{lastSyncAt, canonicalEntries, providerEntries, lookups:{provider, canonical, regex}}`).

`TROY_ENRICH` selects layers (default `"limits,modalities"`; `""` disables extras).

## Combos

`enrichCombo(specs)` intersects capabilities across members: reasoning / tool-call / attachment
only if every member has them; context/output limits are the minimum. The combo's pseudo-model
entry in `/v1/models` reflects that weakest-member set, so capability-aware clients never send
a chain something it can't finish.

Related: [PROVIDERS.md](PROVIDERS.md) · [ROUTING.md](ROUTING.md)
