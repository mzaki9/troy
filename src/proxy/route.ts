import { enrich } from "../modelsdev";
import { commandCodeReply, wrapCommandCode } from "../providers/commandcode";
import {
  agentForModel,
  classifyFreebuffError,
  discoverFreebuffToken,
  ensureFreebuffRun,
  ensureFreebuffSession,
  freebuffJsonReply,
  invalidateFreebuff,
  invalidateFreebuffRun,
  invalidateFreebuffSession,
  wrapFreebuff,
} from "../providers/freebuff";
import { type CavemanLevel, injectCaveman, injectPonytail, type PonytailLevel } from "../providers/inject";
import { resolveEffortAlias } from "../providers/reasoning";
import { compressMessages } from "../rtk";
import type { Connection, Store } from "../store/db";
import { type CooldownStore, parseRetryAfter } from "./cooldown";
import { getProvider, inferProvider, type Provider } from "./registry";
import {
  endMark,
  idleGuard,
  normalizeTokens,
  passthrough,
  readBody,
  STREAM_IDLE_MS,
  scanUsage,
  takeHead,
  UPSTREAM_TIMEOUT_MS,
  usageOf,
  withDeadline,
} from "./stream";

/** per-account in-flight cap — one hot account may not eat all parallelism */
const MAX_INFLIGHT_PER_CONN = Math.max(1, Number(process.env.TROY_MAX_INFLIGHT ?? 10));
const inflight = new Map<string, number>();

// hoisted hot-path constant: no per-request RegExp allocation
const RE_PLACEHOLDER = /\{(\w+)\}/g;

function isPrivateHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h === "::1" || h === "0.0.0.0") return true;
  const v4 = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 0) return true;
  }
  if (h.startsWith("fc") || h.startsWith("fd") || h === "::" || h.startsWith("::ffff:")) {
    if (h.startsWith("fc") || h.startsWith("fd")) return true;
  }
  if (h.endsWith(".localhost")) return true;
  return false;
}

export const COMBO_STRATEGIES = new Set(["fallback", "random", "round-robin"]);

const now = () => Date.now();

export interface LogRow {
  provider: string;
  model: string;
  combo?: string;
  status: string;
  latency_ms: number;
  tokens?: Record<string, number>;
  /** RTK compressor: chars removed / chars that entered it (0 when off or no hit) */
  rtk_saved?: number;
  rtk_seen?: number;
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
  /** optional terminal trace for routing decisions (TROY_TRACE=1) */
  onTrace?: (line: string) => void;
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
  const rand = new Uint32Array(out.length);
  crypto.getRandomValues(rand);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor((rand[i] / 2 ** 32) * (i + 1));
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
  return base.replace(RE_PLACEHOLDER, (_, k: string) => String(extra[k] ?? ""));
}

/** Upstream auth + static provider headers — shared by the proxy forward path
 *  and the dashboard's model-listing probe. */
export function authHeaders(def: Provider, conn: Connection): Record<string, string> {
  const headers: Record<string, string> = {};
  if (def.auth === "bearer") headers.authorization = `Bearer ${conn.api_key}`;
  else if (def.auth === "raw") headers["x-api-key"] = conn.api_key;
  for (const [k, v] of Object.entries(def.headers ?? {})) headers[k] = v;
  return headers;
}

