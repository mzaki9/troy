import { mkdirSync } from "node:fs";
import type { Server } from "bun";
import { handleMessages } from "./anthropic";
import {
  DEFAULT_DASHBOARD_PASS,
  extractApiKey,
  generateApiKey,
  hashPassword,
  newSessionToken,
  safeEqual,
  verifyPassword,
} from "./auth";
import { type ApiAuth, type DashPass, Store } from "./db";
import { enrich, enrichCombo, enrichmentStatus, startModelsDevRefresh } from "./modelsdev";
import { installOpenCodePlugin } from "./opencode-plugin";
import {
  customProviderIds,
  getProvider,
  type Provider,
  providerIds,
  registerCustomProvider,
  unregisterCustomProvider,
} from "./registry";
import { handleResponses } from "./responses";
import { buildBaseUrl, type ChatDeps, CooldownStore, handleChat } from "./route";

const PORT = Number(process.env.PORT ?? 31337);
const DATA_DIR = process.env.TROY_DATA ?? "data";

mkdirSync(DATA_DIR, { recursive: true });
const store = new Store(`${DATA_DIR}/troy.db`);
store.startLogFlush(2000);
// fold the durable state_events log back into live cooldowns/breakers (restart recovery)
const cooldowns = CooldownStore.replay(store.foldStateEvents(), { append: (e) => store.appendStateEvent(e) });

// load user-defined providers into the registry
for (const p of store.listCustomProviders()) {
  registerCustomProvider(p as unknown as Provider);
}

// troy's own api key — generate once at boot, persist it
let apiAuth: ApiAuth = store.getApiAuth();
if (!apiAuth.key) {
  apiAuth.key = generateApiKey();
  store.putApiAuth(apiAuth);
}

// ---- dashboard password gate ----
// Default "troy123" until the user replaces it in Settings → Dashboard
// password. Every /api/* route (except session/login/logout) requires a
// logged-in browser session; the /v1 proxy keeps its own api key.
let dashPass: DashPass | null = store.getDashPass();

function checkDashboardPassword(pw: unknown): boolean {
  if (typeof pw !== "string" || !pw) return false;
  return dashPass ? verifyPassword(pw, dashPass.salt, dashPass.hash) : safeEqual(pw, DEFAULT_DASHBOARD_PASS);
}

const SESSION_COOKIE = "troy_session";
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
/** in-memory sessions: token → expiry. Single-process dashboard, so memory is fine. */
const sessions = new Map<string, number>();
// sweep expired sessions hourly
setInterval(() => {
  const now = Date.now();
  for (const [token, exp] of sessions) if (exp < now) sessions.delete(token);
}, 3_600_000).unref();

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

function setSessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;
}

function loadSettings() {
  return store.getSettings();
}
let settings = loadSettings();

function refreshSettings() {
  settings = loadSettings();
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
  };
}

function modelsList(): unknown[] {
  const out: unknown[] = [];
  for (const combo of store.listCombos()) {
    // a chain is only as capable as its weakest member
    const e = enrichCombo(combo.models);
    out.push({
      id: combo.name,
      object: "model",
      owned_by: "troy",
      reasoning: e?.reasoning ?? false,
      tool_call: e?.toolCall ?? true,
      attachment: e?.attachment ?? true,
      ...(e?.modalities ? { modalities: e.modalities } : {}),
      ...(e?.limit ? { limit: e.limit } : {}),
    });
  }
  for (const m of store.listModels()) {
    const e = enrich(m.spec);
    out.push({
      id: m.spec,
      object: "model",
      owned_by: m.provider,
      custom: true,
      reasoning: e.reasoning,
      tool_call: e.toolCall,
      attachment: e.attachment,
      ...(e.modalities ? { modalities: e.modalities } : {}),
      ...(e.limit ? { limit: e.limit } : {}),
      ...(e.name ? { name: e.name } : {}),
    });
  }
  const active = new Set(store.activeProviderIds());
  for (const pid of providerIds()) {
    if (active.has(pid)) out.push({ id: pid, object: "model", owned_by: pid });
  }
  return out;
}

interface StatRow {
  provider: string;
  model: string;
  n: number;
  ok: number;
  av: number;
  last: string;
  tin: number | null;
  tout: number | null;
}

const STATUS_OK = "200 OK";

