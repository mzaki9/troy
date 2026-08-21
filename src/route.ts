import { commandCodeReply, wrapCommandCode } from "./commandcode";
import type { Connection, Store } from "./db";
import { type CavemanLevel, injectCaveman, injectPonytail, type PonytailLevel } from "./inject";
import { isReasoningModel, resolveEffortAlias } from "./reasoning";
import { getProvider, inferProvider, type Provider } from "./registry";
import { compressMessages } from "./rtk";

const BACKOFF_CONFIG = { base: 2000, max: 300000, maxLevel: 15 };
const TRANSIENT_COOLDOWN_MS = 30000;
const COOLDOWN_LONG_MS = 120000;
const COOLDOWN_SHORT_MS = 5000;
const STICKY_ROUND_ROBIN_LIMIT = 3;
/** Circuit breaker: N failures within the window opens a member; it then
 *  fast-skips for OPEN_MS until a probe succeeds (half-open). */
const CIRCUIT_WINDOW_MS = 60000;
const CIRCUIT_THRESHOLD = 3;
const CIRCUIT_OPEN_MS = 30000;
const COMBO_STRATEGIES = new Set(["fallback", "random", "round-robin"]);

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
  /** last failure text per account key — surfaced in 503s so "unavailable" is diagnosable */
  private reasons = new Map<string, string>();
  /** circuit breaker: member (provider/model) → { failures: timestamps[], openUntil } */
  private circuits = new Map<string, { fails: number[]; openUntil: number }>();
  /** per-combo round-robin start index (chain-level rotation) */
  private rrChain = new Map<string, number>();

  /** next start index for a round-robin combo chain */
  nextChainStart(name: string): number {
    const n = this.rrChain.get(name) ?? 0;
    this.rrChain.set(name, n + 1);
    return n;
  }

  /** The reason an account got locked, so the 503 can explain itself. */
  lastFailReason(id: string, key: string): string | null {
    return this.reasons.get(`${id}|${key}`) ?? this.reasons.get(`${id}|*`) ?? null;
  }

  /** true while a member's circuit is open — the fallback walk skips it fast. */
  isOpen(key: string): boolean {
    const c = this.circuits.get(key);
    if (!c) return false;
    if (c.openUntil > now()) return true;
    this.circuits.delete(key);
    return false;
  }

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

  fail(id: string, key: string, status: number, errText: string, circuitKey = key) {
    const s = this.ensure(id);
    const { cooldownMs, newBackoffLevel } = classify(status, errText, s.backoff);
    s.until = now() + cooldownMs;
    s.backoff = newBackoffLevel;
    s.locks.set(key, now() + cooldownMs);
    const reason = extractReason(errText);
    if (reason) this.reasons.set(`${id}|${key}`, reason);
    this.countFailure(circuitKey);
  }

  success(id: string, key: string, circuitKey = key) {
    const s = this.states.get(id);
    if (!s) return;
    s.locks.delete(key);
    s.until = 0;
    for (const [k, v] of s.locks) {
      if (v <= now()) s.locks.delete(k);
    }
    if (s.locks.size === 0) {
      s.backoff = 0;
      this.reasons.delete(`${id}|${key}`);
    }
    // half-open probe succeeded → close the circuit
    this.circuits.delete(circuitKey);
  }

  private countFailure(key: string) {
    const c = this.circuits.get(key) ?? { fails: [], openUntil: 0 };
    c.fails = c.fails.filter((t) => t > now() - CIRCUIT_WINDOW_MS);
    c.fails.push(now());
    if (c.fails.length >= CIRCUIT_THRESHOLD) c.openUntil = now() + CIRCUIT_OPEN_MS;
    this.circuits.set(key, c);
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
    const idx = st
      ? Math.max(
          0,
          eligible.findIndex((c) => c.id === st.id),
        )
      : -1;
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
  return Math.min(BACKOFF_CONFIG.base * 2 ** Math.max(0, level - 1), BACKOFF_CONFIG.max);
}

/** A short, human-safe failure excerpt for cooldown reasons (upstream error text can be huge). */
function extractReason(errText: string): string | null {
  const t = String(errText ?? "").trim();
  if (!t || t === "{}") return null;
  try {
    const j = JSON.parse(t) as { error?: { message?: string; type?: string } };
    const m = j?.error?.type && j?.error?.message ? `${j.error.type}: ${j.error.message}` : j?.error?.message;
    if (m) return m;
  } catch {
    /* non-JSON — use raw text */
  }
  return t.length > 160 ? `${t.slice(0, 160)}…` : t;
}

