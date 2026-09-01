/**
 * FreeBuff (codebuff.com free tier) native wire bridge.
 * Chat completions body → the CLI request envelope the free-mode gate demands
 * (Buffy system marker at position 0, codebuff_metadata, provider
 * data_collection=deny, forced streaming, cb_easp stop sentinel), plus the
 * free-session lifecycle that feeds it an instance id. Wire shapes ported from
 * trefeon/freebuff-proxy internal/upstream.
 * ponytail: no agent-run START/FINISH lifecycle v1 — run_id is a random UUID;
 * add the run calls if upstream starts rejecting/flagging unknown runs. No
 * queued-session poll loop either — queued cools the account down instead.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";

const UPSTREAM_UA = "ai-sdk/openai-compatible/1.0.0/codebuff";
const CLI_MARKER =
  "You are Buffy, the strategic coding assistant. You are the AI agent behind the product, Freebuff, a tool where users can chat with you to code with AI for free.";
/** upstream gate = trimmed-prefix test at position 0 of the first system message */
const MARKER_PHRASE = "You are Buffy, the strategic coding assistant";
/** session is ready until expiresAt minus this margin */
const EXPIRY_MARGIN_MS = 5_000;
const RUN_TTL_MS = 6 * 60 * 60 * 1000;
/** boot-stable client_id — per-boot wf- + 8 [a-z0-9] for cf-worker corroboration, not per-request */
const BOOT_CLIENT_ID = `wf-${Math.random().toString(36).slice(2, 10).padEnd(8, "0").slice(0, 8)}`;

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** epoch ms / RFC3339 / seconds → epoch ms (0 when unusable) */
function ms(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v > 1e11 ? v : v * 1000;
  if (typeof v === "string") {
    const t = Date.parse(v);
    if (Number.isFinite(t)) return t;
  }
  return 0;
}

// ---- free-session cache: per-connection+model, single-flight refresh ----

interface FreebuffSession {
  instanceId: string; // "" = disabled session: proceed without an instance id
  expiresAt: number; // epoch ms; Infinity for disabled
}

const sessions = new Map<string, { sess?: FreebuffSession; refreshing?: Promise<FreebuffSession> }>();
const runs = new Map<string, { run?: FreebuffRun; refreshing?: Promise<FreebuffRun> }>();

function sessionKey(connId: string, model: string): string {
  return `${connId}:${model || "*"}`;
}
function runKey(connId: string, agentId: string): string {
  return `${connId}:${agentId || "*"}`;
}

export function invalidateFreebuff(connId: string): void {
  for (const k of [...sessions.keys()]) if (k === connId || k.startsWith(`${connId}:`)) sessions.delete(k);
  for (const k of [...runs.keys()]) if (k === connId || k.startsWith(`${connId}:`)) runs.delete(k);
}

export function invalidateFreebuffSession(connId: string, model: string): void {
  sessions.delete(sessionKey(connId, model));
}

export function invalidateFreebuffRun(connId: string, agentId?: string): void {
  if (agentId) runs.delete(runKey(connId, agentId));
  else for (const k of [...runs.keys()]) if (k === connId || k.startsWith(`${connId}:`)) runs.delete(k);
}

// ---- agent mapping (fallback mirror of freebuff-proxy registry) ----

const AGENT_BY_MODEL: Record<string, string> = {
  "mimo/mimo-v2.5": "base2-free-mimo",
  "minimax/minimax-m3": "base2-free-minimax-m3",
  "openai/gpt-5.6-luna": "base2-free-luna",
  "deepseek/deepseek-v4-pro": "base2-free-deepseek",
  "deepseek/deepseek-v4-flash": "base2-free-deepseek-flash",
  "z-ai/glm-5.2": "base2-free-glm",
  "crof/kimi-k3-eco": "base2-free-kimi-k3-eco",
  "openai/gpt-5.6-luna-es": "base2-free-luna-es",
  "anthropic/claude-fable-5": "base2-free-fable",
  "meta/muse-spark-1.2-contributor": "base2-free-muse-spark",
  "stealth/ox-alpha": "base2-free-ox-alpha",
  "deepseek/deepseek-v4-pro-max": "base2-free-deepseek-pro-max",
  "deepseek/deepseek-v4-flash-max": "base2-free-deepseek-flash-max",
  "openai/gpt-5.6-luna-max": "base2-free-luna-max",
};

