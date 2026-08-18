import type { Server } from "bun";
import { mkdirSync } from "node:fs";
import { Store } from "./db";
import { CooldownStore, handleChat, type ChatDeps } from "./route";
import { customProviderIds, getProvider, providerIds, registerCustomProvider, unregisterCustomProvider, type Provider } from "./registry";

const PORT = Number(process.env.PORT ?? 20128);
const DATA_DIR = process.env.TROY_DATA ?? "data";
const ROOT = import.meta.dir;

mkdirSync(DATA_DIR, { recursive: true });
const store = new Store(DATA_DIR + "/troy.db");
store.startLogFlush(2000);
const cooldowns = new CooldownStore();

// load user-defined providers into the registry
for (const p of store.listCustomProviders()) {
  registerCustomProvider(p as unknown as Provider);
}

function loadSettings() {
  return store.getSettings();
}
let settings = loadSettings();

function refreshSettings() {
  settings = loadSettings();
}

function json(data: unknown, status = 200, extra?: Record<string, string>): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "access-control-allow-origin": "*", ...extra } });
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
    out.push({ id: combo.name, object: "model", owned_by: "troy" });
  }
  for (const pid of providerIds()) {
    if (store.listConnections(pid).some((c) => c.is_active === 1)) {
      out.push({ id: pid, object: "model", owned_by: pid });
    }
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
}

const STATUS_OK = "200 OK";

function stats(): unknown {
  const t = store.raw
    .query("SELECT COUNT(*) n, SUM(CASE WHEN status = ? THEN 1 ELSE 0 END) ok, AVG(latency_ms) av FROM usage_history")
    .get(STATUS_OK) as { n: number; ok: number; av: number } | undefined;
  const lats = (store.raw.query("SELECT latency_ms FROM usage_history WHERE latency_ms IS NOT NULL ORDER BY latency_ms ASC LIMIT 1000").all() as { latency_ms: number }[]).map((r) => r.latency_ms);
  const p95 = lats.length ? lats[Math.min(lats.length - 1, Math.floor(lats.length * 0.95))] : 0;
  const byProvider = store.raw
    .query("SELECT provider, COUNT(*) n, SUM(CASE WHEN status = ? THEN 1 ELSE 0 END) ok, AVG(latency_ms) av FROM usage_history GROUP BY provider ORDER BY n DESC")
    .all(STATUS_OK) as unknown as { provider: string; n: number; ok: number; av: number }[];
  const byModel = store.raw
    .query(
      "SELECT provider, model, COUNT(*) n, SUM(CASE WHEN status = ? THEN 1 ELSE 0 END) ok, AVG(latency_ms) av, MAX(ts) last FROM usage_history GROUP BY model, provider ORDER BY n DESC"
    )
    .all(STATUS_OK) as unknown as StatRow[];
  return {
    totals: { requests: t?.n ?? 0, ok: t?.ok ?? 0, fail: (t?.n ?? 0) - (t?.ok ?? 0), avg_ms: Math.round(t?.av ?? 0), p95_ms: Math.round(p95) },
    byProvider,
    byModel: byModel.map((r) => ({ provider: r.provider, model: r.model, requests: r.n, ok: r.ok, avg_ms: Math.round(r.av), last: r.last })),
  };
}

function topology(windowS: number): unknown {
  const since = new Date(Date.now() - windowS * 1000).toISOString();
  const rows = store.raw.query("SELECT provider, ts, status FROM usage_history WHERE ts >= ?").all(since) as { provider: string; ts: string; status: string }[];
  const agg = new Map<string, { count: number; ok: number; last: number; lastOk: boolean }>();
  let globalLast = 0;
  let lastProvider = "";
  for (const r of rows) {
    const ts = Date.parse(r.ts);
    const a = agg.get(r.provider) ?? { count: 0, ok: 0, last: 0, lastOk: false };
    a.count += 1;
    if (r.status === STATUS_OK) a.ok += 1;
    if (ts > a.last) {
      a.last = ts;
      a.lastOk = r.status === STATUS_OK;
    }
    if (ts > globalLast) {
      globalLast = ts;
      lastProvider = r.provider;
    }
    agg.set(r.provider, a);
  }
  const nowMs = Date.now();
  const providers = [...agg.entries()].map(([id, a]) => {
    const active = nowMs - a.last <= 10_000;
    const state = active ? "active" : a.ok < a.count ? "error" : id === lastProvider ? "last" : "idle";
    return { id, label: id, state, count: a.count, ok: a.ok };
  });
  return { activeCount: providers.filter((p) => p.state === "active").length, providers };
}

