# Auth

Two trust surfaces, kept separate.

## Proxy auth (the `/v1` API)

- troy generates its own key at first boot: `sk-troy-` + 48 hex chars (24 random bytes),
  persisted in the `kv` table
- While auth is **on**, every `/v1` request must present it via `Authorization: Bearer` or
  `x-api-key`; comparison is constant-time (`safeEqual`)
- Failures return 401 with `www-authenticate: Bearer`
- Toggle off/on and rotate from the dashboard or the API:
  `GET/PUT /api/key`, `POST /api/key/rotate`

## Dashboard auth

- Login with password → cookie session (`troy_session`: HttpOnly, SameSite=Lax, 30-day TTL,
  token = 64 hex chars, in-memory store swept hourly)
- Every `/api/*` route except `session/login/logout` requires login (401 otherwise)
- Default password is `troy123` — shown on the login screen until replaced; the server warns
  on boot while it's still default

### Password hashing

- Stored as an Argon2id hash (`Bun.password.hash`)
- Verification dispatches on hash shape; legacy salted SHA-256 hashes still verify so old
  installs migrate seamlessly
- Change via `POST /api/password` (`{current, next}`, next ≥ 4 chars)

## OpenCode plugin install

`POST /api/install-opencode-plugin` writes a dependency-free plugin to
`~/.config/opencode/plugins/troy.ts` (XDG-aware). The plugin embeds your troy origin + key,
registers chosen models and combos as `troy/<model>`, and refreshes the catalog every 60 s.

## Local-first posture

Keys live only in the local SQLite file. Prompts leave the machine only toward the provider
you picked. No telemetry, no account. CORS preflight echoes origin with methods
GET/POST/PUT/DELETE/OPTIONS and content-type/authorization/x-api-key headers.

Related: [STORAGE.md](STORAGE.md) · [REFERENCE.md](REFERENCE.md)
