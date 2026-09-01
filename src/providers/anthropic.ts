import { type ChatDeps, handleChat } from "../proxy/route";
import { sseTranslate } from "../proxy/stream";

/**
 * /v1/messages bridge (Anthropic wire format — Claude Code & friends).
 * Translates Anthropic requests → chat completions, routes through the normal
 * combo/rotation/cooldown machinery, then translates the reply back — both
 * plain JSON and SSE streaming (chat chunks → Anthropic events).
 */

const uuid = () => crypto.randomUUID();
const jsonHeaders = { "content-type": "application/json", "access-control-allow-origin": "*" };
const sseHeaders = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache",
  "access-control-allow-origin": "*",
};

interface Block {
  type?: string;
  text?: unknown;
  id?: unknown;
  name?: unknown;
  input?: unknown;
  source?: { type?: string; media_type?: string; data?: string; url?: string };
  tool_use_id?: unknown;
  content?: unknown;
}

interface AnthropicMsg {
  role?: string;
  content?: unknown;
}

function asBlocks(content: unknown): Block[] {
  return Array.isArray(content) ? (content as Block[]) : [];
}

function systemToText(system: unknown): string | null {
  if (typeof system === "string" && system) return system;
  const blocks = asBlocks(system);
  const text = blocks
    .map((b) => String(b.text ?? ""))
    .join("")
    .trim();
  return text || null;
}

function imagePart(source: Block["source"]): Record<string, unknown> | null {
  if (!source) return null;
  if (source.type === "base64" && source.data) {
    return { type: "image_url", image_url: { url: `data:${source.media_type ?? "image/png"};base64,${source.data}` } };
  }
  if (source.url) return { type: "image_url", image_url: { url: source.url } };
  return null;
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  const blocks = asBlocks(content);
  const text = blocks
    .map((b) => String(b.text ?? ""))
    .join("")
    .trim();
  return text || JSON.stringify(content ?? "");
}

/** anthropic request body → chat completions body. */
export function toChatBody(body: Record<string, unknown>): Record<string, unknown> {
  const messages: Record<string, unknown>[] = [];
  const sys = systemToText(body.system);
  if (sys) messages.push({ role: "system", content: sys });

  for (const raw of (Array.isArray(body.messages) ? body.messages : []) as AnthropicMsg[]) {
    if (raw.role === "assistant") {
      const blocks = asBlocks(raw.content);
      const text = blocks
        .filter((b) => b.type === "text")
        .map((b) => String(b.text ?? ""))
        .join("");
      const toolCalls = blocks
        .filter((b) => b.type === "tool_use")
        .map((b) => ({
          id: typeof b.id === "string" && b.id ? b.id : uuid(),
          type: "function",
          function: { name: String(b.name ?? ""), arguments: JSON.stringify(b.input ?? {}) },
        }));
      const msg: Record<string, unknown> = { role: "assistant", content: text };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      messages.push(msg);
      continue;
    }
    // user (and anything unrecognized) — tool_result blocks become tool messages
    const parts: unknown[] = [];
    const toolResults: Record<string, unknown>[] = [];
    if (typeof raw.content === "string") {
      parts.push({ type: "text", text: raw.content });
    } else {
      for (const b of asBlocks(raw.content)) {
        if (b.type === "text") parts.push({ type: "text", text: String(b.text ?? "") });
        else if (b.type === "image") {
          const img = imagePart(b.source);
          if (img) parts.push(img);
        } else if (b.type === "tool_result") {
          toolResults.push({
            role: "tool",
            tool_call_id: String(b.tool_use_id ?? ""),
            content: toolResultText(b.content),
          });
        }
      }
    }
    if (parts.length === 1 && (parts[0] as { type: string }).type === "text") {
      messages.push({ role: "user", content: (parts[0] as { text: string }).text });
    } else if (parts.length) {
      messages.push({ role: "user", content: parts });
    }
    for (const t of toolResults) messages.push(t);
  }

  const out: Record<string, unknown> = { model: body.model, messages, stream: body.stream === true };
  if (typeof body.max_tokens === "number") out.max_tokens = body.max_tokens;
  if (typeof body.temperature === "number") out.temperature = body.temperature;
  if (typeof body.top_p === "number") out.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) out.stop = body.stop_sequences;
  const thinking = body.thinking as { budget_tokens?: number } | undefined;
  if (typeof thinking?.budget_tokens === "number") {
    out.reasoning_effort = thinking.budget_tokens >= 32000 ? "high" : thinking.budget_tokens >= 8000 ? "medium" : "low";
  }
  if (Array.isArray(body.tools)) {
    out.tools = (body.tools as { name?: string; description?: string; input_schema?: unknown }[]).map((t) => ({
      type: "function",
      function: { name: t.name ?? "", description: t.description ?? "", parameters: t.input_schema ?? {} },
    }));
  }
  return out;
}

