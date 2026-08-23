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
import { enrich, enrichmentStatus } from "./modelsdev";
import { installOpenCodePlugin } from "./opencode-plugin";
import { handleMessages } from "./providers/anthropic";
import { discoverFreebuffToken, getFreebuffSessions, pauseFreebuff } from "./providers/freebuff";
import { handleResponses } from "./providers/responses";
import type { CooldownStore } from "./proxy/cooldown";
import {
  customProviderIds,
  getProvider,
  type Provider,
  registerCustomProvider,
  unregisterCustomProvider,
} from "./proxy/registry";
import { authHeaders, buildBaseUrl, type ChatDeps, COMBO_STRATEGIES, handleChat } from "./proxy/route";
import type { ApiAuth, DashPass, Store } from "./store/db";

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
}

const SESSION_COOKIE = "troy_session";
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

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

function setSessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;
}

function json(data: unknown, status = 200, extra?: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*", ...extra },
  });
}

function readBody(request: Request): Promise<unknown> {
  return request.text().then((t) => {
    try {
      return JSON.parse(t);
    } catch {
      return null;
    }
  });
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

function cors(request: Request): Response {
  const origin = request.headers.get("origin");
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": origin ?? "*",
      "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
      "access-control-allow-headers": "content-type,authorization,x-api-key",
      "access-control-max-age": "86400",
    },
  });
}