export interface LogRow {
  provider: string;
  model: string;
  combo?: string;
  status: string;
  latency_ms: number;
  tokens?: Record<string, number>;
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
    JSON.stringify({
      error: {
        message,
        type: status >= 500 ? "server_error" : "invalid_request_error",
        code: status >= 500 ? "bad_gateway" : "bad_request",
      },
    }),
    { status, headers: { "content-type": "application/json", "access-control-allow-origin": "*" } },
  );
}

function parseModelStr(spec: string): { provider: string; model: string } {
  const idx = spec.indexOf("/");
  if (idx > 0) return { provider: spec.slice(0, idx), model: spec.slice(idx + 1) };
  return { provider: inferProvider(spec).id, model: spec };
}

/** Fisher-Yates shuffle — random chain strategy. */
function shuffle<T>(arr: T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor((crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32) * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
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

/** Numeric fields of an upstream `usage` object, or undefined when absent. */
function numericUsage(u: unknown): Record<string, number> | undefined {
  if (!u || typeof u !== "object") return undefined;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(u as Record<string, unknown>)) {
    if (typeof v === "number") out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

/** usage from a complete chat-completions JSON body. */
function usageOf(text: string): Record<string, number> | undefined {
  try {
    return normalizeTokens(numericUsage((JSON.parse(text) as { usage?: unknown }).usage));
  } catch {
    return undefined;
  }
}

/** Map provider dialects onto the OpenAI keys the stats SQL extracts.
 *  Anthropic-style upstreams say input_tokens/output_tokens; others camelCase. */
function normalizeTokens(u: Record<string, number> | undefined): Record<string, number> | undefined {
  if (!u) return u;
  const pick = (...keys: string[]): number | undefined => {
    for (const k of keys) {
      const v = u[k];
      if (typeof v === "number") return v;
    }
    return undefined;
  };
  const prompt = pick("prompt_tokens", "input_tokens", "promptTokens", "inputTokens");
  const completion = pick("completion_tokens", "output_tokens", "completionTokens", "outputTokens");
  if (prompt === undefined && completion === undefined) return u;
  return {
    ...u,
    ...(prompt !== undefined ? { prompt_tokens: prompt } : {}),
    ...(completion !== undefined ? { completion_tokens: completion } : {}),
  };
}

const BODY_CAP = 32 << 20; // upstream JSON bodies beyond this are treated as failures

/** Fully buffer a non-streaming response. Empty / reset / oversize bodies are
 *  failures so the chain walk can try the next account instead of forwarding
 *  a broken payload. */
async function readBody(res: Response): Promise<{ text: string | null; error: string | null }> {
  if (!res.body) return { text: null, error: "upstream returned an empty body" };
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let text = "";
  try {
    for (;;) {
      const n = await reader.read();
      if (n.done) break;
      text += dec.decode(n.value, { stream: true });
      if (text.length > BODY_CAP) return { text: null, error: `upstream body exceeds ${BODY_CAP} bytes` };
    }
  } catch (e) {
    return { text: null, error: e instanceof Error ? e.message : "upstream connection reset" };
  }
  if (!text) return { text: null, error: "upstream returned an empty body" };
  return { text, error: null };
}

type Chunk = { value: Uint8Array; done: false } | { value?: undefined; done: true };

/** Consume the first chunk of a streaming response and hand back a replayable
 *  body. A 200 whose body dies before emitting anything becomes a failure so
 *  the walk continues; mid-stream death surfaces one SSE error frame. */
export async function takeHead(res: Response, stream: boolean): Promise<{ res: Response; error: string | null }> {
  const reader = res.body!.getReader();
  let first: Chunk;
  try {
    first = await reader.read();
  } catch (e) {
    return { res, error: e instanceof Error ? e.message : "upstream connection reset" };
  }
  if (first.done) return { res, error: "upstream returned an empty body" };
  const enc = new TextEncoder();
  let opened = false;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(first.value);
      opened = true;
    },
    async pull(c) {
      let n: Chunk;
      try {
        n = await reader.read();
      } catch (e) {
        if (stream && opened) {
          c.enqueue(
            enc.encode(
              `data: ${JSON.stringify({
                error: {
                  message: e instanceof Error ? e.message : "upstream connection lost mid-stream",
                  type: "server_error",
                  code: "bad_gateway",
                },
              })}\n\n`,
            ),
          );
        }
        c.close();
        return;
      }
      if (n.done) c.close();
      else c.enqueue(n.value);
    },
    cancel() {
      reader.cancel();
    },
  });
  return { res: new Response(body, { status: res.status, headers: res.headers }), error: null };
}

