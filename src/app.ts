import type { Server } from "bun";
import {
  DEFAULT_DASHBOARD_PASS,
  extractApiKey,
  generateApiKey,
  hashPassword,
  newSessionToken,
  safeEqual,
  verifyPassword,
} from "./dash/auth";
import { modelsList, providerCatalog, stats } from "./dash/stats";
import { clearDshPlugin, installDshPlugin } from "./dsh-plugin";
import { assertPublicUrl } from "./lib/net";
import { cLog, httpLog, trace as logTrace, panic, TAG } from "./logger";
import { enrich, enrichmentStatus } from "./modelsdev";
import { clearOmpPlugin, installOmpPlugin } from "./omp-plugin";
import { installOpenCodePlugin } from "./opencode-plugin";
import { handleMessages } from "./providers/anthropic";
import { discoverFreebuffToken, getFreebuffSessions, pauseFreebuff } from "./providers/freebuff";
import { handleResponses } from "./providers/responses";
import type { CooldownStore } from "./proxy/cooldown";
import { FixedWindowLimiter, parseRateLimit } from "./proxy/rateLimit";
import {
  customProviderIds,
  getProvider,
  type Provider,
  registerCustomProvider,
  unregisterCustomProvider,
} from "./proxy/registry";
import {
  authHeaders,
  buildBaseUrl,
  type ChatDeps,
  COMBO_STRATEGIES,
  extractOpencodeSession,
  handleChat,
} from "./proxy/route";
import type { ApiAuth, DashPass, Store } from "./store/db";

// ponytail: in-memory only; add persistent SQLite cache when multi-instance
const PROVIDER_MODELS_TTL_MS = Number(process.env.PROVIDER_MODELS_TTL_MS ?? 300_000);
const PROVIDER_MODELS_CACHE_MAX = 100;
const providerModelsCache = new Map<
  string,
  { at: number; url: string; payload: { url: string; models: { id: string; name: string; thinking: boolean }[] } }
>();

export interface BuildOptions {
  store: Store;
  cooldowns: CooldownStore;
  port?: number;
  trace?: boolean;
  // when false, don't start background timers / models.dev refresh / GC
  enableBackgroundTasks?: boolean;
}

export interface TroyServer {
  server: Server<undefined>;
  store: Store;
  cooldowns: CooldownStore;
  url: string;
  getApiAuth: () => ApiAuth;
  getDashPass: () => DashPass | null;
  shutdown: () => void;
}

const SESSION_COOKIE = "troy_session";
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;

function readCookies(request: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    try {
      out[key] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      /* malformed cookie — skip */
    }
  }
  return out;
}