function stats(): unknown {
  const byModel = store.raw
    .query(
      "SELECT provider, model, COUNT(*) n, SUM(CASE WHEN status = ? THEN 1 ELSE 0 END) ok, AVG(latency_ms) av, MAX(ts) last, SUM(json_extract(tokens, '$.prompt_tokens')) tin, SUM(json_extract(tokens, '$.completion_tokens')) tout FROM usage_history GROUP BY model, provider ORDER BY n DESC LIMIT 500",
    )
    .all(STATUS_OK) as unknown as StatRow[];
  const lats = (
    store.raw
      .query("SELECT latency_ms FROM usage_history WHERE latency_ms IS NOT NULL ORDER BY latency_ms ASC LIMIT 1000")
      .all() as { latency_ms: number }[]
  ).map((r) => r.latency_ms);
  const p95 = lats.length ? lats[Math.min(lats.length - 1, Math.floor(lats.length * 0.95))] : 0;
  // derive totals + byProvider from byModel — 2 queries instead of 4
  let n = 0;
  let ok = 0;
  let w = 0;
  let tin = 0;
  let tout = 0;
  const prov = new Map<string, { n: number; ok: number; w: number; tin: number; tout: number }>();
  for (const r of byModel) {
    n += r.n;
    ok += r.ok;
    w += r.n * r.av;
    tin += r.tin ?? 0;
    tout += r.tout ?? 0;
    const p = prov.get(r.provider) ?? { n: 0, ok: 0, w: 0, tin: 0, tout: 0 };
    p.n += r.n;
    p.ok += r.ok;
    p.w += r.n * r.av;
    p.tin += r.tin ?? 0;
    p.tout += r.tout ?? 0;
    prov.set(r.provider, p);
  }
  const byProvider = [...prov.entries()]
    .map(([provider, p]) => ({
      provider,
      n: p.n,
      ok: p.ok,
      av: p.w / p.n,
      tokens_in: p.tin,
      tokens_out: p.tout,
    }))
    .sort((a, b) => b.n - a.n);
  return {
    totals: {
      requests: n,
      ok,
      fail: n - ok,
      avg_ms: n ? Math.round(w / n) : 0,
      p95_ms: Math.round(p95),
      tokens_in: tin,
      tokens_out: tout,
    },
    byProvider,
    byModel: byModel.map((r) => ({
      provider: r.provider,
      model: r.model,
      requests: r.n,
      ok: r.ok,
      avg_ms: Math.round(r.av),
      last: r.last,
      tokens_in: r.tin ?? 0,
      tokens_out: r.tout ?? 0,
    })),
  };
}

function providerCatalog(): unknown[] {
  const counts = new Map<string, number>();
  for (const c of store.listConnections()) {
    counts.set(c.provider, (counts.get(c.provider) ?? 0) + (c.is_active === 1 ? 1 : 0));
  }
  const chosen = new Map<string, number>();
  for (const m of store.listModels()) {
    chosen.set(m.provider, (chosen.get(m.provider) ?? 0) + 1);
  }
  const customs = new Set(customProviderIds());
  return providerIds().map((id) => {
    const p = getProvider(id)!;
    return {
      id,
      name: p.name,
      custom: customs.has(id),
      connected: counts.get(id) ?? 0,
      chosen: chosen.get(id) ?? 0,
      baseUrl: p.baseUrl,
      auth: p.auth,
      aliases: p.aliases,
      placeholders: p.placeholders ?? [],
    };
  });
}

async function handleChatRequest(
  request: Request,
  server: { timeout: (req: Request, ms: number) => void },
): Promise<Response> {
  const body = await readBody(request);
  if (!body) return json({ error: { message: "Invalid JSON body", type: "invalid_request_error" } }, 400);
  const res = await handleChat(body as Record<string, unknown>, buildDeps(request));
  if (res.body) server.timeout(request, 0);
  return res;
}

async function handleMessagesRequest(
  request: Request,
  server: { timeout: (req: Request, ms: number) => void },
): Promise<Response> {
  const body = await readBody(request);
  if (!body) {
    return json({ type: "error", error: { type: "invalid_request_error", message: "Invalid JSON body" } }, 400);
  }
  const res = await handleMessages(body as Record<string, unknown>, buildDeps(request));
  if (res.body) server.timeout(request, 0);
  return res;
}