export function buildTroyServer(opts: BuildOptions): TroyServer {
  const { store, cooldowns, port = 0, trace: traceEnabled = false, enableBackgroundTasks = true } = opts;

  const trace = (line: string) => {
    if (traceEnabled) console.log(`  ${line}`);
  };

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
      const now = Date.now();
      for (const [token, exp] of sessions) if (exp < now) sessions.delete(token);
    }, 3_600_000);
    sessionSweep.unref?.();
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

  function buildDeps(request: Request): ChatDeps {
    return {
      store,
      cooldowns,
      strategy: settings.strategy,
      rtkOn: settings.rtk_on === 1,
      cavemanLevel: settings.caveman_level,
      ponytailLevel: settings.ponytail_level,
      signal: request.signal,
      onLog: (row) => store.logRequest(row),
      onTrace: traceEnabled ? trace : undefined,
    };
  }

  function proxyRequest(
    handle: (body: Record<string, unknown>, deps: ChatDeps) => Promise<Response>,
    invalidBody: () => Response,
  ) {
    return async (request: Request, server: { timeout: (req: Request, ms: number) => void }): Promise<Response> => {
      const body = await readBody(request);
      if (!body) return invalidBody();
      const res = await handle(body as Record<string, unknown>, buildDeps(request));
      if (res.body) server.timeout(request, 0);
      return res;
    };
  }

  const openaiInvalidBody = () => json({ error: { message: "Invalid JSON body", type: "invalid_request_error" } }, 400);
  const anthropicInvalidBody = () =>
    json({ type: "error", error: { type: "invalid_request_error", message: "Invalid JSON body" } }, 400);

  const handleChatRequest = proxyRequest(handleChat, openaiInvalidBody);
  const handleMessagesRequest = proxyRequest(handleMessages, anthropicInvalidBody);
  const handleResponsesRequest = proxyRequest(handleResponses, openaiInvalidBody);

  let lastActivity = Date.now();
  let gcTimer: ReturnType<typeof setInterval> | null = null;
  if (enableBackgroundTasks) {
    gcTimer = setInterval(() => {
      if (Date.now() - lastActivity > 30_000) Bun.gc(true);
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
    fetch(request): Response | Promise<Response> {
      lastActivity = Date.now();
      const url = new URL(request.url);
      const path = url.pathname;

      if (request.method === "OPTIONS") return cors(request);

      // ---- dashboard password gate ----
      if (path === "/api/session" && request.method === "GET") {
        return json({ authed: authed(request), defaultPass: !dashPass });
      }
      if (path === "/api/login" && request.method === "POST") {
        return readBody(request).then(async (b) => {
          const body = b as { password?: string } | null;
          if (!(await checkDashboardPassword(body?.password))) {
            return json({ error: "wrong dashboard password" }, 401);
          }
          const token = newSessionToken();
          sessions.set(token, Date.now() + SESSION_TTL_MS);
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: {
              "content-type": "application/json",
              "access-control-allow-origin": "*",
              "set-cookie": setSessionCookie(token),
            },
          });
        });
      }
      if (path === "/api/logout" && request.method === "POST") {
        const token = readCookies(request)[SESSION_COOKIE];
        if (token) sessions.delete(token);
        return new Response(JSON.stringify({ ok: true }), {
          headers: {
            "content-type": "application/json",
            "access-control-allow-origin": "*",
            "set-cookie": `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
          },
        });
      }
      if (path.startsWith("/api/") && !authed(request)) {
        return json({ error: "login required" }, 401);
      }

      // troy's own api key — every /v1 request must carry it while auth is on
      if (isV1Path(path, request.method) && apiAuth.on === 1) {
        const given = extractApiKey(request);
        if (!given || !safeEqual(given, apiAuth.key)) {
          return json(
            {
              error: {
                message: "missing or invalid troy api key — send Authorization: Bearer <key> or x-api-key",
                type: "invalid_request_error",
                code: "invalid_api_key",
              },
            },
            401,
            { "www-authenticate": "Bearer" },
          );
        }
      }

      if (path === "/api/install-opencode-plugin" && request.method === "POST") {
        try {
          return json(
            installOpenCodePlugin({
              baseUrl: url.origin,
              apiKey: apiAuth.on === 1 ? apiAuth.key : "",
            }),
          );
        } catch (e) {
          return json({ error: e instanceof Error ? e.message : "install failed" }, 500);
        }
      }

      if (path === "/api/install-dsh-plugin" && request.method === "POST") {
        try {
          return json(
            installDshPlugin({
              baseUrl: url.origin,
              apiKey: apiAuth.on === 1 ? apiAuth.key : "",
            }),
          );
        } catch (e) {
          return json({ error: e instanceof Error ? e.message : "install failed" }, 500);
        }
      }

      if (path === "/api/clear-dsh-plugin" && request.method === "POST") {
        try {
          return json(clearDshPlugin());
        } catch (e) {
          return json({ error: e instanceof Error ? e.message : "clear failed" }, 500);
        }
      }

      if (path === "/api/key") {
        if (request.method === "GET") return json({ key: apiAuth.key, on: apiAuth.on === 1 });
        if (request.method === "PUT") {
          return readBody(request).then((b) => {
            const body = b as { on?: boolean } | null;
            if (body && typeof body.on === "boolean") {
              apiAuth = { ...apiAuth, on: body.on ? 1 : 0 };
              store.putApiAuth(apiAuth);
            }
            return json({ key: apiAuth.key, on: apiAuth.on === 1 });
          });
        }
      }
      if (path === "/api/key/rotate" && request.method === "POST") {
        apiAuth = { ...apiAuth, key: generateApiKey() };
        store.putApiAuth(apiAuth);
        return json({ key: apiAuth.key, on: apiAuth.on === 1 });
      }

      if (
        request.method === "POST" &&
        (path === "/v1/chat/completions" || path === "/v1/messages" || path === "/v1/responses")
      ) {
        if (path === "/v1/responses") return handleResponsesRequest(request, server);
        if (path === "/v1/messages") return handleMessagesRequest(request, server);
        return handleChatRequest(request, server);
      }

      if (request.method === "GET" && (path === "/v1/models" || path.startsWith("/v1/models/"))) {
        return json({ object: "list", data: modelsList(store) });
      }

      if (request.method === "GET" && path === "/api/stats/daily") {
        const days = Math.min(30, Math.max(1, Number(url.searchParams.get("days") ?? 7)));
        return json(store.statsDaily(days));
      }

      if (request.method === "GET" && path === "/api/stats") {
        return json(stats(store));
      }

      if (request.method === "GET" && path === "/api/providers") {
        return json(providerCatalog(store));
      }

      if (request.method === "GET" && path === "/api/providers/freebuff/cli-token") {
        return json({ token: discoverFreebuffToken() });
      }

      if (request.method === "GET" && path === "/api/providers/freebuff/sessions") {
        return json({ idleMs: FREEBUFF_IDLE_MS, sessions: getFreebuffSessions() });
      }

      if ((request.method === "POST" || request.method === "DELETE") && path === "/api/providers/freebuff/pause") {
        return readBody(request).then(async (b) => {
          const body = (b as { connId?: string; model?: string } | null) ?? {};
          const qConn = url.searchParams.get("connId") ?? undefined;
          const qModel = url.searchParams.get("model") ?? undefined;
          const connId = body.connId ?? qConn;
          const model = body.model ?? qModel;
          const paused = await pauseFreebuff(connId, model);
          return json({ paused, idleMs: FREEBUFF_IDLE_MS });
        });
      }
      // legacy: DELETE session directly
      if (request.method === "DELETE" && path === "/api/providers/freebuff/session") {
        return readBody(request).then(async (b) => {
          const body = (b as { connId?: string; model?: string } | null) ?? {};
          const paused = await pauseFreebuff(body.connId, body.model);
          return json({ paused });
        });
      }

      if (request.method === "GET" && path.startsWith("/api/providers/") && path.endsWith("/models")) {
        const id = decodeURIComponent(path.slice("/api/providers/".length, -"/models".length));
        const def = getProvider(id);
        if (!def) return json({ error: "unknown provider" }, 404);
        const conn = store.listConnections(id).find((c) => c.is_active === 1) ?? null;
        const headers = conn ? authHeaders(def, conn) : {};
        const base = conn ? buildBaseUrl(def, conn) : def.baseUrl;
        if (def.staticModels) {
          return json({
            url: "static",
            models: def.staticModels.map((mid) => ({ id: mid, name: mid, thinking: enrich(mid).reasoning })),
          });
        }
        const modelsUrl =
          def.modelsUrl ??
          (base.endsWith("/chat/completions") ? base.replace(/\/chat\/completions$/, "/models") : `${base}/models`);
        if (!conn && def.auth !== "none") {
          return json({ error: "no key", url: modelsUrl, models: [] }, 502);
        }
        return fetch(modelsUrl, { headers, signal: AbortSignal.timeout(15000), redirect: "follow" })
          .then(async (res) => {
            if (!res.ok) {
              const text = await res.text().catch(() => "");
              let detail: string | undefined;
              try {
                const j = JSON.parse(text) as { error?: { message?: string } };
                const msg = j?.error?.message;
                if (typeof msg === "string" && msg.trim()) detail = msg.trim().slice(0, 200);
              } catch {
                /* non-JSON upstream body */
              }
              return json({ error: `upstream ${res.status}`, detail, url: modelsUrl, models: [] }, 502);
            }
            const data = (await res.json()) as { data?: { id: string; name?: string }[] };
            return json({
              url: modelsUrl,
              models: (data.data ?? []).map((m) => ({
                id: m.id,
                name: m.name ?? m.id,
                thinking: enrich(m.id).reasoning,
              })),
            });
          })
          .catch((e: unknown) =>
            json({ error: e instanceof Error ? e.message : String(e), url: modelsUrl, models: [] }, 502),
          );
      }

      if (path === "/api/models") {
        if (request.method === "GET") {
          return json(store.listModels().map((m) => ({ ...m, thinking: enrich(m.spec).reasoning })));
        }
        if (request.method === "POST") {
          return readBody(request).then((b) => {
            const body = b as { provider?: string; model?: string } | null;
            const provider = body?.provider ?? "";
            const model = body?.model?.trim() ?? "";
            if (!getProvider(provider)) return json({ error: `unknown provider: ${provider}` }, 400);
            if (!model) return json({ error: "model id required" }, 400);
            const m = store.putModel(`${provider}/${model}`);
            return json({ ...m, thinking: enrich(m.spec).reasoning });
          });
        }
      }
      if (path.startsWith("/api/models/") && request.method === "DELETE") {
        store.deleteModel(decodeURIComponent(path.slice("/api/models/".length)));
        return json({ ok: true });
      }

      if (path === "/api/modelsdev/status" && request.method === "GET") {
        return json(enrichmentStatus());
      }

      if (path === "/api/settings") {
        if (request.method === "GET") return json(settings);
        if (request.method === "PUT") {
          return readBody(request).then((b) => {
            if (!b) return json({ error: "bad body" }, 400);
            store.putSettings(b as never);
            refreshSettings();
            return json(settings);
          });
        }
      }

      if (path === "/api/password" && request.method === "POST") {
        return readBody(request).then(async (b) => {
          const body = b as { current?: string; next?: string } | null;
          if (!(await checkDashboardPassword(body?.current))) {
            return json({ error: "current password is wrong" }, 403);
          }
          const next = body?.next;
          if (typeof next !== "string" || next.length < 4) {
            return json({ error: "new password must be at least 4 characters" }, 400);
          }
          dashPass = { salt: "", hash: await hashPassword(next) };
          store.putDashPass(dashPass);
          return json({ ok: true });
        });
      }

      if (path === "/api/combos") {
        if (request.method === "GET") return json(store.listCombos());
        if (request.method === "POST") {
          return readBody(request).then((b) => {
            const body = b as { name?: string; models?: unknown[]; strategy?: string } | null;
            if (!body?.name || !Array.isArray(body.models)) return json({ error: "need name + models[]" }, 400);
            for (const m of body.models) {
              if (typeof m !== "string" || !m.includes("/")) {
                return json({ error: `combo model must be 'provider/model', got: ${m}` }, 400);
              }
              const [prov] = m.split("/");
              if (!getProvider(prov)) {
                return json({ error: `unknown provider: ${prov}` }, 400);
              }
            }
            const strategy = body.strategy && COMBO_STRATEGIES.has(body.strategy) ? body.strategy : "fallback";
            return json(store.putCombo(body.name, body.models as string[], strategy));
          });
        }
      }
      if (path.startsWith("/api/combos/") && request.method === "DELETE") {
        store.deleteCombo(decodeURIComponent(path.slice("/api/combos/".length)));
        return json({ ok: true });
      }

      if (path === "/api/custom-providers") {
        if (request.method === "GET") return json(store.listCustomProviders());
        if (request.method === "POST") {
          return readBody(request).then((b) => {
            const body = b as { id?: string; name?: string; baseUrl?: string; auth?: string } | null;
            const id = body?.id?.trim().toLowerCase() ?? "";
            if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(id)) {
              return json({ error: "id must be 1-32 chars: lowercase letters, digits, dashes" }, 400);
            }
            if (getProvider(id)) return json({ error: `provider '${id}' already exists` }, 400);
            const baseUrl = body?.baseUrl?.trim() ?? "";
            if (!/^https?:\/\//.test(baseUrl)) return json({ error: "baseUrl must start with http(s)://" }, 400);
            const auth = body?.auth === "none" || body?.auth === "raw" ? body.auth : "bearer";
            const p: Provider = { id, aliases: [id], name: body?.name?.trim() || undefined, baseUrl, auth };
            store.putCustomProvider(id, p);
            registerCustomProvider(p);
            return json(p);
          });
        }
      }
      if (path.startsWith("/api/custom-providers/") && request.method === "DELETE") {
        const id = decodeURIComponent(path.slice("/api/custom-providers/".length));
        if (!customProviderIds().includes(id)) return json({ error: "unknown custom provider" }, 404);
        store.deleteCustomProvider(id);
        unregisterCustomProvider(id);
        for (const c of store.listConnections(id)) store.deleteConnection(c.id);
        return json({ ok: true });
      }

      if (path === "/api/connections") {
        if (request.method === "GET") return json(store.listConnections());
        if (request.method === "POST") {
          return readBody(request).then((b) => {
            const body = b as {
              provider?: string;
              api_key?: string;
              name?: string;
              base_url?: string;
              extra?: string;
              priority?: number;
            } | null;
            if (!body?.provider || !body.api_key) return json({ error: "need provider + api_key" }, 400);
            if (!getProvider(body.provider)) return json({ error: `unknown provider: ${body.provider}` }, 400);
            return json(
              store.addConnection({
                provider: body.provider,
                api_key: body.api_key,
                name: body.name,
                base_url: body.base_url,
                extra: body.extra,
                priority: body.priority,
              }),
            );
          });
        }
      }
      if (path.startsWith("/api/connections/")) {
        const id = path.slice("/api/connections/".length);
        if (request.method === "PUT") {
          return readBody(request).then((b) => {
            if (!b) return json({ error: "bad body" }, 400);
            const row = store.updateConnection(id, b as never);
            return json(row ?? { error: "unknown connection" }, row ? 200 : 404);
          });
        }
        if (request.method === "DELETE") {
          store.deleteConnection(id);
          return json({ ok: true });
        }
      }

      if (path === "/api/logs") {
        const limit = Math.min(500, Number(url.searchParams.get("limit") ?? 50));
        return json(store.listLogs(limit));
      }

      return json({ error: "not found" }, 404);
    },
  });

  return {
    server,
    store,
    cooldowns,
    url: server.url.toString(),
    getApiAuth: () => apiAuth,
    getDashPass: () => dashPass,
  };
}