function stopReason(finish: string | null | undefined): string {
  if (finish === "length") return "max_tokens";
  if (finish === "tool_calls" || finish === "function_call") return "tool_use";
  return "end_turn";
}

interface ChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

/** chat completions response → anthropic message. */
export function toAnthropic(res: unknown, model: string): Record<string, unknown> {
  const r = res as {
    choices?: {
      message?: { content?: unknown; tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[] };
      finish_reason?: string;
    }[];
    usage?: ChatUsage;
  };
  const choice = r?.choices?.[0];
  const msg = choice?.message ?? {};
  const content: Record<string, unknown>[] = [];
  let text = "";
  if (typeof msg.content === "string") text = msg.content;
  else if (Array.isArray(msg.content))
    text = msg.content.map((b) => String((b as { text?: string }).text ?? "")).join("");
  if (text) content.push({ type: "text", text });
  for (const tc of msg.tool_calls ?? []) {
    let input: unknown = {};
    try {
      input = JSON.parse(tc.function?.arguments || "{}");
    } catch {
      /* keep {} */
    }
    content.push({ type: "tool_use", id: tc.id ?? uuid(), name: tc.function?.name ?? "", input });
  }
  if (!content.length) content.push({ type: "text", text: "" });
  return {
    id: `msg_${uuid()}`,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: stopReason(choice?.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: r?.usage?.prompt_tokens ?? 0,
      output_tokens: r?.usage?.completion_tokens ?? 0,
    },
  };
}

// ---- streaming: chat chunks → anthropic events ----

export interface AnthropicState {
  model: string;
  started: boolean;
  finished: boolean;
  nextIndex: number;
  textIndex: number;
  textOpen: boolean;
  tools: Map<number, number>; // chat tool index → anthropic block index
  openTool: number | null;
  stopReason: string | null;
  outputTokens: number;
}

export function freshState(model: string): AnthropicState {
  return {
    model,
    started: false,
    finished: false,
    nextIndex: 0,
    textIndex: -1,
    textOpen: false,
    tools: new Map(),
    openTool: null,
    stopReason: null,
    outputTokens: 0,
  };
}

function closeOpen(st: AnthropicState, events: Record<string, unknown>[]) {
  if (st.textOpen) {
    st.textOpen = false;
    events.push({ type: "content_block_stop", index: st.textIndex });
  }
  if (st.openTool !== null) {
    const idx = st.openTool;
    st.openTool = null;
    events.push({ type: "content_block_stop", index: idx });
  }
}

export function finalize(st: AnthropicState, events: Record<string, unknown>[]) {
  if (st.finished) return;
  st.finished = true;
  closeOpen(st, events);
  events.push({
    type: "message_delta",
    delta: { stop_reason: st.stopReason ?? "end_turn", stop_sequence: null },
    usage: { output_tokens: st.outputTokens },
  });
  events.push({ type: "message_stop" });
}