function setSessionCookie(token: string, secure = false): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure ? "; Secure" : ""}`;
}

function json(data: unknown, status = 200, extra?: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...extra },
  });
}

const BODY_LIMIT_API = 1 << 20; // 1MB for /api
const BODY_LIMIT_PROXY = 4 << 20; // 4MB for /v1 (images)

function readBody(request: Request): Promise<unknown> {
  const len = Number(request.headers.get("content-length") ?? 0);
  const isProxy = new URL(request.url).pathname.startsWith("/v1/");
  const limit = isProxy ? BODY_LIMIT_PROXY : BODY_LIMIT_API;
  if (len > limit) return Promise.resolve(null);
  if (request.signal?.aborted) return Promise.resolve(null);
  // use text() but handle abort explicitly — ensure reader cancel on abort
  return request.text().then(
    (t) => {
      if (t.length > limit) return null;
      try {
        return JSON.parse(t);
      } catch {
        return null;
      }
    },
    (err) => {
      if (err instanceof Error && (err.name === "AbortError" || request.signal?.aborted)) {
        try {
          const r = request.body?.getReader();
          r?.cancel().catch(() => {});
        } catch {}
        return null;
      }
      throw err;
    },
  );
}

function isV1Path(path: string, method: string): boolean {
  if (method === "POST") {
    return path === "/v1/chat/completions" || path === "/v1/messages" || path === "/v1/responses";
  }
  if (method === "GET") {
    return path === "/v1/models" || path.startsWith("/v1/models/");
  }
  return false;
}

function cors(request: Request, url?: URL): Response {
  let origin = request.headers.get("origin") ?? "*";
  if (url && origin !== "*") {
    try {
      const allowed = new Set<string>([url.origin]);
      const extra = process.env.TROY_CORS_ORIGINS;
      if (extra) for (const o of extra.split(",")) if (o.trim()) allowed.add(o.trim());
      if (!allowed.has(origin)) origin = url.origin;
    } catch {
      origin = url.origin;
    }
  }
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
      "access-control-allow-headers":
        "content-type,authorization,x-api-key,x-opencode-session,x-session-affinity,x-session-id,x-request-id",
      "access-control-max-age": "86400",
    },
  });
}

export function buildTroyServer(opts: BuildOptions): TroyServer {
  const { store, cooldowns, port = 0, trace: traceEnabled = false, enableBackgroundTasks = true } = opts;

  const trace = (line: string) => logTrace(TAG.PROXY, line);

  // load user-defined providers into the registry
  for (const p of store.listCustomProviders()) {
    registerCustomProvider(p as unknown as Provider);
  }

  // troy's own api key — generate once, persist it
  let apiAuth: ApiAuth = store.getApiAuth();
  if (!apiAuth.key) {
    apiAuth.key = generateApiKey();
    store.putApiAuth(apiAuth);
  }

  let dashPass: DashPass | null = store.getDashPass();

  async function checkDashboardPassword(pw: unknown): Promise<boolean> {
    if (typeof pw !== "string" || !pw) return false;
    return dashPass ? verifyPassword(pw, dashPass.salt, dashPass.hash) : safeEqual(pw, DEFAULT_DASHBOARD_PASS);
  }

  const sessions = new Map<string, number>();
  let sessionSweep: ReturnType<typeof setInterval> | null = null;
  if (enableBackgroundTasks) {
    sessionSweep = setInterval(() => {
      try {
        const now = Date.now();
        for (const [token, exp] of sessions) if (exp < now) sessions.delete(token);
      } catch (err) {
        panic(TAG.AUTH, "sessionSweep panic", err);
      }
    }, 3_600_000);
    sessionSweep.unref?.();
  }

  // login rate limiter: 5/min/IP
  const loginAttempts = new Map<string, { count: number; first: number; blockedUntil?: number }>();
  function clientIp(req: Request): string {
    // ponytail: add server.requestIP when Bun server handle available; trust-proxy gate prevents spoof
    const trustProxy = process.env.TROY_TRUST_PROXY === "1";
    if (trustProxy) {
      const fwd = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
      if (fwd) return fwd;
    }
    return req.headers.get("x-real-ip")?.trim() || "127.0.0.1";
  }
  function isLoginAllowed(ip: string): boolean {
    const now = Date.now();
    const rec = loginAttempts.get(ip);
    if (!rec) return true;
    if (rec.blockedUntil && rec.blockedUntil > now) return false;
    if (rec.blockedUntil && rec.blockedUntil <= now) {
      loginAttempts.delete(ip);
      return true;
    }
    if (now - rec.first > 60_000) {
      loginAttempts.delete(ip);
      return true;
    }
    return rec.count < 5;
  }
  function noteLoginAttempt(ip: string, success: boolean): void {
    const now = Date.now();
    if (success) {
      loginAttempts.delete(ip);
      return;
    }
    const rec = loginAttempts.get(ip);
    if (!rec || now - rec.first > 60_000) {
      loginAttempts.set(ip, { count: 1, first: now });
      return;
    }
    rec.count += 1;
    if (rec.count >= 5) rec.blockedUntil = now + 60_000;
  }
  function allowedOrigin(req: Request, url: URL): string {
    const origin = req.headers.get("origin");
    if (!origin) return "*";
    try {
      const allowed = new Set<string>([url.origin]);
      const extra = process.env.TROY_CORS_ORIGINS;
      if (extra) for (const o of extra.split(",")) if (o.trim()) allowed.add(o.trim());
      return allowed.has(origin) ? origin : url.origin;
    } catch {
      return url.origin;
    }
  }

  function authed(request: Request): boolean {
    const token = readCookies(request)[SESSION_COOKIE];
    if (!token) return false;
    const exp = sessions.get(token);
    if (exp === undefined) return false;
    if (exp < Date.now()) {
      sessions.delete(token);
      return false;
    }
    return true;
  }

  function loadSettings() {
    return store.getSettings();
  }
  let settings = loadSettings();

  function refreshSettings() {
    settings = loadSettings();
  }

  // global rate limiter: per-IP for /v1/*  (Step 5)
  const globalLimiter = (() => {
    const parsed = parseRateLimit(process.env.TROY_RATE_LIMIT, "60/60s");
    if (!parsed) return null;
    try {
      return new FixedWindowLimiter(parsed.max, parsed.windowMs);
    } catch {
      return null;
    }
  })();
  const modelLimiter = (() => {
    const raw = process.env.TROY_MODEL_RATE_LIMIT;
    if (!raw) return null;
    const parsed = parseRateLimit(raw, "");
    if (!parsed) return null;
    try {
      return new FixedWindowLimiter(parsed.max, parsed.windowMs);
    } catch {
      return null;
    }
  })();

  function buildDeps(request: Request, requestId?: string): ChatDeps {
    return {
      store,
      cooldowns,
      strategy: settings.strategy,
      rtkOn: settings.rtk_on === 1,
      cavemanLevel: settings.caveman_level,
      ponytailLevel: settings.ponytail_level,
      signal: request.signal,
      requestId: requestId ?? "",
      opencodeSession: extractOpencodeSession(request),
      onLog: (row) => store.logRequest(row),
      onTrace: traceEnabled ? trace : undefined,
    };
  }

  function proxyRequest(
    handle: (body: Record<string, unknown>, deps: ChatDeps) => Promise<Response>,
    invalidBody: (requestId: string) => Response,
  ) {
    return async (
      request: Request,
      server: { timeout: (req: Request, ms: number) => void },
      requestId: string,
    ): Promise<Response> => {
      const body = await readBody(request);
      if (!body) return invalidBody(requestId);
      if (modelLimiter && typeof (body as Record<string, unknown>).model === "string") {
        const model = String((body as Record<string, unknown>).model);
        const { allowed, retryAfterMs } = modelLimiter.take(model);
        if (!allowed) {
          const retryAfterSec = Math.max(1, Math.ceil(retryAfterMs / 1000));
          return json({ error: { message: "rate limit exceeded", type: "server_error", code: "rate_limited" } }, 429, {
            "retry-after": String(retryAfterSec),
            "x-request-id": requestId,
          });
        }
      }
      const res = await handle(body as Record<string, unknown>, buildDeps(request, requestId));
      if (res.body) server.timeout(request, 0);
      try {
        res.headers.set("x-request-id", requestId);
      } catch {}
      return res;
    };
  }

  const openaiInvalidBody = (requestId: string) =>
    json({ error: { message: "Invalid JSON body", type: "invalid_request_error", code: "bad_request" } }, 400, {
      "x-request-id": requestId,
    });
  const anthropicInvalidBody = (requestId: string) =>
    json({ type: "error", error: { type: "invalid_request_error", message: "Invalid JSON body" } }, 400, {
      "x-request-id": requestId,
    });

  const handleChatRequest = proxyRequest(handleChat, openaiInvalidBody);
  const handleMessagesRequest = proxyRequest(handleMessages, anthropicInvalidBody);
  const handleResponsesRequest = proxyRequest(handleResponses, openaiInvalidBody);

  let lastActivity = Date.now();
  let gcTimer: ReturnType<typeof setInterval> | null = null;
  if (enableBackgroundTasks) {
    gcTimer = setInterval(() => {
      try {
        if (Date.now() - lastActivity > 30_000) Bun.gc(true);
      } catch (err) {
        panic(TAG.SYSTEM, "gc panic", err);
      }
    }, 60_000);
    gcTimer.unref?.();
  }

  // Bun 1.4 `{ dir }` route value — requires @types/bun >=1.4.
  const staticRoutes: Record<string, unknown> = enableBackgroundTasks
    ? {
        "/": Bun.file(`${import.meta.dir}/../dashboard/index.html`),
        "/app.js": Bun.file(`${import.meta.dir}/../dashboard/dist/app.js`),
        "/styles.css": Bun.file(`${import.meta.dir}/../dashboard/dist/styles.css`),
        "/favicon.svg": Bun.file(`${import.meta.dir}/../dashboard/favicon.svg`),
        "/providers/*": { dir: `${import.meta.dir}/../dashboard/providers` } as never,
        "/assets/*": { dir: `${import.meta.dir}/../public/assets` } as never,
      }
    : {};

  const server: Server<undefined> = Bun.serve({
    port,
    routes: staticRoutes as never,
    async fetch(request): Promise<Response> {
      const start = Date.now();
      let requestId: string;
      try {
        const incoming = request.headers.get("x-request-id")?.trim();
        requestId = incoming || crypto.randomUUID();
        if (!requestId) throw new Error("empty");
      } catch {
        requestId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      }
      const withId = (res: Response): Response => {
        try {
          const h = new Headers(res.headers);
          h.set("x-request-id", requestId);
          return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
        } catch {
          return res;
        }
      };
      const logStructured = (status: number, error?: string) =>
        httpLog({
          requestId,
          status,
          latency: Date.now() - start,
          ip: clientIp(request),
          method: request.method,
          path: new URL(request.url).pathname,
          ...(error ? { error } : {}),
        });
      // early body limit check without reading (Step 6)
      const clen = Number(request.headers.get("content-length") ?? 0);
      const isProxy = request.url.includes("/v1/");
      const limit = isProxy ? BODY_LIMIT_PROXY : BODY_LIMIT_API;
      if (clen > limit) {
        const res = json(
          {
            error: {
              message: `body too large — limit ${limit} bytes`,
              type: "invalid_request_error",
              code: "bad_request",
            },
          },
          413,
          { "x-request-id": requestId },
        );
        logStructured(413, "body too large");
        return res;
      }
      try {
        lastActivity = Date.now();
        const url = new URL(request.url);
        const path = url.pathname;

        if (request.method === "OPTIONS") {
          const res = cors(request, url);
          const out = withId(res);
          logStructured(out.status);
          return out;
        }

        if ((path === "/healthz" || path === "/api/healthz" || path === "/api/health") && request.method === "GET") {
          const res = json({ ok: true, ts: new Date().toISOString() }, 200, { "x-request-id": requestId });
          logStructured(200);
          return res;
        }

        // ---- dashboard password gate ----
        if (path === "/api/session" && request.method === "GET") {
          const res = json({ authed: authed(request), defaultPass: !dashPass }, 200, { "x-request-id": requestId });
          logStructured(res.status);
          return withId(res);
        }
        if (path === "/api/login" && request.method === "POST") {
          const ip = clientIp(request);
          if (!isLoginAllowed(ip)) {
            const res = json({ error: "too many login attempts, try again in 60s" }, 429, {
              "retry-after": "60",
              "x-request-id": requestId,
            });
            logStructured(429, "rate limited");
            return res;
          }
          const b = await readBody(request);
          const body = b as { password?: string } | null;
          if (!(await checkDashboardPassword(body?.password))) {
            noteLoginAttempt(ip, false);
            const res = json({ error: "wrong dashboard password" }, 401, { "x-request-id": requestId });
            logStructured(401, "wrong password");
            return res;
          }
          noteLoginAttempt(ip, true);
          const token = newSessionToken();
          sessions.set(token, Date.now() + SESSION_TTL_MS);
          const secure = url.protocol === "https:";
          const res = new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: {
              "content-type": "application/json",
              "access-control-allow-origin": allowedOrigin(request, url),
              "set-cookie": setSessionCookie(token, secure),
              "x-request-id": requestId,
            },
          });
          logStructured(200);
          return res;
        }
        if (path === "/api/logout" && request.method === "POST") {
          const token = readCookies(request)[SESSION_COOKIE];
          if (token) sessions.delete(token);
          const res = new Response(JSON.stringify({ ok: true }), {
            headers: {
              "content-type": "application/json",
              "access-control-allow-origin": allowedOrigin(request, url),
              "set-cookie": `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`,
              "x-request-id": requestId,
            },
          });
          logStructured(200);
          return res;
        }
        function hasValidApiKey(req: Request): boolean {
          if (apiAuth.on !== 1) return false;
          const g = extractApiKey(req);
          return !!g && safeEqual(g, apiAuth.key);
        }
        function isPublic(p: string, m: string): boolean {
          return (
            (m === "GET" &&
              (p === "/healthz" || p === "/api/healthz" || p === "/api/health" || p === "/api/session")) ||
            (m === "POST" && (p === "/api/login" || p === "/api/logout"))
          );
        }
        function isReadOnlyModel(p: string, m: string): boolean {
          return (
            m === "GET" &&
            (p === "/api/models" ||
              p === "/v1/models" ||
              p.startsWith("/v1/models/") ||
              p === "/api/providers" ||
              p === "/api/modelsdev/status" ||
              (p.startsWith("/api/providers/") && p.endsWith("/models")))
          );
        }
        if (path.startsWith("/api/") && !isPublic(path, request.method)) {
          if (isReadOnlyModel(path, request.method)) {
            if (!authed(request) && !hasValidApiKey(request)) {
              logStructured(401, "login required");
              return withId(json({ error: "login required" }, 401, { "x-request-id": requestId }));
            }
          } else {
            if (!authed(request)) {
              logStructured(401, "login required");
              return withId(json({ error: "login required" }, 401, { "x-request-id": requestId }));
            }
          }
        }

        // global per-IP rate limiter for /v1/* (Step 5)
        if (isV1Path(path, request.method) && globalLimiter) {
          const ip = clientIp(request);
          const isLocal = ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
          const bypass = process.env.TROY_RATE_LIMIT_LOCAL_BYPASS === "1";
          if (!(isLocal && bypass)) {
            const { allowed, retryAfterMs } = globalLimiter.take(ip);
            if (!allowed) {
              const retryAfterSec = Math.max(1, Math.ceil(retryAfterMs / 1000));
              const res = json(
                { error: { message: "rate limit exceeded", type: "server_error", code: "rate_limited" } },
                429,
                { "retry-after": String(retryAfterSec), "x-request-id": requestId },
              );
              logStructured(429, "rate limited");
              return res;
            }
          }
        }

        // troy's own api key — /v1 needs key OR session when auth is on
        if (isV1Path(path, request.method) && apiAuth.on === 1 && !hasValidApiKey(request) && !authed(request)) {
          const res = json(
            {
              error: {
                message: "missing or invalid troy api key — send Authorization: Bearer <key> or x-api-key",
                type: "invalid_request_error",
                code: "invalid_api_key",
              },
            },
            401,
            { "www-authenticate": "Bearer", "x-request-id": requestId },
          );
          logStructured(401, "invalid api key");
          return res;
        }

        if (path === "/api/install-opencode-plugin" && request.method === "POST") {
          try {
            const res = json(
              installOpenCodePlugin({
                baseUrl: url.origin,
                apiKey: apiAuth.on === 1 ? apiAuth.key : "",
              }),
              200,
              { "x-request-id": requestId },
            );
            logStructured(200);
            return res;
          } catch (e) {
            const res = json({ error: e instanceof Error ? e.message : "install failed" }, 500, {
              "x-request-id": requestId,
            });
            logStructured(500, e instanceof Error ? e.message : String(e));
            return res;
          }
        }

        if (path === "/api/install-dsh-plugin" && request.method === "POST") {
          try {
            const res = json(
              installDshPlugin({
                baseUrl: url.origin,
                apiKey: apiAuth.on === 1 ? apiAuth.key : "",
              }),
              200,
              { "x-request-id": requestId },
            );
            logStructured(200);
            return res;
          } catch (e) {
            const res = json({ error: e instanceof Error ? e.message : "install failed" }, 500, {
              "x-request-id": requestId,
            });
            logStructured(500, e instanceof Error ? e.message : String(e));
            return res;
          }
        }
        if (path === "/api/clear-dsh-plugin" && request.method === "POST") {
          try {
            const res = json(clearDshPlugin(), 200, { "x-request-id": requestId });
            logStructured(200);
            return res;
          } catch (e) {
            const res = json({ error: e instanceof Error ? e.message : "clear failed" }, 500, {
              "x-request-id": requestId,
            });
            logStructured(500, e instanceof Error ? e.message : String(e));
            return res;
          }
        }

        if (path === "/api/install-omp-plugin" && request.method === "POST") {
          try {
            const res = json(
              installOmpPlugin({
                baseUrl: url.origin,
                apiKey: apiAuth.on === 1 ? apiAuth.key : "",
              }),
              200,
              { "x-request-id": requestId },
            );
            logStructured(200);
            return res;
          } catch (e) {
            const res = json({ error: e instanceof Error ? e.message : "install failed" }, 500, {
              "x-request-id": requestId,
            });
            logStructured(500, e instanceof Error ? e.message : String(e));
            return res;
          }
        }

        if (path === "/api/clear-omp-plugin" && request.method === "POST") {
          try {
            const res = json(clearOmpPlugin(), 200, { "x-request-id": requestId });
            logStructured(200);
            return res;
          } catch (e) {
            const res = json({ error: e instanceof Error ? e.message : "clear failed" }, 500, {
              "x-request-id": requestId,
            });
            logStructured(500, e instanceof Error ? e.message : String(e));
            return res;
          }
        }

        if (path === "/api/key") {
          if (request.method === "GET") {
            const res = json({ key: apiAuth.key, on: apiAuth.on === 1 }, 200, { "x-request-id": requestId });
            logStructured(200);
            return res;
          }
          if (request.method === "PUT") {
            const b = await readBody(request);
            const body = b as { on?: boolean } | null;
            if (body && typeof body.on === "boolean") {
              apiAuth = { ...apiAuth, on: body.on ? 1 : 0 };
              store.putApiAuth(apiAuth);
            }
            const res = json({ key: apiAuth.key, on: apiAuth.on === 1 }, 200, { "x-request-id": requestId });
            logStructured(200);
            return res;
          }
        }
        if (path === "/api/key/rotate" && request.method === "POST") {
          apiAuth = { ...apiAuth, key: generateApiKey() };
          store.putApiAuth(apiAuth);
          const res = json({ key: apiAuth.key, on: apiAuth.on === 1 }, 200, { "x-request-id": requestId });
          logStructured(200);
          return res;
        }

        if (
          request.method === "POST" &&
          (path === "/v1/chat/completions" || path === "/v1/messages" || path === "/v1/responses")
        ) {
          let res: Response;
          if (path === "/v1/responses") res = await handleResponsesRequest(request, server as never, requestId);
          else if (path === "/v1/messages") res = await handleMessagesRequest(request, server as never, requestId);
          else res = await handleChatRequest(request, server as never, requestId);
          logStructured(res.status);
          return res;
        }

        if (request.method === "GET" && (path === "/v1/models" || path.startsWith("/v1/models/"))) {
          const res = json({ object: "list", data: modelsList(store) }, 200, { "x-request-id": requestId });
          logStructured(200);
          return res;
        }

        if (request.method === "GET" && path === "/api/stats/daily") {
          const days = Math.min(30, Math.max(1, Number(url.searchParams.get("days") ?? 7)));
          const res = json(store.statsDaily(days), 200, { "x-request-id": requestId });
          logStructured(200);
          return res;
        }

        if (request.method === "GET" && path === "/api/stats") {
          const res = json(stats(store), 200, { "x-request-id": requestId });
          logStructured(200);
          return res;
        }

        if (request.method === "GET" && path === "/api/providers") {
          const res = json(providerCatalog(store), 200, { "x-request-id": requestId });
          logStructured(200);
          return res;
        }

        if (request.method === "GET" && path === "/api/providers/freebuff/cli-token") {
          const res = json({ token: discoverFreebuffToken() }, 200, { "x-request-id": requestId });
          logStructured(200);
          return res;
        }

        if (request.method === "GET" && path === "/api/providers/freebuff/sessions") {
          const res = json({ sessions: getFreebuffSessions() }, 200, { "x-request-id": requestId });
          logStructured(200);
          return res;
        }

        if ((request.method === "POST" || request.method === "DELETE") && path === "/api/providers/freebuff/pause") {
          const b = await readBody(request);
          const body = (b as { connId?: string; model?: string } | null) ?? {};
          const qConn = url.searchParams.get("connId") ?? undefined;
          const qModel = url.searchParams.get("model") ?? undefined;
          const connId = body.connId ?? qConn;
          const model = body.model ?? qModel;
          const paused = await pauseFreebuff(connId, model);
          const res = json({ paused }, 200, { "x-request-id": requestId });
          logStructured(200);
          return res;
        }
        // legacy: DELETE session directly
        if (request.method === "DELETE" && path === "/api/providers/freebuff/session") {
          const b = await readBody(request);
          const body = (b as { connId?: string; model?: string } | null) ?? {};
          const paused = await pauseFreebuff(body.connId, body.model);
          const res = json({ paused }, 200, { "x-request-id": requestId });
          logStructured(200);
          return res;
        }

        if (request.method === "GET" && path.startsWith("/api/providers/") && path.endsWith("/models")) {
          const id = decodeURIComponent(path.slice("/api/providers/".length, -"/models".length));
          const def = getProvider(id);
          if (!def) {
            const res = json({ error: "unknown provider" }, 404, { "x-request-id": requestId });
            logStructured(404, "unknown provider");
            return res;
          }
          const conn = store.listConnections(id).find((c) => c.is_active === 1) ?? null;
          const headers = conn ? authHeaders(def, conn) : {};
          const base = conn ? buildBaseUrl(def, conn) : def.baseUrl;
          if (def.staticModels) {
            const res = json(
              {
                url: "static",
                models: def.staticModels.map((mid) => ({ id: mid, name: mid, thinking: enrich(mid).reasoning })),
              },
              200,
              { "x-request-id": requestId },
            );
            logStructured(200);
            return res;
          }
          const modelsUrl =
            def.modelsUrl ??
            (base.endsWith("/chat/completions") ? base.replace(/\/chat\/completions$/, "/models") : `${base}/models`);
          if (!conn && def.auth !== "none") {
            const res = json({ error: "no key", url: modelsUrl, models: [] }, 502, { "x-request-id": requestId });
            logStructured(502, "no key");
            return res;
          }
          try {
            assertPublicUrl(modelsUrl);
          } catch (e) {
            const res = json(
              { error: e instanceof Error ? e.message : "blocked private address", url: modelsUrl, models: [] },
              400,
              {
                "x-request-id": requestId,
              },
            );
            logStructured(400, "blocked private address");
            return res;
          }
          const cacheKey = `${id}|${modelsUrl}`;
          const cached = providerModelsCache.get(cacheKey);
          if (cached && Date.now() - cached.at < PROVIDER_MODELS_TTL_MS) {
            logTrace(TAG.PROVIDER, `cache hit ${id}`);
            const res = json(cached.payload, 200, { "x-request-id": requestId, "x-cache": "hit" });
            logStructured(200);
            return res;
          }
          try {
            const upstreamRes = await fetch(modelsUrl, {
              headers,
              signal: AbortSignal.timeout(15000),
              redirect: "manual",
            });
            if (!upstreamRes.ok) {
              if (cached) {
                cLog(TAG.PROVIDER, {
                  msg: "stale cache fallback",
                  provider: id,
                  error: `upstream ${upstreamRes.status}`,
                });
                const res = json(cached.payload, 200, { "x-request-id": requestId, "x-cache": "stale" });
                logStructured(200);
                return res;
              }
              const text = await upstreamRes.text().catch(() => "");
              let detail: string | undefined;
              try {
                const j = JSON.parse(text) as { error?: { message?: string } };
                const msg = j?.error?.message;
                if (typeof msg === "string" && msg.trim()) detail = msg.trim().slice(0, 200);
              } catch {
                /* non-JSON upstream body */
              }
              const res = json({ error: `upstream ${upstreamRes.status}`, detail, url: modelsUrl, models: [] }, 502, {
                "x-request-id": requestId,
              });
              logStructured(502, `upstream ${upstreamRes.status}`);
              return res;
            }
            const data = (await upstreamRes.json()) as { data?: { id: string; name?: string }[] };
            const payload = {
              url: modelsUrl,
              models: (data.data ?? []).map((m) => ({
                id: m.id,
                name: m.name ?? m.id,
                thinking: enrich(m.id).reasoning,
              })),
            };
            providerModelsCache.set(cacheKey, { at: Date.now(), url: modelsUrl, payload });
            if (providerModelsCache.size > PROVIDER_MODELS_CACHE_MAX) {
              const first = providerModelsCache.keys().next().value;
              if (first) providerModelsCache.delete(first);
            }
            const res = json(payload, 200, { "x-request-id": requestId });
            logStructured(200);
            return res;
          } catch (e: unknown) {
            if (cached) {
              cLog(TAG.PROVIDER, {
                msg: "stale cache fallback",
                provider: id,
                error: e instanceof Error ? e.message : String(e),
              });
              const res = json(cached.payload, 200, { "x-request-id": requestId, "x-cache": "stale" });
              logStructured(200);
              return res;
            }
            const res = json({ error: e instanceof Error ? e.message : String(e), url: modelsUrl, models: [] }, 502, {
              "x-request-id": requestId,
            });
            logStructured(502, e instanceof Error ? e.message : String(e));
            return res;
          }
        }

        if (path === "/api/models") {
          if (request.method === "GET") {
            const res = json(
              store.listModels().map((m) => ({ ...m, thinking: enrich(m.spec).reasoning })),
              200,
              {
                "x-request-id": requestId,
              },
            );
            logStructured(200);
            return res;
          }
          if (request.method === "POST") {
            const b = await readBody(request);
            const body = b as { provider?: string; model?: string } | null;
            const provider = body?.provider ?? "";
            const model = body?.model?.trim() ?? "";
            if (!getProvider(provider)) {
              const res = json({ error: `unknown provider: ${provider}` }, 400, { "x-request-id": requestId });
              logStructured(400, "unknown provider");
              return res;
            }
            if (!model) {
              const res = json({ error: "model id required" }, 400, { "x-request-id": requestId });
              logStructured(400, "model id required");
              return res;
            }
            const m = store.putModel(`${provider}/${model}`);
            const res = json({ ...m, thinking: enrich(m.spec).reasoning }, 200, { "x-request-id": requestId });
            logStructured(200);
            return res;
          }
        }
        if (path.startsWith("/api/models/") && request.method === "DELETE") {
          store.deleteModel(decodeURIComponent(path.slice("/api/models/".length)));
          const res = json({ ok: true }, 200, { "x-request-id": requestId });
          logStructured(200);
          return res;
        }

        if (path === "/api/modelsdev/status" && request.method === "GET") {
          const res = json(enrichmentStatus(), 200, { "x-request-id": requestId });
          logStructured(200);
          return res;
        }

        if (path === "/api/settings") {
          if (request.method === "GET") {
            const res = json(settings, 200, { "x-request-id": requestId });
            logStructured(200);
            return res;
          }
          if (request.method === "PUT") {
            const b = await readBody(request);
            if (!b) {
              const res = json({ error: "bad body" }, 400, { "x-request-id": requestId });
              logStructured(400, "bad body");
              return res;
            }
            store.putSettings(b as never);
            refreshSettings();
            const res = json(settings, 200, { "x-request-id": requestId });
            logStructured(200);
            return res;
          }
        }

        if (path === "/api/password" && request.method === "POST") {
          const b = await readBody(request);
          const body = b as { current?: string; next?: string } | null;
          if (!(await checkDashboardPassword(body?.current))) {
            const res = json({ error: "current password is wrong" }, 403, { "x-request-id": requestId });
            logStructured(403, "wrong password");
            return res;
          }
          const next = body?.next;
          if (typeof next !== "string" || next.length < 4) {
            const res = json({ error: "new password must be at least 4 characters" }, 400, {
              "x-request-id": requestId,
            });
            logStructured(400, "new password too short");
            return res;
          }
          dashPass = { salt: "", hash: await hashPassword(next) };
          store.putDashPass(dashPass);
          // invalidate all dashboard sessions on password change
          sessions.clear();
          const res = json({ ok: true }, 200, { "x-request-id": requestId });
          logStructured(200);
          return res;
        }

        if (path === "/api/combos") {
          if (request.method === "GET") {
            const res = json(store.listCombos(), 200, { "x-request-id": requestId });
            logStructured(200);
            return res;
          }
          if (request.method === "POST") {
            const b = await readBody(request);
            const body = b as { name?: string; models?: unknown[]; strategy?: string } | null;
            if (!body?.name || !Array.isArray(body.models)) {
              const res = json({ error: "need name + models[]" }, 400, { "x-request-id": requestId });
              logStructured(400, "need name + models");
              return res;
            }
            for (const m of body.models) {
              if (typeof m !== "string" || !m.includes("/")) {
                const res = json({ error: `combo model must be 'provider/model', got: ${m}` }, 400, {
                  "x-request-id": requestId,
                });
                logStructured(400, "combo model format");
                return res;
              }
              const [prov] = m.split("/");
              if (!getProvider(prov)) {
                const res = json({ error: `unknown provider: ${prov}` }, 400, { "x-request-id": requestId });
                logStructured(400, "unknown provider");
                return res;
              }
            }
            const strategy = body.strategy && COMBO_STRATEGIES.has(body.strategy) ? body.strategy : "fallback";
            const res = json(store.putCombo(body.name, body.models as string[], strategy), 200, {
              "x-request-id": requestId,
            });
            logStructured(200);
            return res;
          }
        }
        if (path.startsWith("/api/combos/") && request.method === "DELETE") {
          store.deleteCombo(decodeURIComponent(path.slice("/api/combos/".length)));
          const res = json({ ok: true }, 200, { "x-request-id": requestId });
          logStructured(200);
          return res;
        }

        if (path === "/api/custom-providers") {
          if (request.method === "GET") {
            const res = json(store.listCustomProviders(), 200, { "x-request-id": requestId });
            logStructured(200);
            return res;
          }
          if (request.method === "POST") {
            const b = await readBody(request);
            const body = b as { id?: string; name?: string; baseUrl?: string; auth?: string } | null;
            const id = body?.id?.trim().toLowerCase() ?? "";
            if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(id)) {
              const res = json({ error: "id must be 1-32 chars: lowercase letters, digits, dashes" }, 400, {
                "x-request-id": requestId,
              });
              logStructured(400, "bad custom id");
              return res;
            }
            if (getProvider(id)) {
              const res = json({ error: `provider '${id}' already exists` }, 400, { "x-request-id": requestId });
              logStructured(400, "provider exists");
              return res;
            }
            const baseUrl = body?.baseUrl?.trim() ?? "";
            if (!/^https?:\/\//.test(baseUrl)) {
              const res = json({ error: "baseUrl must start with http(s)://" }, 400, { "x-request-id": requestId });
              logStructured(400, "bad baseUrl");
              return res;
            }
            try {
              assertPublicUrl(baseUrl);
            } catch (e) {
              const res = json({ error: e instanceof Error ? e.message : "blocked private address" }, 400, {
                "x-request-id": requestId,
              });
              logStructured(400, "blocked private address");
              return res;
            }
            const auth = body?.auth === "none" || body?.auth === "raw" ? body.auth : "bearer";
            const p: Provider = { id, aliases: [id], name: body?.name?.trim() || undefined, baseUrl, auth };
            store.putCustomProvider(id, p);
            registerCustomProvider(p);
            const res = json(p, 200, { "x-request-id": requestId });
            logStructured(200);
            return res;
          }
        }
        if (path.startsWith("/api/custom-providers/") && request.method === "DELETE") {
          const id = decodeURIComponent(path.slice("/api/custom-providers/".length));
          if (!customProviderIds().includes(id)) {
            const res = json({ error: "unknown custom provider" }, 404, { "x-request-id": requestId });
            logStructured(404, "unknown custom provider");
            return res;
          }
          store.deleteCustomProvider(id);
          unregisterCustomProvider(id);
          for (const c of store.listConnections(id)) store.deleteConnection(c.id);
          const res = json({ ok: true }, 200, { "x-request-id": requestId });
          logStructured(200);
          return res;
        }

        if (path === "/api/connections") {
          if (request.method === "GET") {
            const res = json(store.listConnections(), 200, { "x-request-id": requestId });
            logStructured(200);
            return res;
          }
          if (request.method === "POST") {
            const b = await readBody(request);
            const body = b as {
              provider?: string;
              api_key?: string;
              name?: string;
              base_url?: string;
              extra?: string;
              priority?: number;
            } | null;
            if (!body?.provider || !body.api_key) {
              const res = json({ error: "need provider + api_key" }, 400, { "x-request-id": requestId });
              logStructured(400, "need provider + api_key");
              return res;
            }
            if (!getProvider(body.provider)) {
              const res = json({ error: `unknown provider: ${body.provider}` }, 400, { "x-request-id": requestId });
              logStructured(400, "unknown provider");
              return res;
            }
            if (body.base_url) {
              if (!/^https?:\/\//.test(body.base_url)) {
                const res = json({ error: "base_url must start with http(s)://" }, 400, { "x-request-id": requestId });
                logStructured(400, "bad base_url");
                return res;
              }
              try {
                assertPublicUrl(body.base_url);
              } catch (e) {
                const res = json({ error: e instanceof Error ? e.message : "blocked private address" }, 400, {
                  "x-request-id": requestId,
                });
                logStructured(400, "blocked private address");
                return res;
              }
            }
            const res = json(
              store.addConnection({
                provider: body.provider,
                api_key: body.api_key,
                name: body.name,
                base_url: body.base_url,
                extra: body.extra,
                priority: body.priority,
              }),
              200,
              { "x-request-id": requestId },
            );
            logStructured(200);
            return res;
          }
        }
        if (path.startsWith("/api/connections/")) {
          const id = path.slice("/api/connections/".length);
          if (request.method === "PUT") {
            const b = await readBody(request);
            if (!b) {
              const res = json({ error: "bad body" }, 400, { "x-request-id": requestId });
              logStructured(400, "bad body");
              return res;
            }
            const upd = b as { base_url?: string } | null;
            if (upd?.base_url) {
              if (!/^https?:\/\//.test(upd.base_url)) {
                const res = json({ error: "base_url must start with http(s)://" }, 400, { "x-request-id": requestId });
                logStructured(400, "bad base_url");
                return res;
              }
              try {
                assertPublicUrl(upd.base_url);
              } catch (e) {
                const res = json({ error: e instanceof Error ? e.message : "blocked private address" }, 400, {
                  "x-request-id": requestId,
                });
                logStructured(400, "blocked private address");
                return res;
              }
            }
            const row = store.updateConnection(id, b as never);
            const res = json(row ?? { error: "unknown connection" }, row ? 200 : 404, { "x-request-id": requestId });
            logStructured(res.status, row ? undefined : "unknown connection");
            return res;
          }
          if (request.method === "DELETE") {
            store.deleteConnection(id);
            const res = json({ ok: true }, 200, { "x-request-id": requestId });
            logStructured(200);
            return res;
          }
        }

        if (path === "/api/logs") {
          const limit = Math.min(500, Number(url.searchParams.get("limit") ?? 50));
          const res = json(store.listLogs(limit), 200, { "x-request-id": requestId });
          logStructured(200);
          return res;
        }

        const res = json({ error: "not found" }, 404, { "x-request-id": requestId });
        logStructured(404, "not found");
        return res;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        panic(TAG.PROXY, "handleChat", err, { requestId });
        const res = json(
          { error: { message: `panic: ${msg.slice(0, 200)}`, type: "troy_panic", code: "internal" } },
          500,
          { "x-request-id": requestId },
        );
        logStructured(500, msg);
        return res;
      }
    },
  });

  return {
    server,
    store,
    cooldowns,
    url: server.url.toString(),
    getApiAuth: () => apiAuth,
    getDashPass: () => dashPass,
    shutdown: () => {
      try {
        clearInterval(sessionSweep as unknown as NodeJS.Timeout);
      } catch {}
      try {
        clearInterval(gcTimer as unknown as NodeJS.Timeout);
      } catch {}
      try {
        globalLimiter?.stop();
      } catch {}
      try {
        modelLimiter?.stop();
      } catch {}
      try {
        store.stopLogFlush();
      } catch {}
    },
  };
}
