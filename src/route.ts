import { getProvider, inferProvider, type Provider } from "./registry";
import type { Store, Connection } from "./db";
import { compressMessages } from "./rtk";
import { injectCaveman, injectPonytail, type CavemanLevel, type PonytailLevel } from "./inject";
import { isReasoningModel, resolveEffortAlias } from "./reasoning";

const BACKOFF_CONFIG = { base: 2000, max: 300000, maxLevel: 15 };
const TRANSIENT_COOLDOWN_MS = 30000;
const COOLDOWN_LONG_MS = 120000;
const COOLDOWN_SHORT_MS = 5000;
const STICKY_ROUND_ROBIN_LIMIT = 3;

/** Keyless opencode (Zen free tier) — same allow-list OmniRoute uses. */
const OPENCODE_FREE_MODELS = new Set([
  "big-pickle",
  "deepseek-v4-flash-free",
  "mimo-v2.5-free",
  "hy3-free",
  "nemotron-3-ultra-free",
  "north-mini-code-free",
]);

/** Free if `-free` suffix or on the known list; unknown ⇒ premium (fail-safe). */
function isFreeOpencodeModel(model: string, provider: string): boolean {
  if (provider !== "opencode") return true;
  if (model.endsWith("-free")) return true;
  return OPENCODE_FREE_MODELS.has(model);
}

const ERROR_TEXT_BACKOFF = ["rate limit", "too many requests", "quota exceeded", "capacity", "overloaded"];

const now = () => Date.now();

interface CooldownState {
  until: number;
  backoff: number;
  locks: Map<string, number>;
}

export class CooldownStore {
  private states = new Map<string, CooldownState>();
  private rr = new Map<string, { id: string; count: number }>();

  backoffLevel(id: string): number {
    return this.states.get(id)?.backoff ?? 0;
  }

  lockExpiry(id: string, key: string): number {
    const s = this.states.get(id);
    if (!s) return 0;
    return Math.max(s.until, s.locks.get(key) ?? 0, s.locks.get("*") ?? 0);
  }

  isEligible(id: string, key: string): boolean {
    return this.lockExpiry(id, key) <= now();
  }

  fail(id: string, key: string, status: number, errText: string) {
    const s = this.ensure(id);
    const { cooldownMs, newBackoffLevel } = classify(status, errText, s.backoff);
    s.until = now() + cooldownMs;
    s.backoff = newBackoffLevel;
    s.locks.set(key, now() + cooldownMs);
  }

  success(id: string, key: string) {
    const s = this.states.get(id);
    if (!s) return;
    s.locks.delete(key);
    s.until = 0;
    for (const [k, v] of s.locks) {
      if (v <= now()) s.locks.delete(k);
    }
    if (s.locks.size === 0) s.backoff = 0;
  }

  earliestRetryAfter(): number | null {
    let earliest: number | null = null;
    for (const [, s] of this.states) {
      for (const until of [s.until, ...s.locks.values()]) {
        if (until <= now()) continue;
        if (earliest === null || until < earliest) earliest = until;
      }
    }
    return earliest;
  }

  pick(eligible: Connection[], key: string, strategy: string): Connection {
    const first = eligible[0];
    if (strategy !== "round-robin" || eligible.length < 2) return first;
    const st = this.rr.get(key);
    if (st && eligible.some((c) => c.id === st.id) && st.count < STICKY_ROUND_ROBIN_LIMIT - 1) {
      st.count += 1;
      return eligible.find((c) => c.id === st.id)!;
    }
    const idx = st ? Math.max(0, eligible.findIndex((c) => c.id === st.id)) : -1;
    const next = eligible[(idx + 1) % eligible.length];
    this.rr.set(key, { id: next.id, count: 0 });
    return next;
  }

  private ensure(id: string): CooldownState {
    let s = this.states.get(id);
    if (!s) {
      s = { until: 0, backoff: 0, locks: new Map() };
      this.states.set(id, s);
    }
    return s;
  }
}