export function agentForModel(model: string): string {
  if (AGENT_BY_MODEL[model]) return AGENT_BY_MODEL[model];
  // fallback: use provider prefix
  const prov = model.split("/")[0] ?? "";
  if (prov === "mimo") return "base2-free-mimo";
  if (prov === "minimax") return "base2-free-minimax-m3";
  if (prov === "openai") return "base2-free-luna";
  if (prov === "deepseek") return "base2-free-deepseek";
  if (prov === "z-ai") return "base2-free-glm";
  return "base2-free-mimo";
}

// ---- manual pause helpers (no auto idle reaper) ----

export function getFreebuffSessions(): { key: string; instanceId: string; expiresAt: number }[] {
  const out: { key: string; instanceId: string; expiresAt: number }[] = [];
  for (const [k, v] of sessions) if (v.sess) out.push({ key: k, instanceId: v.sess.instanceId, expiresAt: v.sess.expiresAt });
  return out;
}

export async function pauseFreebuff(connId?: string, model?: string): Promise<number> {
  let n = 0;
  if (connId && model) {
    const k = sessionKey(connId, model);
    if (sessions.has(k)) { sessions.delete(k); n++; }
    // also clear runs for this conn
    for (const rk of [...runs.keys()]) if (rk.startsWith(`${connId}:`)) { runs.delete(rk); }
    if (n) return 1;
    return 0;
  }
  if (connId) {
    for (const k of [...sessions.keys()]) if (k === connId || k.startsWith(`${connId}:`)) { sessions.delete(k); n++; }
    for (const k of [...runs.keys()]) if (k === connId || k.startsWith(`${connId}:`)) runs.delete(k);
    return n;
  }
  // all
  const total = sessions.size;
  sessions.clear();
  runs.clear();
  return total;
}

interface ConnLike {
  id: string;
  api_key: string;
}

// ---- token auto-discovery: official CLI login files (same as freebuff-proxy) ----

export function freebuffTokenPaths(home: string): string[] {
  return [`${home}/.config/manicode/credentials.json`, `${home}/.config/codebuff/credentials.json`];
}

export function parseFreebuffToken(json: string): string {
  try {
    const p: unknown = JSON.parse(json);
    if (!isObj(p)) return "";
    const profile = isObj(p.default) ? p.default : p;
    return str(profile.authToken);
  } catch {
    return "";
  }
}

let discoveredToken: string | null = null;

export function __resetDiscoveredTokenForTests(): void {
  discoveredToken = null;
}

/** authToken from the CLI credentials files, "" when none; cached after first hit */
export function discoverFreebuffToken(home?: string): string {
  if (discoveredToken) return discoveredToken;
  for (const path of freebuffTokenPaths(home ?? homedir())) {
    try {
      const token = parseFreebuffToken(readFileSync(path, "utf8"));
      if (token) {
        discoveredToken = token;
        return token;
      }
    } catch {
      /* missing/unreadable file — try the next path */
    }
  }
  return "";
}

function fbHeaders(conn: ConnLike, json: boolean): Record<string, string> {
  const h: Record<string, string> = { authorization: `Bearer ${conn.api_key}`, "user-agent": UPSTREAM_UA };
  if (json) h["content-type"] = "application/json";
  return h;
}

async function createSession(
  origin: string,
  conn: ConnLike,
  model: string,
  doFetch: typeof fetch,
): Promise<FreebuffSession> {
  // CLI parity (#120): bare POST — NO body, NO content-type; model rides x-freebuff-model
  const headers = fbHeaders(conn, false);
  if (model) headers["x-freebuff-model"] = model;
  const res = await doFetch(`${origin}/api/v1/freebuff/session`, { method: "POST", headers });
  const text = await res.text().catch(() => "");
  let b: Obj = {};
  try {
    const p: unknown = JSON.parse(text);
    if (isObj(p)) b = p;
  } catch {
    /* non-JSON body */
  }
  const status = str(b.status);
  const retryMs = typeof b.retryAfterMs === "number" ? b.retryAfterMs : undefined;
  const abort = (msg: string, retryAfterMs?: number): never => {
    throw Object.assign(new Error(msg), { retryAfterMs });
  };
  if (status === "queued")
    return abort(`freebuff waiting room (${str(b.position)}/${str(b.queueDepth)})`, retryMs ?? 30_000);
  if (status === "banned") {
    const until = ms(b.resumes_at);
    return abort(
      `freebuff account banned${until ? ` until ${new Date(until).toISOString()}` : ""}`,
      until ? until - Date.now() : retryMs,
    );
  }
  if (status === "country_blocked")
    return abort(`freebuff country blocked${str(b.countryCode) ? ` (${str(b.countryCode)})` : ""}`);
  // only a CREATE 404 maps to disabled (Go semantics); ended on create is dead too
  if (res.status === 404 || status === "disabled") return { instanceId: "", expiresAt: Number.POSITIVE_INFINITY };
  if (!res.ok) abort(`freebuff session ${res.status}: ${text.slice(0, 200)}`, retryMs);
  if (status === "active") return { instanceId: str(b.instanceId), expiresAt: ms(b.expiresAt) || Date.now() + 60_000 };
  return abort(`freebuff session status '${status || "??"}'`);
}

