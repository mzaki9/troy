# Reference

## Environment variables

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `31337` | listen port |
| `TROY_DATA` | `./data` | data dir holding `troy.db` |
| `TROY_TRACE` | off | `1` = per-request routing trace in terminal |
| `TROY_MAX_INFLIGHT` | `10` | preferred concurrent in-flight requests per account before load-spreading kicks in |
| `TROY_STREAM_IDLE_MS` | `60000` (min 1000) | TTFB guard + stream idle watchdog |
| `TROY_UPSTREAM_TIMEOUT_MS` | `300000` (min 1000) | non-stream request ceiling |
| `STREAM_SCANNER_MAX_BUFFER_MB` | `64` | per-line SSE buf cap (new-api parity, before OOM) |
| `TROY_CORS_ORIGINS` | `url.origin` | extra allowed `Origin` for dashboard (`*` otherwise) |
| `TROY_ENRICH` | `limits,modalities` | models.dev enrichment layers; `""` disables |

In Docker (`docker-compose.yml`) `TROY_DATA` is `/data` (named volume `troy-data`); every other
var passes through unchanged via `environment:` / `docker run -e`.

## Proxy endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/chat/completions` | OpenAI Chat Completions (native) |
| POST | `/v1/messages` | Anthropic Messages bridge |
| POST | `/v1/responses` | OpenAI Responses bridge (Codex CLI) |
| GET | `/v1/models` | combos (pseudo-models) + saved specs + connected providers |
| GET | `/v1/models/<spec>` | single model entry |
| GET | `/healthz` · `/api/healthz` | health check no-auth `{ ok: true }` |

All accept the troy key via `Authorization: Bearer` or `x-api-key` (except `/healthz`).

```bash
# chat completions (stream)
curl -s http://localhost:31337/v1/chat/completions \
  -H "Authorization: Bearer sk-troy-..." -H "content-type: application/json" \
  -d '{"model":"openai/gpt-4o","messages":[{"role":"user","content":"hi"}],"stream":true}'

# anthropic bridge
curl -s http://localhost:31337/v1/messages \
  -H "Authorization: Bearer sk-troy-..." -H "content-type: application/json" \
  -d '{"model":"openai/gpt-4o","messages":[{"role":"user","content":"hi"}]}'

# health
curl -s http://localhost:31337/healthz
```

## Dashboard API (`/api/*`, session login required)

### Sessions & keys

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/session` | session check |
| POST | `/api/login` · `/api/logout` | dashboard auth |
| GET / PUT | `/api/key` | proxy key on/off + reveal |
| POST | `/api/key/rotate` | new key |
| POST | `/api/password` | change dashboard password `{current, next}` |

### Providers & connections

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/providers` | full catalog (connected/chosen counts, aliases, placeholders) |
| GET | `/api/providers/<id>/models` | live model probe (15 s timeout, thinking flags, 502 passthrough) |
| GET / POST | `/api/custom-providers` | list / add custom provider |
| DELETE | `/api/custom-providers/<id>` | remove (and its connections) |
| GET / POST | `/api/connections` | list / add accounts |
| PUT / DELETE | `/api/connections/<id>` | update / delete account |

### Models, combos, settings

| Method | Path | Purpose |
|---|---|---|
| GET / POST | `/api/models` | saved specs |
| DELETE | `/api/models/<spec>` | unsave |
| GET / POST | `/api/combos` | list / upsert combo (validates specs + strategy) |
| DELETE | `/api/combos/<name>` | remove combo |
| GET / PUT | `/api/settings` | rtk_on, caveman_level, ponytail_level, strategy |
| GET | `/api/modelsdev/status` | enrichment sync state + layer hit counters |
| POST | `/api/install-opencode-plugin` | write the OpenCode plugin (`~/.config/opencode/plugins/troy.ts`) |
| POST | `/api/install-dsh-plugin` | write the DeepSeek Harness plugin (`~/.dsh/plugins/troy-dsh.ts`) |
| POST | `/api/install-omp-plugin` | write the Oh My Pi extension (`~/.omp/agent/extensions/troy.ts`) |
| POST | `/api/clear-omp-plugin` | remove the Oh My Pi extension |
| POST | `/api/clear-dsh-plugin` | remove the DeepSeek Harness plugin |
### Observability

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/stats` | totals + by-provider/by-model (requests, ok, avg/p95 latency, tokens, RTK) |
| GET | `/api/stats/daily?days=N` | daily buckets, 1–30 days (default 7) |
| GET | `/api/logs?limit=N` | recent request logs (default 50, max 500) |

## Static routes

`/` (dashboard), `/app.js`, `/styles.css`, `/favicon.svg`, `/providers/*`, `/assets/*`.

Related: [AUTH.md](AUTH.md) · [CLI.md](CLI.md) · [ERRORS.md](ERRORS.md) · [STORAGE.md](STORAGE.md)