function classify(status: number, errText: string, backoffLevel = 0): { cooldownMs: number; newBackoffLevel: number } {
  const lower = String(errText ?? "").toLowerCase();
  if (/request not allowed/.test(lower)) return { cooldownMs: COOLDOWN_SHORT_MS, newBackoffLevel: backoffLevel };
  const backsOff = ERROR_TEXT_BACKOFF.some((r) => lower.includes(r)) || status === 429;
  if (backsOff) {
    const lvl = Math.min(backoffLevel + 1, BACKOFF_CONFIG.maxLevel);
    return { cooldownMs: getQuotaCooldown(lvl), newBackoffLevel: lvl };
  }
  if (status === 401 || status === 402 || status === 403 || status === 404) {
    return { cooldownMs: COOLDOWN_LONG_MS, newBackoffLevel: backoffLevel };
  }
  return { cooldownMs: TRANSIENT_COOLDOWN_MS, newBackoffLevel: backoffLevel };
}

function getQuotaCooldown(level: number): number {
  return Math.min(BACKOFF_CONFIG.base * Math.pow(2, Math.max(0, level - 1)), BACKOFF_CONFIG.max);
}

export interface LogRow {
  provider: string;
  model: string;
  combo?: string;
  status: string;
  latency_ms: number;
}

export interface ChatDeps {
  store: Store;
  cooldowns: CooldownStore;
  strategy: string;
  rtkOn: boolean;
  cavemanLevel: string;
  ponytailLevel: string;
  signal?: AbortSignal;
  onLog: (row: LogRow) => void;
}

function openaiError(status: number, message: string): Response {
  return new Response(
    JSON.stringify({ error: { message, type: status >= 500 ? "server_error" : "invalid_request_error", code: status >= 500 ? "bad_gateway" : "bad_request" } }),
    { status, headers: { "content-type": "application/json", "access-control-allow-origin": "*" } }
  );
}

function parseModelStr(spec: string): { provider: string; model: string } {
  const idx = spec.indexOf("/");
  if (idx > 0) return { provider: spec.slice(0, idx), model: spec.slice(idx + 1) };
  return { provider: inferProvider(spec).id, model: spec };
}

function safeExtra(conn: Connection): Record<string, string> {
  try {
    return JSON.parse(conn.extra || "{}");
  } catch {
    return {};
  }
}

export function buildBaseUrl(def: Provider, conn: Connection): string {
  const base = conn.base_url ?? def.baseUrl;
  if (!def.placeholders) return base;
  const extra = safeExtra(conn);
  return base.replace(/\{(\w+)\}/g, (_, k: string) => String(extra[k] ?? ""));
}

function passthrough(res: Response, stream: boolean): Response {
  const headers = new Headers({ "access-control-allow-origin": "*" });
  const ct = res.headers.get("content-type");
  headers.set("content-type", ct ?? (stream ? "text/event-stream" : "application/json"));
  if (stream) headers.set("cache-control", "no-cache");
  for (const h of ["retry", "x-request-id"]) {
    const v = res.headers.get(h);
    if (v) headers.set(h, v);
  }
  return new Response(res.body, { status: res.status, headers });
}

async function forward(body: Record<string, unknown>, conn: Connection, def: Provider, signal?: AbortSignal): Promise<Response> {
  const headers: Record<string, string> = {};
  if (def.auth === "bearer") headers.authorization = `Bearer ${conn.api_key}`;
  else if (def.auth === "raw") headers["x-api-key"] = conn.api_key;
  if (body.stream) headers.accept = "text/event-stream";
  for (const [k, v] of Object.entries(def.headers ?? {})) headers[k] = v;
  return fetch(buildBaseUrl(def, conn), {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
    redirect: "follow",
  });
}

/**
 * Chat core: combo chain → per-provider multi-account rotation → fallback.
 */
