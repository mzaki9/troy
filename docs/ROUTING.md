# Routing

How troy turns one `model` string into a healthy upstream request.

## Model specs and combos

Two things can appear in `"model"`:

- **Spec** — `provider/model`, e.g. `groq/llama-4-maverick`. A bare name like `claude-sonnet-4`
  is resolved by `inferProvider` (`claude-*`/`gemini-*` → openrouter, `gpt-*` → openai,
  `deepseek-*` → deepseek, `glm-*` → zai-cn, contains `grok` → xai, else openai).
- **Combo** — a named alias stored in SQLite mapping to an ordered list of specs plus a
  strategy. Combos show up in `/v1/models` as pseudo-models (`owned_by: "troy"`).

A combo advertises its **weakest member's** capabilities: reasoning / tool-call / attachment
support only if *every* member has it; context and output limits are the minimum across members.
That means a client that checks capabilities never sends something the chain can't finish.

## Strategies

`COMBO_STRATEGIES = { "fallback", "random", "round-robin" }` (stored per combo; invalid values
fall back to `fallback`).

| Strategy | Order |
|---|---|
| `fallback` | saved order |
| `round-robin` | chain rotated by a per-combo counter (`nextChainStart(name) % length`) |
| `random` | Fisher–Yates shuffle seeded from `crypto.getRandomValues`, per request |

## The failover walk

Two nested loops:

1. **Outer loop** — combo members in strategy order.
2. **Inner loop** — accounts (connections) of that provider.

Per attempt:

- **Capability preflight** (computed once per request):
  - `needsTools` — non-empty `tools[]`
  - `needsVision` — any `image_url` / image part in the JSON body
  - `estTokens = ceil(bodyLength / 4)`
  Members missing tools/vision/context are skipped with a typed trace reason; if nothing
  qualifies the client gets `503`.
- **Circuit check** — breaker-open members are skipped fast (`503` with breaker message).
- **Account pick**:
  - keyless providers (`auth === "none"`) synthesize one `<provider>-keyless` connection
  - filter to active, not-excluded-this-request, cooldown-eligible accounts
  - prefer accounts under `TROY_MAX_INFLIGHT` (default 10); if all saturated, pile onto least-loaded
  - final pick via the cooldown store's selection policy (see [RESILIENCE.md](RESILIENCE.md))
- **Deadlines** — streams get `TROY_STREAM_IDLE_MS` as TTFB guard; non-streams get
  `TROY_UPSTREAM_TIMEOUT_MS`. The body is serialized once per member and reused across accounts.

Every failure calls `cooldowns.fail(...)` (with the upstream `Retry-After` when present),
excludes that account for this request, and moves on. Chain exhausted → the **last** upstream
error/status is returned verbatim plus a derived `retry-after` header.

## Reasoning effort

Effort aliases (`o3-mini-high` style suffixes: minimal/low/medium/high/max/xhigh) are resolved
before routing. `reasoning_effort` is injected only for models flagged as reasoning-capable and
stripped otherwise — no more 400s from models that don't know the field.

Streams always get `stream_options: { include_usage: true }` so token accounting survives.

## Trace

`TROY_TRACE=1` prints per-request play-by-play: skip reasons (unknown provider, preflight miss,
open circuit), account picks, cooldown set/clear events, circuit opens, chain exhaustion.

Related: [RESILIENCE.md](RESILIENCE.md) · [PROTOCOLS.md](PROTOCOLS.md)