export async function ensureFreebuffSession(
  origin: string,
  conn: ConnLike,
  model: string,
  doFetch: typeof fetch = fetch,
): Promise<FreebuffSession> {
  const key = sessionKey(conn.id, model);
  const st = sessions.get(key);
  if (st?.sess && st.sess.expiresAt - EXPIRY_MARGIN_MS > Date.now()) return st.sess;
  if (st?.refreshing) return st.refreshing;
  const refreshing = createSession(origin, conn, model, doFetch)
    .then((sess) => {
      sessions.set(key, { sess });
      return sess;
    })
    .catch((err: unknown) => {
      sessions.delete(key);
      throw err;
    });
  sessions.set(key, { ...st, refreshing });
  return refreshing;
}

// ---- run cache: random UUID, 6h TTL (no upstream START) ----

interface FreebuffRun {
  runId: string;
  traceSessionId: string;
  step: number;
  expiresAt: number;
}

export async function ensureFreebuffRun(
  _origin: string,
  conn: ConnLike,
  agentId: string,
  _doFetch: typeof fetch = fetch,
): Promise<FreebuffRun> {
  const key = runKey(conn.id, agentId);
  const st = runs.get(key);
  if (st?.run && st.run.expiresAt - EXPIRY_MARGIN_MS > Date.now()) return st.run;
  if (st?.refreshing) return st.refreshing;
  const run: FreebuffRun = {
    runId: crypto.randomUUID(),
    traceSessionId: crypto.randomUUID(),
    step: 1,
    expiresAt: Date.now() + RUN_TTL_MS,
  };
  const refreshing = Promise.resolve(run).then((r) => {
    runs.set(key, { run: r });
    return r;
  });
  runs.set(key, { ...st, refreshing });
  return refreshing;
}

// ---- request side: chat completions body → CLI envelope ----

function hasMarker(content: unknown): boolean {
  if (typeof content === "string") return content.trimStart().startsWith(MARKER_PHRASE);
  if (Array.isArray(content))
    return (content as unknown[]).some((p) => isObj(p) && str(p.text).trimStart().startsWith(MARKER_PHRASE));
  return false;
}

/** guarantee the canonical Buffy opening at position 0 of the first system message */
export function ensureMarker(messages: unknown): Obj[] {
  const msgs = Array.isArray(messages) ? (messages as unknown[]) : [];
  for (const m of msgs) {
    if (isObj(m) && m.role === "system" && hasMarker(m.content)) return msgs as Obj[];
  }
  const out = [...msgs] as Obj[];
  for (let i = 0; i < out.length; i++) {
    const m = out[i];
    if (!isObj(m) || m.role !== "system") continue;
    const msg = { ...m };
    if (typeof msg.content === "string") msg.content = msg.content ? `${CLI_MARKER}\n\n${msg.content}` : CLI_MARKER;
    else if (Array.isArray(msg.content))
      msg.content = [{ type: "text", text: CLI_MARKER }, ...(msg.content as unknown[])];
    else msg.content = CLI_MARKER;
    out[i] = msg;
    return out;
  }
  return [{ role: "system", content: CLI_MARKER }, ...out];
}

/**
 * chat body → CLI envelope. Merges without disturbing client fields:
 * codebuff_metadata (run_id + fresh SDK-faithful client_id draw), provider
 * data_collection=deny, stream=true, cb_easp stop sentinel when absent.
 */
export function wrapFreebuff(
  input: Obj,
  opts: { runId: string; instanceId?: string; traceSessionId?: string; step?: number; costMode?: string },
): Obj {
  const payload: Obj = { ...input, stream: true, provider: { data_collection: "deny" } };
  if (!Array.isArray(payload.stop)) payload.stop = ["cb_easp"];
  const metadata: Obj = { run_id: opts.runId, client_id: BOOT_CLIENT_ID };
  if (opts.instanceId) metadata.freebuff_instance_id = opts.instanceId;
  if (opts.traceSessionId) metadata.trace_session_id = opts.traceSessionId;
  if (typeof opts.step === "number") metadata.step = opts.step;
  if (opts.costMode) metadata.cost_mode = opts.costMode;
  payload.codebuff_metadata = metadata;
  payload.messages = ensureMarker(payload.messages);
  return payload;
}

