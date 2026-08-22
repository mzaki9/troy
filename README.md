<div align="center">

<img src="./TROY.svg" alt="troy" width="120"/>

<br/>
<br/>

# 🏰 troy — the local LLM gateway that never says die

<video src="./docs/media/troy-hero.mp4" width="100%" autoplay loop muted playsinline>
  Your browser can't play the demo — watch <a href="./docs/media/troy-hero.mp4">troy-hero.mp4</a>.
</video>

**One endpoint → every provider. Combos walk a chain of models with automatic failover,
per-account cooldowns and circuit breakers — so a dead free tier costs you one request,
not your session.**

`35 ms cold start` · `~0.3 ms routing overhead` · `~40 MB RAM` · `zero runtime dependencies`

[![npm version](https://img.shields.io/npm/v/troy-proxy?color=cb3837&logo=npm)](https://www.npmjs.com/package/troy-proxy)
![License](https://img.shields.io/badge/License-GPL--3.0--or--later-blue.svg)
[![Bun](https://img.shields.io/badge/runs%20on-Bun%20%E2%89%A51.4-f472b6?logo=bun)](https://bun.sh)

</div>

---

troy is a **local-first AI gateway** written in TypeScript on Bun. Point Claude Code, Codex CLI,
OpenCode or any OpenAI-compatible tool at `http://localhost:31337/v1` and get:

- 🔀 **Combos** — name an ordered chain of `provider/model` specs; troy walks the chain on failure
- 🌐 **45+ built-in providers** — OpenRouter, Groq, DeepSeek, Cerebras, xAI, z.ai, Cloudflare and more — plus your own custom ones
- 🛡️ **Resilience built in** — per-account cooldowns with exponential backoff, circuit breakers per model, crash-safe state replay from SQLite
- 🔌 **Three wire protocols in** — OpenAI Chat Completions, Anthropic Messages (`/v1/messages`), OpenAI Responses (`/v1/responses`) — translated to any upstream
- 🗜️ **RTK built in** — a tool-output compressor that shrinks `git diff`, grep, tree and friends before they eat your context window
- 🎭 **Built-in prompt styles** — `caveman` and `ponytail` system-prompt injectors for token-frugal answers, five intensity levels each
- 🧠 **Model intelligence** — live catalog enriched by [models.dev](https://models.dev): reasoning flags, vision, context/output limits
- 📊 **Usage dashboard** — requests, latency p95, token totals, per-model stats, live logs
- 🤝 **One-click OpenCode integration** — installs itself as a live OpenCode provider

<div align="center"><b>Everything stays on your machine. No account, no telemetry, no cloud hop.</b></div>

---

## 🚀 Quick Start

```bash
# requires Bun ≥ 1.4  (curl -fsSL https://bun.sh/install | bash)

npm install -g troy-proxy     # or: bun add -g troy-proxy
troy                          # or: troy-proxy — both commands work

# no install, one-off:
npx troy-proxy                # or: bunx troy-proxy
```

> Installed **locally** (without `-g`) inside another project? The binary isn't on your PATH —
> run it with `npx troy-proxy` / `bunx troy-proxy`, or add `-g`.

Open **http://localhost:31337** — log in with the default password `troy123`
(you'll be prompted to change it), then:

1. Add a **connection**: pick a provider, paste its API key
2. Pick **models** from the live catalog
3. Bundle them into a **combo** — e.g. `groq/llama-4-maverick → deepseek/deepseek-v4 → zai/glm-5`
4. Copy your troy key from Settings into any OpenAI-compatible client:

```bash
export OPENAI_BASE_URL=http://localhost:31337/v1
export OPENAI_API_KEY=sk-troy-...        # shown in Settings
```

Or let Anthropic-style clients (Claude Code) talk to the same server:

```bash
export ANTHROPIC_BASE_URL=http://localhost:31337
```

Run it anywhere else:

```bash
PORT=8080 troy                    # different port
TROY_DATA=~/.troy troy            # different data dir
TROY_TRACE=1 troy                 # play-by-play routing trace in terminal
```

---

## 🎯 Combos & Failover — the flagship

A combo is a pseudo-model backed by a **chain** of real `provider/model` pairs. Clients see
one model name; troy does the walking:

```jsonc
{
  "model": "my-daily-driver",   // combo name — resolves to a whole chain
  "messages": [...]
}
```

<div align="center">
<video src="./docs/media/troy-failover.mp4" width="90%" controls muted></video>
</div>

Three strategies decide the order the chain is tried in:

| Strategy | Behavior |
|---|---|
| `fallback` | saved order, first healthy member wins |
| `round-robin` | rotates the starting member every request |
| `random` | Fisher–Yates shuffle per request |

On failure troy doesn't give up — it walks accounts *within* a provider, then members *across*
the chain, classifying every error into short / quota / rate-limit / auth / transient cooldowns
and opening circuit breakers around models that are clearly down.
The client gets either a healthy answer or the real upstream error plus a `retry-after` hint.

> 📖 Deep dives: [Routing](docs/ROUTING.md) · [Cooldowns & Circuit Breakers](docs/RESILIENCE.md)

---

## ⚡ Featherweight by design

| Metric | Value |
|---|---|
| Cold start → first response | **~35 ms** |
| Local routing overhead per request | **~0.3 ms** |
| Idle memory (RSS) | **~40 MB** |
| npm tarball | **628 kB** |
| Runtime dependencies | **0** |

The proxy path carries no dependencies at all — React, Radix and recharts are dashboard-only,
bundled at build time into three static files. One process, one embedded SQLite database
(`bun:sqlite`), no external services. Request logs flush in 2-second batches; an idle GC pass
runs after 30 seconds without traffic.

> Measured on one machine (Bun 1.4, `--smol`) — run it yourself, your numbers will vary.
> The point isn't the exact figures: there's simply nothing between your client and the provider.

---

## 🌐 Providers

45+ built-ins across free tiers and paid APIs — including OpenRouter, Groq, DeepSeek,
Cerebras, xAI, Mistral, Together, NVIDIA, SiliconFlow, Hyperbolic, Perplexity, Cohere,
z.ai / Zhipu, Baidu, Tencent, MiniMax, Xiaomi MiMo, Vercel AI Gateway, Cloudflare AI,
Alibaba, BytePlus, Volcengine, and specialty bridges like **FreeBuff** (codebuff.com free
tier with automatic CLI-token discovery) and **Command Code**.

Every provider speaks OpenAI chat completions upstream; troy translates whatever the client
speaks. Custom providers take three fields (id, baseUrl, auth mode) and behave like built-ins.

> 📖 [Providers & protocol bridges](docs/PROVIDERS.md) · [Wire protocols](docs/PROTOCOLS.md)

## 🧠 Model intelligence

Discovery comes from each provider's own `/models` endpoint; [models.dev](https://models.dev)
enriches your chosen specs with reasoning/tool-call/modalities flags and real context/output
limits. A seed snapshot ships in the package so a fresh install works offline.
Combos expose the **weakest-member** capability set — no surprise failures mid-chain.

> 📖 [Model catalog](docs/MODELS.md)

## 🗜️ RTK & prompt styles — built in

Coding agents shovel raw `git log`, diffs and grep dumps into context. RTK detects the output
type and compresses it — commit hashes only, hunk-aware diff truncation, per-file grep grouping,
head+tail truncation — before the request leaves your machine. On by default, zero setup.
Savings are logged per request (`rtk_saved` / `rtk_seen`) so the ratio stays honest.

Alongside it, two system-prompt injectors ship in the box (off unless you flip them on):

| Injector | Style | Levels |
|---|---|---|
| **ponytail** | lazy-senior-dev: stdlib-first, shortest diff, no unrequested abstractions | off · lite · full · ultra |
| **caveman** | terse fragments that keep code, paths and errors byte-exact (English or classical-Chinese wenyan) | off · lite · full · ultra (+ wenyan tiers) |

Both ride along inside the same request — RTK shrinks what goes *in*, the injectors shrink
what comes *out*.

> 📖 [RTK & injectors](docs/RTK.md)

## 🤝 OpenCode integration

One POST installs a dependency-free plugin that registers every chosen model *and combo* as
`troy/<model>` inside OpenCode, refreshed every 60 seconds:

```bash
curl -X POST http://localhost:31337/api/install-opencode-plugin
```

---

## 📚 Documentation

| Doc | Contents |
|---|---|
| [ROUTING.md](docs/ROUTING.md) | Combo chains, strategies, account selection, capability preflight |
| [RESILIENCE.md](docs/RESILIENCE.md) | Cooldown classification, backoff math, circuit breakers, restart replay |
| [PROTOCOLS.md](docs/PROTOCOLS.md) | The three inbound APIs and cross-protocol tool-calling translation |
| [PROVIDERS.md](docs/PROVIDERS.md) | Registry, auth modes, custom providers, FreeBuff & Command Code bridges |
| [MODELS.md](docs/MODELS.md) | Discovery vs enrichment layers, seeds, refresh cycle |
| [STREAMING.md](docs/STREAMING.md) | SSE passthrough, idle watchdogs, mid-stream failure handling |
| [RTK.md](docs/RTK.md) | Tool-output filters, prompt injectors (caveman/ponytail), honest accounting |
| [STORAGE.md](docs/STORAGE.md) | SQLite schema, event-sourced cooldown state, retention |
| [AUTH.md](docs/AUTH.md) | API keys, dashboard sessions, password hashing |
| [REFERENCE.md](docs/REFERENCE.md) | Every env var and every HTTP endpoint |

## ⚙️ Configuration

| Env var | Default | Purpose |
|---|---|---|
| `PORT` | `31337` | listen port |
| `TROY_DATA` | `./data` | data dir (SQLite DB lives here) |
| `TROY_TRACE` | off | `1` = routing trace in terminal |
| `TROY_MAX_INFLIGHT` | `10` | preferred concurrent requests per account |
| `TROY_STREAM_IDLE_MS` | `60000` | stream idle watchdog |
| `TROY_UPSTREAM_TIMEOUT_MS` | `300000` | non-stream request ceiling |
| `TROY_ENRICH` | `limits,modalities` | models.dev enrichment layers |

Full reference: [REFERENCE.md](docs/REFERENCE.md)

---

## 🔒 Local-first

Your keys sit in a local SQLite file. Your prompts never leave the loopback interface except
to the provider you chose. No account, no sign-up, no telemetry — lightweight *and* private
by the same design: there is no cloud component to phone home. The dashboard password is
hashed with Argon2id; proxy auth uses constant-time comparison.

## 📄 License

[GPL-3.0-or-later](LICENSE) © Muhammad Zaki
