/**
 * Command Code (/alpha/generate) wire-format bridge.
 * Chat completions body → alpha/generate envelope, then back to chat
 * completions (JSON or SSE). Ported lean from OmniRoute's CommandCodeExecutor:
 * - params.stream is always true upstream; the reply is translated either way
 * - assistant tool calls + tool results are only sent when paired
 * - tool names colliding with the server's built-ins get renamed on the wire
 */

const MAX_TOKENS = 200_000;
const RESERVED_TOOL_NAMES = new Set(["tool_search"]);

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function asObjArray(v: unknown): Obj[] {
  return Array.isArray(v) ? v.filter(isObj) : [];
}
function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  return asObjArray(content)
    .filter((p) => p.type === "text")
    .map((p) => str(p.text))
    .join("\n");
}
/** chat `arguments` → the `arguments` string alpha/generate requires */
function argsString(v: unknown): string {
  if (isObj(v)) return JSON.stringify(v);
  if (typeof v === "string" && v.trim()) {
    try {
      return isObj(JSON.parse(v)) ? v : "{}";
    } catch {
      return "{}";
    }
  }
  return "{}";
}
/** alpha/generate `input` field must be an object, not a string */
function argsObject(v: unknown): Obj {
  if (isObj(v)) return v;
  if (typeof v === "string" && v.trim()) {
    try {
      const p: unknown = JSON.parse(v);
      if (isObj(p)) return p;
    } catch {
      /* fall through */
    }
  }
  return {};
}

// ponytail: no shared isVisionModelId heuristic in troy — CC-specific patterns
// + a short generic fallback. Add the shared helper if more providers need it.
const CC_VISION_PATTERNS: RegExp[] = [/kimi-k2/i, /qwen3\.\d/i, /step-?3/i, /claude-fable/i, /gpt-5/i, /fugu/i];
const GENERIC_VISION =
  /(^|[-/])(gpt-4o|gpt-4\.1|o3|o4|claude-3|claude-4|gemini-[23]|minimax-m3|mistral-medium-3|vision|multimodal)/i;

function isVisionModel(model: string): boolean {
  if (/(?:^|\/)mimo-v2\.5-pro$/i.test(model)) return false;
  if (/(?:^|\/)mimo-v2\.5$/i.test(model)) return true;
  if (/(?:^|\/)mimo-v2-omni$/i.test(model)) return true;
  if (CC_VISION_PATTERNS.some((p) => p.test(model))) return true;
  return GENERIC_VISION.test(model);
}

/** OpenAI image_url / CC {type:"image",image} / AI-SDK / Anthropic source block → URL */
function extractImageUrl(part: Obj): string | undefined {
  if (part.type === "image") {
    const direct = str(part.image);
    if (direct) return direct;
    const source = isObj(part.source) ? part.source : null;
    if (source) {
      if (source.type === "base64") {
        const mediaType = str(source.media_type) || "image/png";
        const data = str(source.data);
        if (data) return `data:${mediaType};base64,${data}`;
      }
      if (source.type === "url") {
        const url = str(source.url);
        if (url) return url;
      }
    }
    return undefined;
  }
  if (part.type === "image_url") {
    if (isObj(part.image_url)) return str(part.image_url.url);
    return str(part.image_url);
  }
  return undefined;
}

/** user content → text string (non-vision) or CC parts incl. images (vision) */
function userContent(content: unknown, vision: boolean): string | unknown[] {
  if (!vision || typeof content === "string") return textOf(content);
  const parts: unknown[] = [];
  for (const part of asObjArray(content)) {
    if (part.type === "text") {
      const t = str(part.text);
      if (t) parts.push({ type: "text", text: t });
      continue;
    }
    const url = extractImageUrl(part);
    if (url) parts.push({ type: "image", image: url });
  }
  if (parts.length === 0) parts.push({ type: "text", text: "" }); // CC rejects empty content
  return parts;
}