// ---- error classification → troy cooldown/routing decisions ----

export interface FreebuffErrorInfo {
  /** short human reason; "" when nothing specific */
  reason: string;
  /** server-provided retry hint in ms, when the body carries one */
  retryAfterMs: number | null;
  /** drop the cached session so the next request re-admits */
  invalidate: boolean;
}

export function classifyFreebuffError(status: number, bodyText: string): FreebuffErrorInfo {
  let b: Obj = {};
  try {
    const p: unknown = JSON.parse(bodyText);
    if (isObj(p)) b = p;
  } catch {
    /* non-JSON body */
  }
  const dur = typeof b.retryAfterMs === "number" ? b.retryAfterMs : null;
  const info = (reason: string, o: Partial<FreebuffErrorInfo> = {}): FreebuffErrorInfo => ({
    reason,
    retryAfterMs: null,
    invalidate: false,
    ...o,
  });
  if (bodyText.includes("session_superseded")) return info("session superseded", { invalidate: true });
  if (status === 409)
    return bodyText.includes("session_limit_reached")
      ? info("session limit reached")
      : info("session invalid", { invalidate: true });
  if (status === 403) {
    if (b.status === "banned") {
      const until = ms(b.resumes_at);
      return info("account banned", { retryAfterMs: until ? until - Date.now() : dur });
    }
    if (b.status === "country_blocked") return info("country blocked");
    if (bodyText.includes("free_mode_cli_required")) return info("free mode requires CLI envelope");
    return info("forbidden");
  }
  if (status === 401) return info("auth rejected");
  if (status === 402) return info("no credits");
  if (status === 428) return info("waiting room required", { retryAfterMs: dur });
  if (status === 429) return info(bodyText.includes("ip_capped") ? "ip capped" : "rate limited", { retryAfterMs: dur });
  if (bodyText.includes("free_mode_capacity_deferred"))
    return info("capacity deferred", { retryAfterMs: Math.max(dur ?? 0, 10_000) });
  return info("");
}

// ---- reply side: upstream always streams SSE → buffer into chat.completion JSON ----

interface ToolAcc {
  id: string;
  name: string;
  args: string;
}

export async function freebuffJsonReply(res: Response): Promise<Response> {
  const text = await res.text();
  let id = "";
  let model = "";
  let created = 0;
  let content = "";
  let reasoning = "";
  let finish: string | null = null;
  let usage: Obj | null = null;
  const tools = new Map<number, ToolAcc>();
  for (const line of text.split("\n")) {
    let t = line.trim();
    if (!t.startsWith("data:")) continue;
    t = t.slice(5).trim();
    if (!t || t === "[DONE]") continue;
    let ev: Obj;
    try {
      ev = JSON.parse(t) as Obj;
    } catch {
      continue;
    }
    if (isObj(ev.error)) throw new Error(str((ev.error as Obj).message) || "upstream stream error");
    if (typeof ev.id === "string" && !id) id = ev.id;
    if (typeof ev.model === "string") model = ev.model;
    if (typeof ev.created === "number") created = ev.created;
    if (isObj(ev.usage)) usage = ev.usage;
    const choice = Array.isArray(ev.choices) ? (ev.choices as unknown[])[0] : undefined;
    if (!isObj(choice)) continue;
    const delta = isObj(choice.delta) ? choice.delta : {};
    if (typeof delta.content === "string") content += delta.content;
    if (typeof delta.reasoning_content === "string") reasoning += delta.reasoning_content;
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls as unknown[]) {
        if (!isObj(tc)) continue;
        const idx = typeof tc.index === "number" ? tc.index : tools.size;
        const acc = tools.get(idx) ?? { id: "", name: "", args: "" };
        const fn = isObj(tc.function) ? tc.function : {};
        acc.id ||= str(tc.id);
        acc.name ||= str(fn.name);
        acc.args += str(fn.arguments);
        tools.set(idx, acc);
      }
    }
    if (typeof choice.finish_reason === "string" && choice.finish_reason) finish = choice.finish_reason;
  }
  const message: Obj = { role: "assistant", content };
  if (reasoning) message.reasoning_content = reasoning;
  if (tools.size > 0)
    message.tool_calls = [...tools.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([i, t]) => ({
        id: t.id || `call_${i}`,
        type: "function",
        function: { name: t.name, arguments: t.args },
      }));
  const payload: Obj = {
    id: id || "chatcmpl-troy",
    object: "chat.completion",
    created: created || Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finish ?? "stop" }],
  };
  if (usage) payload.usage = usage;
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
  });
}