function providerCatalog(): unknown[] {
  const counts = new Map<string, number>();
  for (const c of store.listConnections()) {
    counts.set(c.provider, (counts.get(c.provider) ?? 0) + (c.is_active === 1 ? 1 : 0));
  }
  const customs = new Set(customProviderIds());
  return providerIds().map((id) => {
    const p = getProvider(id)!;
    return { id, name: p.name, custom: customs.has(id), connected: counts.get(id) ?? 0, baseUrl: p.baseUrl, auth: p.auth, aliases: p.aliases, placeholders: p.placeholders ?? [] };
  });
}


async function handleChatRequest(request: Request, server: { timeout: (req: Request, ms: number) => void }): Promise<Response> {
  const body = await readBody(request);
  if (!body) return json({ error: { message: "Invalid JSON body", type: "invalid_request_error" } }, 400);
  const res = await handleChat(body as Record<string, unknown>, buildDeps(request));
  if (res.body) server.timeout(request, 0);
  return res;
}

function cors(request: Request): Response {
  const origin = request.headers.get("origin");
  return new Response(null, {
    status: 204,
    headers: { "access-control-allow-origin": origin ?? "*", "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS", "access-control-allow-headers": "content-type,authorization,x-api-key", "access-control-max-age": "86400" },
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
  let rel = pathname === "/" ? "index.html" : pathname.replace(/^\//, "");
  if (rel === "app.js") rel = "dist/app.js";
  if (rel === "styles.css") rel = "dist/styles.css";
  const file = Bun.file(`${import.meta.dir}/../dashboard/${rel}`);
  if (!file.exists()) return null;
  const ext = "." + rel.split(".").pop();
  return new Response(file, { headers: { "content-type": MIME[ext] ?? "application/octet-stream", "cache-control": "no-cache" } });
}

const server: Server<undefined> = Bun.serve({
  port: PORT,
  fetch(request): Response | Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") return cors(request);

    if (request.method === "POST" && (path === "/v1/chat/completions" || path === "/v1/messages")) {
      return handleChatRequest(request, server);
    }

    if (request.method === "GET" && (path === "/v1/models" || path.startsWith("/v1/models/"))) {
      return json({ object: "list", data: modelsList() });
    }

    if (request.method === "GET" && path === "/api/topology") {
      const windowS = Math.min(3600, Math.max(5, Number(url.searchParams.get("window") ?? 60)));
      return json(topology(windowS));
    }

    if (request.method === "GET" && path === "/api/stats") {
      return json(stats());
    }

    if (request.method === "GET" && path === "/api/providers") {
      return json(providerCatalog());
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

    if (path === "/api/combos") {
      if (request.method === "GET") return json(store.listCombos());
      if (request.method === "POST") {
        return readBody(request).then((b) => {
          const body = b as { name?: string; models?: unknown[] } | null;
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
          store.putCombo(body.name, body.models as string[]);
          return json(store.getCombo(body.name));
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
          const body = b as { provider?: string; api_key?: string; name?: string; base_url?: string; extra?: string; priority?: number } | null;
          if (!body?.provider || !body.api_key) return json({ error: "need provider + api_key" }, 400);
          if (!getProvider(body.provider)) return json({ error: `unknown provider: ${body.provider}` }, 400);
          const id = store.addConnection({ provider: body.provider, api_key: body.api_key, name: body.name, base_url: body.base_url, extra: body.extra, priority: body.priority });
          return json(store.getConnection(id));
        });
      }
    }
    if (path.startsWith("/api/connections/")) {
      const id = path.slice("/api/connections/".length);
      if (request.method === "PUT") {
        return readBody(request).then((b) => {
          if (!b) return json({ error: "bad body" }, 400);
          store.updateConnection(id, b as never);
          return json(store.getConnection(id));
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