/** SSE scanner that lifts `usage` out of chat chunks without touching bytes. */
function scanUsage(onUsage: (u: Record<string, number>) => void): TransformStream<Uint8Array, Uint8Array> {
  const dec = new TextDecoder();
  let buf = "";
  const grab = (raw: string) => {
    if (!raw || raw === "[DONE]") return;
    try {
      const u = numericUsage((JSON.parse(raw) as { usage?: unknown }).usage);
      if (u) onUsage(u);
    } catch {
      /* non-JSON line */
    }
  };
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, c) {
      buf += dec.decode(chunk, { stream: true });
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line.startsWith("data:")) grab(line.slice(5).trim());
      }
      c.enqueue(chunk);
    },
    flush() {
      const tail = (buf + dec.decode()).trim();
      if (tail.startsWith("data:")) grab(tail.slice(5).trim());
    },
  });
}

/** Fire a callback exactly once when the body is consumed or abandoned. */
function endMark(body: ReadableStream<Uint8Array>, onEnd: () => void): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let fired = false;
  const fire = () => {
    if (!fired) {
      fired = true;
      onEnd();
    }
  };
  return new ReadableStream<Uint8Array>({
    async pull(c) {
      let n: Chunk;
      try {
        n = await reader.read();
      } catch {
        fire();
        c.close();
        return;
      }
      if (n.done) {
        fire();
        c.close();
        return;
      }
      c.enqueue(n.value);
    },
    cancel() {
      fire();
      reader.cancel();
    },
  });
}

