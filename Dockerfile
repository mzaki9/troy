# syntax=docker/dockerfile:1

# troy — multi-stage, oven/bun only.
# No native modules to compile: bun:sqlite and Bun.password (argon2id) ship
# inside the Bun binary, and all npm deps are dashboard build-time only
# (bundled into static files). Override with --build-arg BUN_VERSION=...
ARG BUN_VERSION=1.4.0

# ---- build: bundle the dashboard (dashboard/dist is gitignored) ----
FROM oven/bun:${BUN_VERSION} AS build
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile
COPY dashboard/ dashboard/
RUN bun run build

# ---- run: smallest official Bun image, source + prebuilt dashboard ----
FROM oven/bun:${BUN_VERSION}-alpine AS run
WORKDIR /app
ENV NODE_ENV=production PORT=31337 TROY_DATA=/data
# no bun install here: src/ imports only bun:* and node:* builtins
# (all npm deps are dashboard build-time only) — package.json rides along for reference
COPY --chown=bun:bun package.json ./
COPY --chown=bun:bun src/ src/
COPY --chown=bun:bun bin/ bin/
COPY --chown=bun:bun public/ public/
COPY --chown=bun:bun dashboard/index.html dashboard/favicon.svg dashboard/
COPY --chown=bun:bun dashboard/providers/ dashboard/providers/
COPY --chown=bun:bun --from=build /app/dashboard/dist/ dashboard/dist/
RUN mkdir -p /data && chown bun:bun /data
USER bun
VOLUME /data
EXPOSE 31337
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:31337/healthz | grep -q '"ok":true'
# exec form so SIGTERM reaches Bun (graceful shutdown in src/server.ts)
CMD ["bun", "--smol", "src/server.ts"]