async function handleResponsesRequest(
  request: Request,
  server: { timeout: (req: Request, ms: number) => void },
): Promise<Response> {
  const body = await readBody(request);
  if (!body) return json({ error: { message: "Invalid JSON body", type: "invalid_request_error" } }, 400);
  const res = await handleResponses(body as Record<string, unknown>, buildDeps(request));
  if (res.body) server.timeout(request, 0);
  return res;
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

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

function staticFile(pathname: string): Response | null {
  if (pathname.startsWith("/assets/")) {
    const file = Bun.file(`${import.meta.dir}/../public${pathname}`);
    const ext = `.${pathname.split(".").pop()}`;
    return new Response(file, {
      headers: { "content-type": MIME[ext] ?? "application/octet-stream", "cache-control": "no-cache" },
    });
  }
  let rel = pathname === "/" ? "index.html" : pathname.replace(/^\//, "");
  if (rel === "app.js") rel = "dist/app.js";
  if (rel === "styles.css") rel = "dist/styles.css";
  const file = Bun.file(`${import.meta.dir}/../dashboard/${rel}`);
  const ext = `.${rel.split(".").pop()}`;
  return new Response(file, {
    headers: { "content-type": MIME[ext] ?? "application/octet-stream", "cache-control": "no-cache" },
  });
}

/** Idle GC: return heap pages to the OS when the proxy is quiet. `--smol` lowers
 * the collection thresholds; this nudges a full collect + compaction so RSS
 * stays at the floor instead of growing with burst traffic. */
let lastActivity = Date.now();
setInterval(() => {
  if (Date.now() - lastActivity > 30_000) Bun.gc(true);
}, 60_000).unref();

/** The OpenAI-compatible surface CLI tools talk to — everything under /v1. */
function isV1Path(path: string, method: string): boolean {
  if (method === "POST") {
    return path === "/v1/chat/completions" || path === "/v1/messages" || path === "/v1/responses";
  }
  if (method === "GET") {
    return path === "/v1/models" || path.startsWith("/v1/models/");
  }
  return false;
}

const server: Server<undefined> = Bun.serve({
  port: PORT,
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
      return readBody(request).then((b) => {
        const body = b as { password?: string } | null;
        if (!checkDashboardPassword(body?.password)) {
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
      return json({ object: "list", data: modelsList() });
    }

    if (request.method === "GET" && path === "/api/stats/daily") {
      const days = Math.min(30, Math.max(1, Number(url.searchParams.get("days") ?? 7)));
      return json(store.statsDaily(days));
    }

    if (request.method === "GET" && path === "/api/stats") {
      return json(stats());
    }

    if (request.method === "GET" && path === "/api/providers") {
      return json(providerCatalog());
    }

    if (request.method === "GET" && path.startsWith("/api/providers/") && path.endsWith("/models")) {
      const id = decodeURIComponent(path.slice("/api/providers/".length, -"/models".length));
      const def = getProvider(id);
      if (!def) return json({ error: "unknown provider" }, 404);
      const conn = store.listConnections(id).find((c) => c.is_active === 1) ?? null;
      const headers: Record<string, string> = {};
      if (conn && def.auth === "bearer") headers.authorization = `Bearer ${conn.api_key}`;
      else if (conn && def.auth === "raw") headers["x-api-key"] = conn.api_key;
      for (const [k, v] of Object.entries(def.headers ?? {})) headers[k] = v;
      const base = conn ? buildBaseUrl(def, conn) : def.baseUrl;
      const modelsUrl =
        def.modelsUrl ??
        (base.endsWith("/chat/completions") ? base.replace(/\/chat\/completions$/, "/models") : `${base}/models`);
      // provider needs a key but has none — don't hit upstream with a doomed request
      if (!conn && def.auth !== "none") {
        return json({ error: "no key", url: modelsUrl, models: [] }, 502);
      }
      return fetch(modelsUrl, { headers, signal: AbortSignal.timeout(15000), redirect: "follow" })
        .then(async (res) => {
          if (!res.ok) {
            // surface the upstream's own semantics, not a synthetic wrapper
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
      return readBody(request).then((b) => {
        const body = b as { current?: string; next?: string } | null;
        if (!checkDashboardPassword(body?.current)) {
          return json({ error: "current password is wrong" }, 403);
        }
        const next = body?.next;
        if (typeof next !== "string" || next.length < 4) {
          return json({ error: "new password must be at least 4 characters" }, 400);
        }
        dashPass = hashPassword(next);
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
          const strategy =
            body.strategy && ["fallback", "random", "round-robin"].includes(body.strategy) ? body.strategy : "fallback";
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

    if (request.method === "GET") {
      const file = staticFile(path);
      if (file) return file;
    }

    return json({ error: "not found" }, 404);
  },
});

console.log(`troy → ${server.url}  proxy: ${server.url}v1  dashboard: ${server.url}`);
startModelsDevRefresh((msg) => console.log(`  ${msg}`));
if (!dashPass) {
  console.log(
    `  dashboard password: ${DEFAULT_DASHBOARD_PASS} (default — change it under Settings → Dashboard password)`,
  );
}