/** chat body → alpha/generate envelope. Returns body + tool-name reverse map. */
export function wrapCommandCode(body: Obj): { body: Obj; toolMap: Map<string, string> } {
  const toolMap = new Map<string, string>();
  const wire = (name: string): string => {
    if (RESERVED_TOOL_NAMES.has(name)) {
      const w = `troy_${name}`;
      toolMap.set(w, name);
      return w;
    }
    return name;
  };

  const src = asObjArray(body.messages);
  const callIds = new Set<string>();
  const results = new Set<string>();
  const callNames = new Map<string, string>();
  const callArgs = new Map<string, string>();
  for (const m of src) {
    if (m.role === "assistant") {
      for (const c of asObjArray(m.tool_calls)) {
        const id = str(c.id).trim();
        if (!id) continue;
        callIds.add(id);
        const fn = isObj(c.function) ? c.function : c;
        callNames.set(id, wire(str(fn.name) || str(c.name)));
        callArgs.set(id, argsString(fn.arguments));
      }
    } else if (m.role === "tool") {
      const id = str(m.tool_call_id).trim();
      if (id) results.add(id);
    }
  }
  const paired = new Set([...callIds].filter((id) => results.has(id)));
  const vision = isVisionModel(str(body.model));

  const messages: Obj[] = [];
  const system: string[] = [];
  for (const m of src) {
    const role = str(m.role);
    if (role === "system" || role === "developer") {
      const t = textOf(m.content);
      if (t) system.push(t);
    } else if (role === "user") {
      messages.push({ role: "user", content: userContent(m.content, vision) });
    } else if (role === "assistant") {
      const parts: Obj[] = [];
      const text = textOf(m.content);
      if (text) parts.push({ type: "text", text });
      for (const c of asObjArray(m.tool_calls)) {
        const id = str(c.id).trim();
        if (!id || !paired.has(id)) continue;
        const fn = isObj(c.function) ? c.function : c;
        parts.push({
          type: "tool-call",
          toolCallId: id,
          toolName: wire(str(fn.name) || str(c.name) || "unknown"),
          input: argsObject(fn.arguments),
          // /alpha/generate rejects a missing `arguments` with a 400
          arguments: callArgs.get(id) ?? "{}",
        });
      }
      if (parts.length > 0) messages.push({ role: "assistant", content: parts });
    } else if (role === "tool") {
      const id = str(m.tool_call_id).trim();
      if (!id || !paired.has(id)) continue;
      messages.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: id,
            toolName: wire(str(m.name) || callNames.get(id) || "unknown"),
            arguments: callArgs.get(id) ?? "{}",
            output: { type: "text", value: textOf(m.content) },
          },
        ],
      });
    }
  }
  const explicitSystem = typeof body.system === "string" ? body.system : "";

  const params: Obj = {
    model: body.model,
    messages,
    tools: asObjArray(body.tools).map((t) => {
      const fn = isObj(t.function) ? t.function : t;
      return {
        type: "function",
        name: wire(str(fn.name)),
        description: str(fn.description),
        input_schema: isObj(fn.parameters) ? fn.parameters : {},
      };
    }),
    system: [system.join("\n\n"), explicitSystem].filter(Boolean).join("\n\n"),
    stream: true,
  };
  for (const f of ["reasoning_effort", "reasoning", "thinking", "effort", "output_config", "extra_body"]) {
    const v = body[f];
    if (v !== undefined && v !== null) params[f] = v;
  }
  const maxT = body.max_tokens ?? body.max_completion_tokens;
  if (typeof maxT === "number" && Number.isFinite(maxT) && maxT > 0)
    params.max_tokens = Math.min(Math.floor(maxT), MAX_TOKENS);

  return {
    toolMap,
    body: {
      config: {
        workingDir: "/workspace",
        date: new Date().toISOString().slice(0, 10),
        environment: "external",
        structure: [],
        isGitRepo: false,
        currentBranch: "",
        mainBranch: "",
        gitStatus: "",
        recentCommits: [],
      },
      memory: "",
      taste: "",
      skills: "",
      permissionMode: "standard",
      params,
    },
  };
}

// ---- reply side: alpha/generate SSE → chat completions ----

interface CcEvent {
  type?: string;
  text?: unknown;
  toolCallId?: unknown;
  id?: unknown;
  toolName?: unknown;
  name?: unknown;
  input?: unknown;
  args?: unknown;
  arguments?: unknown;
  finishReason?: unknown;
  error?: unknown;
  totalUsage?: unknown;
  usage?: unknown;
}

function parseLine(line: string): CcEvent | undefined {
  let t = line.trim();
  if (!t || t.startsWith(":") || t.startsWith("event:")) return undefined;
  if (t.startsWith("data:")) t = t.slice(5).trim();
  if (!t || t === "[DONE]") return undefined;
  try {
    return JSON.parse(t) as CcEvent;
  } catch {
    return undefined;
  }
}

function finishReasonOf(v: unknown): string {
  if (v === "tool-calls" || v === "tool_calls" || v === "toolUse") return "tool_calls";
  if (v === "length" || v === "max_tokens" || v === "max-tokens" || v === "max_output_tokens") return "length";
  return "stop";
}

interface CcToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface CcState {
  content: string;
  reasoning: string;
  toolCalls: CcToolCall[];
  finishReason: string;
  usage: Obj | null;
}

function firstRecord(u: Obj, keys: string[]): Obj {
  for (const k of keys) {
    const v = u[k];
    if (isObj(v)) return v;
  }
  return {};
}