export async function handleChat(body: Record<string, unknown>, deps: ChatDeps): Promise<Response> {
  if (typeof body.model !== "string" || !body.model) return openaiError(400, "Missing 'model' in request body");

  const combo = deps.store.getCombo(body.model);
  const chain: string[] = combo ? combo.models : [body.model];
  if (chain.length === 0) return openaiError(400, `Combo '${body.model}' has no models`);

  if (deps.rtkOn) compressMessages(body);
  if (deps.cavemanLevel !== "off") injectCaveman(body, deps.cavemanLevel as CavemanLevel);
  if (deps.ponytailLevel !== "off") injectPonytail(body, deps.ponytailLevel as PonytailLevel);

  const t0 = now();
  const stream = body.stream === true;
  let lastError: string | null = null;
  let lastStatus = 502;

  for (const spec of chain) {
    const { provider, model: rawModel } = parseModelStr(spec);
    const { model, effort } = resolveEffortAlias(rawModel);
    const def = getProvider(provider);
    if (!def) {
      lastError = `Unknown provider: ${provider}`;
      lastStatus = 404;
      continue;
    }
    // thinking setup — effort aliases inject reasoning_effort ("o3-mini-high"),
    // and it is silently dropped for non-reasoning models (OmniRoute behavior)
    const effBody: Record<string, unknown> = { ...body, model };
    if (isReasoningModel(model)) {
      if (effort) effBody.reasoning_effort = effort;
    } else {
      delete effBody.reasoning_effort;
    }
    if (def.auth === "none" && !isFreeOpencodeModel(model, def.id)) {
      lastError = `Model '${model}' requires an API key — use 'opencode-go' with a zen key or pick a free-tier model`;
      lastStatus = 402;
      continue;
    }
    const accounts = deps.store.listConnections(provider);
    const excluded = new Set<string>();

    while (true) {
      const eligible = accounts.filter((c) => c.is_active === 1 && !excluded.has(c.id) && deps.cooldowns.isEligible(c.id, model));
      if (eligible.length === 0) {
        const locked = accounts.some((c) => deps.cooldowns.lockExpiry(c.id, model) > now());
        if (locked) {
          lastError = `${provider}/${model} unavailable`;
          lastStatus = 503;
        } else {
          lastError = `No active credentials for provider: ${provider}`;
          lastStatus = 404;
        }
        break;
      }
      const conn = deps.cooldowns.pick(eligible, `${provider}/${model}`, deps.strategy);

      let res: Response;
      try {
        res = await forward(effBody, conn, def, deps.signal);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "network error";
        deps.cooldowns.fail(conn.id, model, 0, msg);
        lastError = msg;
        lastStatus = 502;
        excluded.add(conn.id);
        continue;
      }

      if (res.ok) {
        deps.cooldowns.success(conn.id, model);
        deps.onLog({ provider, model, combo: combo?.name, status: "200 OK", latency_ms: now() - t0 });
        return passthrough(res, stream);
      }

      const bodyText = await res.text().catch(() => "");
      deps.cooldowns.fail(conn.id, model, res.status, bodyText);
      lastError = bodyText || res.statusText || `HTTP ${res.status}`;
      lastStatus = res.status;
      excluded.add(conn.id);
    }
    continue;
  }

  deps.onLog({ provider: "unknown", model: String(body.model), combo: combo?.name, status: `${lastStatus}`, latency_ms: now() - t0 });
  const retryAfter = deps.cooldowns.earliestRetryAfter();
  const headers: Record<string, string> = { "content-type": "application/json", "access-control-allow-origin": "*" };
  if (retryAfter !== null && retryAfter > now()) headers["retry-after"] = String(Math.max(1, Math.ceil((retryAfter - now()) / 1000)));
  return new Response(
    JSON.stringify({ error: { message: lastError, type: "server_error", code: "bad_gateway" } }),
    { status: lastStatus, headers }
  );
}