async function forward(
  body: Record<string, unknown>,
  conn: Connection,
  def: Provider,
  signal?: AbortSignal,
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (def.auth === "bearer") headers.authorization = `Bearer ${conn.api_key}`;
  else if (def.auth === "raw") headers["x-api-key"] = conn.api_key;
  if (body.stream || def.id === "command-code") headers.accept = "text/event-stream";
  for (const [k, v] of Object.entries(def.headers ?? {})) headers[k] = v;
  if (def.id === "command-code") headers["x-session-id"] = crypto.randomUUID();
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
  const comboStrategy = combo && COMBO_STRATEGIES.has(combo.strategy) ? combo.strategy : "fallback";
  let chain: string[] = combo ? combo.models : [body.model];
  if (chain.length === 0) return openaiError(400, `Combo '${body.model}' has no models`);
  // chain-level load balancing: random shuffles, round-robin rotates start
  if (combo && comboStrategy === "random") chain = shuffle(chain);
  if (combo && comboStrategy === "round-robin") {
    const start = deps.cooldowns.nextChainStart(combo.name) % chain.length;
    chain = [...chain.slice(start), ...chain.slice(0, start)];
  }

  if (deps.rtkOn) compressMessages(body);
  if (deps.cavemanLevel !== "off") injectCaveman(body, deps.cavemanLevel as CavemanLevel);
  if (deps.ponytailLevel !== "off") injectPonytail(body, deps.ponytailLevel as PonytailLevel);

  const t0 = now();
  const stream = body.stream === true;
  let lastError: string | null = null;
  let lastStatus = 502;
  let lastRaw: { body: string; status: number } | null = null;
  // last member attempted — failure logs name it instead of a blanket "unknown"
  let lastProvider = "unknown";
  let lastModel = String(body.model);

  for (const spec of chain) {
    const { provider, model: rawModel } = parseModelStr(spec);
    const { model, effort } = resolveEffortAlias(rawModel);
    lastProvider = provider;
    lastModel = model;
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
    // streaming upstreams omit `usage` unless the request asks for it — without
    // this every streamed row logs no tokens and the dashboard shows 0/0
    if (effBody.stream === true && !effBody.stream_options) {
      effBody.stream_options = { include_usage: true };
    }
    let accounts = deps.store.listConnections(provider);
    if (def.auth === "none" && accounts.length === 0) {
      // keyless providers (opencode zen free tier) need no stored key — route without one
      accounts = [
        {
          id: `${provider}-keyless`,
          provider,
          api_key: "",
          name: null,
          base_url: null,
          extra: "{}",
          priority: 0,
          is_active: 1,
          created_at: "",
        } as Connection,
      ];
    }
    const excluded = new Set<string>();
    const circuitKey = `${provider}/${model}`;
    if (deps.cooldowns.isOpen(circuitKey)) {
      lastError = `${circuitKey} circuit open — skipping (breaker)`; // will be overwritten if a later member succeeds
      lastStatus = 503;
      continue;
    }

    while (true) {
      const eligible = accounts.filter(
        (c) => c.is_active === 1 && !excluded.has(c.id) && deps.cooldowns.isEligible(c.id, model),
      );
      if (eligible.length === 0) {
        const locked = accounts.some((c) => deps.cooldowns.lockExpiry(c.id, model) > now());
        if (locked) {
          const reason = accounts.map((c) => deps.cooldowns.lastFailReason(c.id, model)).find(Boolean) ?? null;
          lastError = reason ? `${provider}/${model} unavailable — ${reason}` : `${provider}/${model} unavailable`;
          lastStatus = 503;
        } else {
          lastError = `No active credentials for provider: ${provider}`;
          lastStatus = 404;
        }
        break;
      }
      const conn = deps.cooldowns.pick(eligible, `${provider}/${model}`, deps.strategy);

      // command-code speaks the alpha/generate wire format, not chat completions
      const cc = def.id === "command-code";
      const wrapped = cc ? wrapCommandCode(effBody) : null;

      let res: Response;
      try {
        res = await forward(wrapped?.body ?? effBody, conn, def, deps.signal);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "network error";
        deps.cooldowns.fail(conn.id, model, 0, msg, circuitKey);
        lastError = msg;
        lastStatus = 502;
        excluded.add(conn.id);
        continue;
      }

      if (res.ok) {
        if (cc) {
          deps.cooldowns.success(conn.id, model, circuitKey);
          deps.onLog({ provider, model, combo: combo?.name, status: "200 OK", latency_ms: now() - t0 });
          return commandCodeReply(res, stream, model, wrapped!.toolMap, deps.signal);
        }
        if (!stream) {
          // buffer JSON bodies — dead/empty/oversize upstreams fall through to
          // the next account instead of forwarding a broken payload
          const full = await readBody(res);
          if (full.error) {
            deps.cooldowns.fail(conn.id, model, 0, full.error, circuitKey);
            lastError = full.error;
            lastStatus = 502;
            excluded.add(conn.id);
            continue;
          }
          const tokens = usageOf(full.text!);
          deps.cooldowns.success(conn.id, model, circuitKey);
          deps.onLog({
            provider,
            model,
            combo: combo?.name,
            status: "200 OK",
            latency_ms: now() - t0,
            ...(tokens ? { tokens } : {}),
          });
          return passthrough(new Response(full.text!, { status: res.status, headers: res.headers }), false);
        }
        // streaming: guard the first chunk, tee usage off the wire, log at end
        const head = await takeHead(res, true);
        if (head.error) {
          deps.cooldowns.fail(conn.id, model, 0, head.error, circuitKey);
          lastError = head.error;
          lastStatus = 502;
          excluded.add(conn.id);
          continue;
        }
        deps.cooldowns.success(conn.id, model, circuitKey);
        let tokens: Record<string, number> | undefined;
        const scanned = head.res.body!.pipeThrough(scanUsage((u) => (tokens = normalizeTokens(u))));
        const logged = endMark(scanned, () =>
          deps.onLog({
            provider,
            model,
            combo: combo?.name,
            status: "200 OK",
            latency_ms: now() - t0,
            ...(tokens ? { tokens } : {}),
          }),
        );
        return passthrough(new Response(logged, { status: 200, headers: res.headers }), true);
      }

      const bodyText = await res.text().catch(() => "");
      if (cc) lastRaw = { body: bodyText, status: res.status };
      deps.cooldowns.fail(conn.id, model, res.status, bodyText, circuitKey);
      lastError = bodyText || res.statusText || `HTTP ${res.status}`;
      lastStatus = res.status;
      excluded.add(conn.id);
    }
  }

  deps.onLog({
    provider: lastProvider,
    model: lastModel,
    combo: combo?.name,
    status: `${lastStatus}`,
    latency_ms: now() - t0,
  });
  const retryAfter = deps.cooldowns.earliestRetryAfter();
  const headers: Record<string, string> = { "content-type": "application/json", "access-control-allow-origin": "*" };
  if (retryAfter !== null && retryAfter > now())
    headers["retry-after"] = String(Math.max(1, Math.ceil((retryAfter - now()) / 1000)));
  // command-code: surface the upstream error body/status verbatim (CC error
  // semantics survive — cooldown bookkeeping above still happens)
  if (lastRaw !== null && lastRaw.status >= 400) {
    return new Response(lastRaw.body, { status: lastRaw.status, headers });
  }
  return new Response(JSON.stringify({ error: { message: lastError, type: "server_error", code: "bad_gateway" } }), {
    status: lastStatus,
    headers,
  });
}