function firstNumber(u: Obj, keys: string[]): number | undefined {
  for (const k of keys) {
    const v = u[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return undefined;
}

function usageOf(state: CcState): Obj | undefined {
  const usage = state.usage;
  if (!usage) return undefined;
  const inputDetails = firstRecord(usage, [
    "inputTokenDetails",
    "input_token_details",
    "input_tokens_details",
    "prompt_tokens_details",
  ]);
  const outputDetails = firstRecord(usage, [
    "outputTokenDetails",
    "output_token_details",
    "output_tokens_details",
    "completion_tokens_details",
  ]);
  const reasoningDetails = firstRecord(usage, [
    "reasoningTokenDetails",
    "reasoning_token_details",
    "reasoning_tokens_details",
  ]);
  const cacheRead =
    firstNumber(usage, [
      "cachedInputTokens",
      "cached_input_tokens",
      "cacheReadInputTokens",
      "cache_read_input_tokens",
      "cacheReadTokens",
      "cache_read_tokens",
      "cached_tokens",
    ]) ?? firstNumber(inputDetails, ["cachedTokens", "cached_tokens", "cacheReadTokens", "cache_read_tokens"]);
  const noCache = firstNumber(inputDetails, ["noCacheTokens", "no_cache_tokens"]);
  // CC's inputTokens is the full prompt total and already includes the cached
  // portion — do NOT add cacheRead back (would double-count).
  const prompt =
    firstNumber(usage, ["inputTokens", "input_tokens", "promptTokens", "prompt_tokens"]) ??
    (noCache ?? 0) + (cacheRead ?? 0);
  const reasoning =
    firstNumber(usage, ["reasoningTokens", "reasoning_tokens"]) ??
    firstNumber(outputDetails, ["reasoningTokens", "reasoning_tokens"]) ??
    firstNumber(reasoningDetails, ["reasoningTokens", "reasoning_tokens"]);
  const textOutput = firstNumber(outputDetails, ["textTokens", "text_tokens"]);
  const completion =
    firstNumber(usage, ["outputTokens", "output_tokens", "completionTokens", "completion_tokens"]) ??
    (textOutput ?? 0) + (reasoning ?? 0);
  const total = firstNumber(usage, ["totalTokens", "total_tokens"]) ?? prompt + completion;
  const out: Obj = {
    prompt_tokens: prompt,
    prompt_tokens_details: { cached_tokens: cacheRead ?? 0 },
    completion_tokens: completion,
    completion_tokens_details: { reasoning_tokens: reasoning ?? 0 },
    total_tokens: total,
  };
  if (cacheRead !== undefined && cacheRead > 0) out.cache_read_input_tokens = cacheRead;
  if (noCache !== undefined && noCache > 0) out.no_cache_tokens = noCache;
  if (reasoning !== undefined && reasoning > 0) out.reasoning_tokens = reasoning;
  return out;
}

const chatId = () => `chatcmpl-${crypto.randomUUID()}`;

function chunk(id: string, model: string, delta: Obj, finish: unknown = null): string {
  return `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
}

function mergeUsage(state: CcState, ev: CcEvent): void {
  const usage = ev.type === "finish-step" ? (ev.usage ?? ev.totalUsage) : (ev.totalUsage ?? ev.usage);
  if (!isObj(usage)) return;
  const merged: Obj = { ...(state.usage ?? {}), ...usage };
  for (const key of [
    "inputTokenDetails",
    "input_token_details",
    "input_tokens_details",
    "prompt_tokens_details",
    "outputTokenDetails",
    "output_token_details",
    "output_tokens_details",
    "completion_tokens_details",
    "reasoningTokenDetails",
    "reasoning_token_details",
  ]) {
    const before = isObj(state.usage?.[key]) ? state.usage[key] : {};
    const after = isObj(usage[key]) ? usage[key] : {};
    if (Object.keys(before).length > 0 || Object.keys(after).length > 0) merged[key] = { ...before, ...after };
  }
  state.usage = merged;
}

function toolCallOf(ev: CcEvent, toolMap: Map<string, string>): CcToolCall {
  const args = isObj(ev.input) ? ev.input : isObj(ev.args) ? ev.args : isObj(ev.arguments) ? ev.arguments : {};
  const rawName = str(ev.toolName) || str(ev.name) || "";
  return {
    id: str(ev.toolCallId) || str(ev.id) || crypto.randomUUID(),
    type: "function",
    function: { name: toolMap.get(rawName) ?? rawName, arguments: JSON.stringify(args) },
  };
}

function throwError(ev: CcEvent): never {
  const err = isObj(ev.error) ? ev.error : {};
  throw new Error(str(err.message) || str(ev.error) || "Command Code stream error");
}

/** alpha/generate reply (always SSE upstream) → chat completions JSON or SSE. */
export async function commandCodeReply(
  upstream: Response,
  stream: boolean,
  model: string,
  toolMap: Map<string, string>,
  signal?: AbortSignal,
): Promise<Response> {
  const reader = upstream.body?.getReader();
  if (!reader) return errorResponse(new Error("Command Code response missing body"));

  const decoder = new TextDecoder();
  const state: CcState = { content: "", reasoning: "", toolCalls: [], finishReason: "stop", usage: null };
  const id = chatId();

  const ingest = async (onEvent: (ev: CcEvent) => void): Promise<void> => {
    let buf = "";
    const feed = (ev?: CcEvent) => {
      if (ev) onEvent(ev);
    };
    for (;;) {
      if (signal?.aborted) throw new DOMException("aborted", "AbortError");
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) feed(parseLine(line));
    }
    feed(parseLine(buf));
  };

  function errorResponse(err: unknown): Response {
    return new Response(
      JSON.stringify({
        error: { message: err instanceof Error ? err.message : String(err), type: "server_error", code: "bad_gateway" },
      }),
      {
        status: 502,
        headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
      },
    );
  }

  // non-stream client: aggregate everything into one chat completion
  if (!stream) {
    try {
      await ingest((ev) => {
        if (ev.type === "error") throwError(ev);
        mergeUsage(state, ev);
        switch (ev.type) {
          case "text-delta":
            state.content += str(ev.text);
            break;
          case "reasoning-delta":
            state.reasoning += str(ev.text);
            break;
          case "tool-call":
            state.toolCalls.push(toolCallOf(ev, toolMap));
            break;
          case "finish":
            state.finishReason = finishReasonOf(ev.finishReason);
            break;
        }
      });
    } catch (err) {
      return errorResponse(err);
    }
    const message: Obj = { role: "assistant", content: state.content };
    if (state.reasoning) message.reasoning_content = state.reasoning;
    if (state.toolCalls.length > 0) message.tool_calls = state.toolCalls;
    const payload: Obj = {
      id,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, message, finish_reason: state.finishReason }],
    };
    const usage = usageOf(state);
    if (usage) payload.usage = usage;
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
    });
  }

  // streaming client: alpha/generate events → chat completion chunks
  const encoder = new TextEncoder();
  let onAbort: (() => void) | null = null;
  const translated = new ReadableStream<Uint8Array>({
    async start(controller) {
      let sentRole = false;
      let closed = false;
      const emit = (s: string) => {
        if (!closed) controller.enqueue(encoder.encode(s));
      };
      onAbort = () => {
        closed = true;
        reader.cancel().catch(() => undefined);
        controller.error(new DOMException("aborted", "AbortError"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        await ingest((ev) => {
          if (closed) return;
          if (ev.type === "error") throwError(ev);
          mergeUsage(state, ev);
          if (!sentRole) {
            sentRole = true;
            emit(chunk(id, model, { role: "assistant" }));
          }
          switch (ev.type) {
            case "text-delta": {
              const t = str(ev.text);
              if (t) {
                state.content += t;
                emit(chunk(id, model, { content: t }));
              }
              break;
            }
            case "reasoning-delta": {
              const t = str(ev.text);
              if (t) {
                state.reasoning += t;
                emit(chunk(id, model, { reasoning_content: t }));
              }
              break;
            }
            case "tool-call": {
              const tc = toolCallOf(ev, toolMap);
              state.toolCalls.push(tc);
              emit(chunk(id, model, { tool_calls: [{ index: state.toolCalls.length - 1, ...tc }] }));
              break;
            }
            case "finish": {
              state.finishReason = finishReasonOf(ev.finishReason);
              emit(chunk(id, model, {}, state.finishReason));
              const usage = usageOf(state);
              if (usage) {
                emit(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", model, usage, choices: [] })}\n\n`);
              }
              emit("data: [DONE]\n\n");
              closed = true;
              reader.cancel().catch(() => undefined);
              break;
            }
          }
        });
        signal?.removeEventListener("abort", onAbort!);
        if (!closed) {
          if (!sentRole) emit(chunk(id, model, { role: "assistant" }));
          emit(chunk(id, model, {}, state.finishReason));
          emit("data: [DONE]\n\n");
        }
        controller.close();
      } catch (err) {
        signal?.removeEventListener("abort", onAbort!);
        controller.error(err);
      }
    },
    cancel() {
      signal?.removeEventListener("abort", onAbort!);
      return reader.cancel().catch(() => undefined);
    },
  });
  return new Response(translated, {
    status: 200,
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache", "access-control-allow-origin": "*" },
  });
}