/** one chat SSE chunk → zero+ anthropic events (mutates `st`). */
export function chatChunkToAnthropicEvents(raw: unknown, st: AnthropicState): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  if (!st.started) {
    st.started = true;
    events.push({
      type: "message_start",
      message: {
        id: `msg_${uuid()}`,
        type: "message",
        role: "assistant",
        model: st.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  }
  const chunk = raw as {
    choices?: {
      delta?: {
        content?: string;
        tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[];
      };
      finish_reason?: string | null;
    }[];
    usage?: ChatUsage;
  };
  const choice = chunk.choices?.[0];
  const delta = choice?.delta ?? {};
  if (typeof delta.content === "string" && delta.content) {
    if (!st.textOpen) {
      st.textIndex = st.nextIndex++;
      st.textOpen = true;
      events.push({
        type: "content_block_start",
        index: st.textIndex,
        content_block: { type: "text", text: "" },
      });
    }
    events.push({
      type: "content_block_delta",
      index: st.textIndex,
      delta: { type: "text_delta", text: delta.content },
    });
  }
  for (const tc of delta.tool_calls ?? []) {
    if (tc.index == null) continue;
    let blockIdx = st.tools.get(tc.index);
    if (blockIdx === undefined) {
      closeOpen(st, events);
      blockIdx = st.nextIndex++;
      st.tools.set(tc.index, blockIdx);
      st.openTool = blockIdx;
      events.push({
        type: "content_block_start",
        index: blockIdx,
        content_block: { type: "tool_use", id: tc.id ?? uuid(), name: tc.function?.name ?? "", input: {} },
      });
    }
    const argDelta = tc.function?.arguments;
    if (argDelta) {
      events.push({
        type: "content_block_delta",
        index: blockIdx,
        delta: { type: "input_json_delta", partial_json: argDelta },
      });
    }
  }
  if (chunk.usage?.completion_tokens != null) st.outputTokens = chunk.usage.completion_tokens;
  if (choice?.finish_reason) {
    st.stopReason = stopReason(choice.finish_reason);
    finalize(st, events);
  }
  return events;
}

/** Surface upstream/chat errors in the anthropic error envelope. */
async function anthropicError(res: Response): Promise<Response> {
  const text = await res.text().catch(() => "");
  let message = res.statusText || "upstream error";
  try {
    const j = JSON.parse(text) as { error?: { message?: string } };
    if (typeof j?.error?.message === "string" && j.error.message) message = j.error.message;
  } catch {
    /* non-JSON body */
  }
  const headers = new Headers(jsonHeaders);
  const retryAfter = res.headers.get("retry-after");
  if (retryAfter) headers.set("retry-after", retryAfter);
  return new Response(
    JSON.stringify({
      type: "error",
      error: { type: res.status < 500 ? "invalid_request_error" : "api_error", message },
    }),
    { status: res.status, headers },
  );
}

export async function handleMessages(body: Record<string, unknown>, deps: ChatDeps): Promise<Response> {
  try {
    const chatBody = toChatBody(body);
    const res = await handleChat(chatBody, deps);
    if (!res.ok) {
      const errRes = await anthropicError(res);
      if (deps.requestId) errRes.headers.set("x-request-id", deps.requestId);
      return errRes;
    }
    const streaming = chatBody.stream === true && (res.headers.get("content-type") ?? "").includes("text/event-stream");
    if (!streaming) {
      const text = await res.text();
      try {
        const headers = new Headers(jsonHeaders);
        if (deps.requestId) headers.set("x-request-id", deps.requestId);
        return new Response(JSON.stringify(toAnthropic(JSON.parse(text), String(chatBody.model))), {
          status: 200,
          headers,
        });
      } catch {
        if (deps.requestId) res.headers.set("x-request-id", deps.requestId);
        return res;
      }
    }
    const st = freshState(String(chatBody.model));
    const stream = sseTranslate(
      (ev) => chatChunkToAnthropicEvents(ev, st),
      (events) => finalize(st, events),
    );
    const headers = new Headers(sseHeaders);
    if (deps.requestId) headers.set("x-request-id", deps.requestId);
    return new Response(res.body!.pipeThrough(stream), { status: 200, headers });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    try {
      console.error(`[panic] handleMessages requestId=${deps.requestId ?? "-"} ${msg}`, stack ?? "");
    } catch {}
    const headers: Record<string, string> = { "content-type": "application/json", "access-control-allow-origin": "*" };
    if (deps.requestId) headers["x-request-id"] = deps.requestId;
    return new Response(
      JSON.stringify({ type: "error", error: { type: "api_error", message: `panic: ${msg.slice(0, 200)}` } }),
      {
        status: 500,
        headers,
      },
    );
  }
}
