import type { Server } from "bun";
import { mkdirSync } from "node:fs";
import { Store } from "./db";
import { CooldownStore, handleChat, type ChatDeps } from "./route";
import { providerIds } from "./registry";

const PORT = Number(process.env.PORT ?? 20128);
const DATA_DIR = process.env.TROY_DATA ?? "data";
const ROOT = import.meta.dir;

mkdirSync(DATA_DIR, { recursive: true });
const store = new Store(DATA_DIR + "/troy.db");
store.startLogFlush(2000);
const cooldowns = new CooldownStore();

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
};

function staticFile(pathname: string): Response | null {
  let rel = pathname === "/" ? "index.html" : pathname.replace(/^\//, "");
  if (rel === "app.js") rel = "dist/app.js";
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
            if (!providerIds().includes(prov) && !PROVIDERS.some((p) => p.aliases.includes(prov))) {
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

    if (path === "/api/connections") {
      if (request.method === "GET") return json(store.listConnections());
      if (request.method === "POST") {
        return readBody(request).then((b) => {
          const body = b as { provider?: string; api_key?: string; base_url?: string; extra?: string; priority?: number } | null;
          if (!body?.provider || !body.api_key) return json({ error: "need provider + api_key" }, 400);
          const id = store.addConnection({ provider: body.provider, api_key: body.api_key, base_url: body.base_url, extra: body.extra, priority: body.priority });
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