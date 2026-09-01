# Errors

All proxy errors are `{ error: { message, type, code } }`. Dashboard API uses `{ error, detail }`.

## Proxy `/v1/*`

| HTTP | type | code | when |
|---|---|---|---|
| 400 | invalid_request_error | bad_request | `Invalid JSON body` or missing `model` |
| 401 | invalid_request_error | invalid_api_key | missing/invalid `troy` api key (`Authorization: Bearer` or `x-api-key`) |
| 404 | invalid_request_error | bad_request | `Unknown provider: x` or `No active credentials for provider: x` |
| 402 | server_error | bad_gateway | `insufficient balance/quota/billing` — long 120s cooldown, no escalation |
| 429 | server_error | bad_gateway | `rate limit / capacity / overloaded` — exponential 2s*2^(lvl-1) capped 300s ±10% jitter, honors `Retry-After` (0–300s) |
| 401/403 | server_error | bad_gateway | auth 120s cooldown |
| 503 | server_error | bad_gateway | `request not allowed` 5s, other transient 30s; `circuit open — skipping` after 3 fails/60s window (30s open); `preflight: no tools/vision/context` |
| 502 | server_error | bad_gateway | `upstream body exceeds 32MB`, `upstream idle for over 60s`, `upstream buffer exceeds 64MB`, `upstream sent nothing within 60s` (TTFB) |
| 503 + `retry-after` | — | — | `chain exhausted` — earliest `retry-after` seconds until any account unlocks |

`Retry-After` header is server-parsed (`seconds` or `HTTP-date`) and wins over local backoff when 0<ms≤300s (`src/proxy/cooldown.ts:149`).

## Dashboard `/api/*`

| HTTP | when |
|---|---|
| 401 | `login required` (no `troy_session` cookie), `wrong dashboard password` |
| 429 | `too many login attempts, try again in 60s` — 5/min/IP (`src/app.ts:342`), `Retry-After: 60` |
| 400 | `id must be 1-32 chars`, `baseUrl must start with http(s)://`, `private address blocked` (10/172.16/192.168/169.254/fc00), `need provider + api_key`, `need name + models[]`, `combo model must be provider/model`, `unknown provider` |
| 403 | `current password is wrong` |
| 404 | `unknown provider`, `unknown custom provider`, `unknown connection`, `not found` |
| 400 | `Invalid JSON body` or `t.length > 1MB` (`/api`) / `4MB` (`/v1` with images) |

FreeBuff specifics (`src/providers/freebuff.ts:346`): `session_superseded` → invalidate + 409, `session_limit_reached`, `account banned` (with `resumes_at`), `waiting room required` 428, `ip capped` 429, `capacity deferred` 503 (+10s).

Health: `GET /healthz` and `GET /api/healthz` always 200 `{ ok: true }` no-auth.

See `src/proxy/stream.ts:42` for `cache-control: no-cache`, `connection: keep-alive`, `x-accel-buffering: no` on streams; `STREAM_BUF_CAP` 64MB (`STREAM_SCANNER_MAX_BUFFER_MB`).