async function forward(
  bodyJson: string,
  conn: Connection,
  def: Provider,
  signal?: AbortSignal,
  wantsStream = false,
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json", ...authHeaders(def, conn) };
  if (wantsStream || def.id === "command-code" || def.id === "freebuff") headers.accept = "text/event-stream";
  if (def.id === "command-code") headers["x-session-id"] = crypto.randomUUID();
  const target = buildBaseUrl(def, conn);
  try {
    const u = new URL(target);
    const h = u.hostname.toLowerCase();
    // allow loopback for local dev/tests (store.addConnection can set localhost)
    const isLoopback = h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "0.0.0.0";
    if (!isLoopback && isPrivateHostname(h)) throw new Error("private address blocked");
  } catch (e) {
    if (e instanceof Error && e.message === "private address blocked") throw e;
    // invalid url will be caught by fetch
  }
  return fetch(target, {
    method: "POST",
    headers,
    body: bodyJson,
    signal,
    redirect: "manual",
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

  let rtkSaved = 0;
  let rtkSeen = 0;
  if (deps.rtkOn) {
    const rtk = compressMessages(body);
    rtkSaved = rtk.saved;
    rtkSeen = rtk.seen;
  }
  if (deps.cavemanLevel !== "off") injectCaveman(body, deps.cavemanLevel as CavemanLevel);
  if (deps.ponytailLevel !== "off") injectPonytail(body, deps.ponytailLevel as PonytailLevel);

  const t0 = now();
  const stream = body.stream === true;
  // capability preflight inputs (computed once): members that cannot serve the
  // request are skipped upfront instead of failing mid-walk
  const bodyJson = JSON.stringify(body.messages ?? "");
  const needsTools = Array.isArray(body.tools) && body.tools.length > 0;
  const needsVision = bodyJson.includes("image_url") || bodyJson.includes('"image"');
  const estTokens = Math.ceil(bodyJson.length / 4);
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
      deps.onTrace?.(`skip ${provider}/${model} — unknown provider`);
      continue;
    }
    // preflight: metadata-known members that can't serve the request are skipped
    // with a typed reason (regex floor defaults keep unknown models eligible)
    const meta = enrich(`${provider}/${model}`);
    const missing: string[] = [];
    if (needsTools && !meta.toolCall) missing.push("tools");
    if (needsVision && !meta.attachment) missing.push("vision");
    if (meta.limit?.context && estTokens > meta.limit.context)
      missing.push(`context (${estTokens} est > ${meta.limit.context})`);
    if (missing.length) {
      lastError = `${provider}/${model} preflight: no ${missing.join(", ")}`;
      lastStatus = 503;
      deps.onTrace?.(`skip ${provider}/${model} — no ${missing.join(", ")}`);
      continue;
    }
    // thinking setup — effort aliases inject reasoning_effort ("o3-mini-high"),
    // and it is silently dropped for non-reasoning models (models.dev is source of truth)
    const effBody: Record<string, unknown> = { ...body, model };
    if (meta.reasoning) {
      if (effort) effBody.reasoning_effort = effort;
    } else {
      delete effBody.reasoning_effort;
    }
    // streaming upstreams omit `usage` unless the request asks for it — without
    // this every streamed row logs no tokens and the dashboard shows 0/0
    if (effBody.stream === true && !effBody.stream_options) {
      effBody.stream_options = { include_usage: true };
    }
    // serialize ONCE per chain member — retries across accounts reuse the bytes
    const effBodyStr = JSON.stringify(effBody);
    // command-code speaks the alpha/generate wire format, not chat completions
    const cc = def.id === "command-code";
    // freebuff speaks chat completions but needs the CLI envelope + a free session
    const fb = def.id === "freebuff";
    const wrapped = cc ? wrapCommandCode(effBody) : null;
    const bodyJson = wrapped ? JSON.stringify(wrapped.body) : effBodyStr;
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
      deps.onTrace?.(`skip ${circuitKey} — circuit open`);
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
      // per-account concurrency cap: prefer under-cap accounts; when all are
      // saturated, pile onto the least-loaded one rather than the same one
      const load = (c: Connection) => inflight.get(c.id) ?? 0;
      const free = eligible.filter((c) => load(c) < MAX_INFLIGHT_PER_CONN);
      const pool = free.length > 0 ? free : [eligible.reduce((a, b) => (load(a) <= load(b) ? a : b))];
      let conn = deps.cooldowns.pick(pool, `${provider}/${model}`, deps.strategy);
      deps.onTrace?.(
        `→ ${provider}/${model} via ${conn.name ?? conn.id.slice(0, 8)}${combo ? ` [combo ${combo.name}]` : ""}`,
      );

      // freebuff: ensure the free session + agent run, then wrap the body in the CLI envelope
      let fbJson: string | null = null;
      let fbRun: {
        runId: string;
        traceSessionId: string;
        step: number;
        agentId: string;
        origin: string;
        conn: Connection;
      } | null = null;
      if (fb) {
        try {
          if (!conn.api_key) {
            // keyless connection → ride the official CLI's login token
            const token = discoverFreebuffToken();
            if (!token) throw new Error("no freebuff token — set a key or log in via the FreeBuff/Codebuff CLI");
            conn = { ...conn, api_key: token };
          }
          const origin = new URL(buildBaseUrl(def, conn)).origin;
          const sess = await ensureFreebuffSession(origin, conn, model);
          const agentId = agentForModel(model);
          const run = await ensureFreebuffRun(origin, conn, agentId);
          const enveloped = wrapFreebuff(effBody, {
            runId: run.runId,
            instanceId: sess.instanceId || undefined,
            traceSessionId: run.traceSessionId,
            step: run.step,
            costMode: "free",
          });
          fbJson = JSON.stringify(enveloped);
          fbRun = { ...run, agentId, origin, conn };
        } catch (err) {
          const msg = err instanceof Error ? err.message : "freebuff session failed";
          const ra = (err as { retryAfterMs?: number }).retryAfterMs;
          if (msg.includes("runId") || msg.includes("START")) invalidateFreebuffRun(conn.id);
          deps.cooldowns.fail(conn.id, model, 0, msg, circuitKey, typeof ra === "number" ? ra : undefined);
          lastError = msg;
          lastStatus = 502;
          excluded.add(conn.id);
          continue;
        }
      }

      inflight.set(conn.id, (inflight.get(conn.id) ?? 0) + 1);
      try {
        let res: Response;
        try {
          // Bun's fetch resolves at first body byte, so this deadline is the
          // TTFB guard: streams/CC must show life within one idle gap,
          // non-stream gets the generous whole-request ceiling.
          const ttfb = effBody.stream === true || cc ? STREAM_IDLE_MS : UPSTREAM_TIMEOUT_MS;
          const ac = new AbortController();
          if (deps.signal) {
            if (deps.signal.aborted) ac.abort((deps.signal as AbortSignal & { reason?: unknown }).reason);
            else deps.signal.addEventListener("abort", () => ac.abort((deps.signal as AbortSignal & { reason?: unknown }).reason), { once: true });
          }
          res = await withDeadline(forward(fbJson ?? bodyJson, conn, def, ac.signal, effBody.stream === true), ttfb, ac);
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
            // alpha/generate usage only exists after the stream is consumed —
            // defer the row to stream end (handoff-time logging = every cc row 0/0)
            return commandCodeReply(res, stream, model, wrapped!.toolMap, deps.signal, (usage) =>
              deps.onLog({
                provider,
                model,
                combo: combo?.name,
                status: "200 OK",
                latency_ms: now() - t0,
                // nested detail objects ride along; stats SQL reads the flat numeric keys
                ...(usage ? { tokens: usage as Record<string, number> } : {}),
                rtk_saved: rtkSaved,
                rtk_seen: rtkSeen,
              }),
            );
          }
          // freebuff always streams upstream — buffer SSE into a chat.completion JSON body
          if (fb && !stream) {
            deps.cooldowns.success(conn.id, model, circuitKey);
            try {
              const reply = await freebuffJsonReply(res);
              // log the buffered freebuff reply (usage is inside the generated JSON)
              const txt = await reply
                .clone()
                .text()
                .catch(() => "");
              const tokens = usageOf(txt);
              deps.onLog({
                provider,
                model,
                combo: combo?.name,
                status: "200 OK",
                latency_ms: now() - t0,
                ...(tokens ? { tokens } : {}),
                rtk_saved: rtkSaved,
                rtk_seen: rtkSeen,
              });
              return reply;
            } catch (err) {
              const msg = err instanceof Error ? err.message : "freebuff stream error";
              deps.cooldowns.fail(conn.id, model, 0, msg, circuitKey);
              lastError = msg;
              lastStatus = 502;
              excluded.add(conn.id);
              continue;
            }
          }
          if (!stream) {
            // buffer JSON bodies — dead/empty/oversize upstreams fall through to
            // the next account instead of forwarding a broken payload
            const full = await withDeadline(readBody(res), UPSTREAM_TIMEOUT_MS);
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
              rtk_saved: rtkSaved,
              rtk_seen: rtkSeen,
            });
            return passthrough(new Response(full.text!, { status: res.status, headers: res.headers }), false);
          }
          // streaming: guard the first chunk, tee usage off the wire, log at end
          const head = await takeHead(res, true, (msg) =>
            // death after handoff can't fail over — but the account must still
            // earn a cooldown or a flaky upstream keeps getting traffic
            deps.cooldowns.fail(conn.id, model, 0, msg, circuitKey),
          );
          if (head.error) {
            deps.cooldowns.fail(
              conn.id,
              model,
              0,
              head.error,
              circuitKey,
              parseRetryAfter(res.headers.get("retry-after")),
            );
            lastError = head.error;
            lastStatus = 502;
            excluded.add(conn.id);
            continue;
          }
          deps.cooldowns.success(conn.id, model, circuitKey);
          let tokens: Record<string, number> | undefined;
          // ponytail: slot frees at handoff, not stream end — move the release
          // into endMark if per-account accounting must cover full stream duration
          const guarded = idleGuard(head.res.body!, STREAM_IDLE_MS);
          const scanned = guarded.pipeThrough(scanUsage((u) => (tokens = normalizeTokens(u))));
          const logged = endMark(scanned, () =>
            deps.onLog({
              provider,
              model,
              combo: combo?.name,
              status: "200 OK",
              latency_ms: now() - t0,
              ...(tokens ? { tokens } : {}),
              rtk_saved: rtkSaved,
              rtk_seen: rtkSeen,
            }),
          );
          return passthrough(new Response(logged, { status: 200, headers: res.headers }), true);
        }

        const bodyText = await res.text().catch(() => "");
        if (cc) lastRaw = { body: bodyText, status: res.status };
        // freebuff: typed classification → session/run invalidation + server retry hints
        const fbErr = fb ? classifyFreebuffError(res.status, bodyText) : null;
        if (fbErr?.invalidate) {
          invalidateFreebuff(conn.id);
          if (bodyText.includes("runId")) invalidateFreebuffRun(conn.id);
          else if (fbRun) invalidateFreebuffSession(conn.id, model);
        }
        // runId not found is a run-level invalidate even when not 409
        if (fb && bodyText.includes("runId Not Found") && fbRun) {
          invalidateFreebuffRun(conn.id, fbRun.agentId);
        }
        deps.cooldowns.fail(
          conn.id,
          model,
          res.status,
          fbErr?.reason ? `${fbErr.reason} — ${bodyText}`.slice(0, 300) : bodyText,
          circuitKey,
          fbErr ? fbErr.retryAfterMs : parseRetryAfter(res.headers.get("retry-after")),
        );
        lastError = bodyText || res.statusText || `HTTP ${res.status}`;
        lastStatus = res.status;
        excluded.add(conn.id);
      } finally {
        const n = (inflight.get(conn.id) ?? 1) - 1;
        // key deleted at zero — the map must not grow with every account ever used
        if (n <= 0) inflight.delete(conn.id);
        else inflight.set(conn.id, n);
      }
    }
  }

  deps.onLog({
    provider: lastProvider,
    model: lastModel,
    combo: combo?.name,
    status: `${lastStatus}`,
    latency_ms: now() - t0,
    rtk_saved: rtkSaved,
    rtk_seen: rtkSeen,
  });
  const retryAfter = deps.cooldowns.earliestRetryAfter();
  deps.onTrace?.(`chain exhausted → ${lastStatus}${lastError ? ` — ${lastError.slice(0, 120)}` : ""}`);
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
