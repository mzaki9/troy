import { type ChatDeps, handleChat } from "../proxy/route";
import { sseTranslate } from "../proxy/stream";

/**
 * /v1/responses bridge (Codex CLI, Feb 2026+ removed `wire_api = "chat"`).
 * Translates Responses API requests → chat completions, routes through the
 * normal combo/rotation/cooldown machinery, then translates the reply back —
 * both plain JSON and SSE streaming (chat chunks → responses events).
 */

const uuid = () => crypto.randomUUID();

/** responses `input` items → chat `messages[]`. `instructions` becomes the system prompt. */
export function inputToMessages(input: unknown, instructions: unknown): Record<string, unknown>[] {
  const messages: Record<string, unknown>[] = [];
  if (typeof instructions === "string" && instructions) messages.push({ role: "system", content: instructions });
  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
    return messages;
  }
  if (!Array.isArray(input)) return messages;
  for (const raw of input) {
    const it = raw as {
      type?: string;
      role?: string;
      content?: unknown;
      call_id?: string;
      name?: string;
      arguments?: unknown;
      output?: unknown;
    };
    if (it.type === "message") {
      const role = it.role === "assistant" ? "assistant" : "user";
      const content = Array.isArray(it.content)
        ? it.content.map((b: { type?: string; text?: string; image_url?: unknown }) =>
            b.type === "input_image" || b.type === "image_url"
              ? { type: "image_url", image_url: b.image_url ?? {} }
              : { type: "text", text: typeof b.text === "string" ? b.text : "" },
          )
        : (it.content ?? "");
      messages.push({ role, content });
    } else if (it.type === "function_call") {
      messages.push({
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: it.call_id ?? uuid(),
            type: "function",
            function: { name: it.name ?? "", arguments: String(it.arguments ?? "{}") },
          },
        ],
      });
    } else if (it.type === "function_call_output") {
      messages.push({ role: "tool", tool_call_id: it.call_id ?? "", content: String(it.output ?? "") });
    }
    // "reasoning" items: dropped — upstream does its own thinking
  }
  return messages;
}

/** responses request body → chat completions body. */
export function toChatBody(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {
    model: body.model,
    messages: inputToMessages(body.input, body.instructions),
    stream: body.stream === true,
  };
  for (const k of ["temperature", "top_p", "seed", "presence_penalty", "frequency_penalty", "user"]) {
    if (body[k] !== undefined) out[k] = body[k];
  }
  if (typeof body.max_output_tokens === "number") out.max_tokens = body.max_output_tokens;
  const reasoning = body.reasoning as { effort?: string } | undefined;
  if (reasoning?.effort) out.reasoning_effort = reasoning.effort;
  if (Array.isArray(body.tools)) {
    out.tools = (body.tools as { type?: string; name?: string; description?: string; parameters?: unknown }[]).map(
      (t) => ({
        type: "function",
        function: { name: t.name ?? "", description: t.description ?? "", parameters: t.parameters ?? {} },
      }),
    );
  }
  return out;
}

interface ChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
}

/** chat completions response → responses response. */
export function toResponses(res: unknown, model: string): Record<string, unknown> {
  const r = res as {
    id?: string;
    choices?: {
      message?: { content?: unknown; tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[] };
    }[];
    usage?: ChatUsage;
  };
  const msg = r?.choices?.[0]?.message ?? {};
  const output: Record<string, unknown>[] = [];
  let text = "";
  if (typeof msg.content === "string") text = msg.content;
  else if (Array.isArray(msg.content))
    text = msg.content.map((b) => String((b as { text?: string }).text ?? "")).join("");
  if (text) {
    output.push({
      id: uuid(),
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text, annotations: [] }],
    });
  }
  for (const tc of msg.tool_calls ?? []) {
    output.push({
      id: uuid(),
      type: "function_call",
      status: "completed",
      call_id: tc.id ?? uuid(),
      name: tc.function?.name ?? "",
      arguments: tc.function?.arguments ?? "{}",
    });
  }
  const u = r?.usage;
  const out: Record<string, unknown> = {
    id: `resp_${uuid()}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model,
    output,
    output_text: text,
  };
  if (u) {
    out.usage = {
      input_tokens: u.prompt_tokens ?? 0,
      output_tokens: u.completion_tokens ?? 0,
      total_tokens: u.total_tokens ?? 0,
      input_tokens_details: { cached_tokens: u.prompt_tokens_details?.cached_tokens ?? 0 },
      output_tokens_details: { reasoning_tokens: u.completion_tokens_details?.reasoning_tokens ?? 0 },
    };
  }
  return out;
}

interface OpenItem {
  id: string;
  type: "message" | "function_call";
  text: string;
  args: string;
  callId?: string;
  name?: string;
}

export interface StreamState {
  id: string;
  model: string;
  output: Record<string, unknown>[];
  outputText: string;
  open: OpenItem | null;
  tools: Map<number, OpenItem>;
  started: boolean;
  done: boolean;
  usage: ChatUsage | null;
}

function openMessage(st: StreamState, events: Record<string, unknown>[]) {
  if (st.open?.type === "message") return;
  if (st.open) closeOpen(st, events);
  st.open = { id: uuid(), type: "message", text: "", args: "" };
  events.push(
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { id: st.open.id, type: "message", role: "assistant", status: "in_progress", content: [] },
    },
    {
      type: "response.content_part.added",
      item_id: st.open.id,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    },
  );
}

function closeOpen(st: StreamState, events: Record<string, unknown>[]) {
  if (!st.open) return;
  const o = st.open;
  if (o.type === "message") {
    events.push(
      { type: "response.output_text.done", item_id: o.id, output_index: 0, content_index: 0, text: o.text },
      {
        type: "response.content_part.done",
        item_id: o.id,
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: o.text, annotations: [] },
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          id: o.id,
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: o.text, annotations: [] }],
        },
      },
    );
    st.output.push({
      id: o.id,
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: o.text, annotations: [] }],
    });
    st.outputText += o.text;
  } else {
    events.push(
      { type: "response.function_call_arguments.done", item_id: o.id, output_index: 0, arguments: o.args },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          id: o.id,
          type: "function_call",
          status: "completed",
          call_id: o.callId,
          name: o.name,
          arguments: o.args,
        },
      },
    );
    st.output.push({
      id: o.id,
      type: "function_call",
      status: "completed",
      call_id: o.callId,
      name: o.name,
      arguments: o.args,
    });
  }
  st.open = null;
}

/** one chat SSE chunk → zero+ responses events (mutates `st`). */
export function chatChunkToEvents(raw: unknown, st: StreamState): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  if (!st.started) {
    st.started = true;
    const base = {
      id: st.id,
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      status: "in_progress",
      model: st.model,
      output: [],
    };
    events.push({ type: "response.created", response: base }, { type: "response.in_progress", response: base });
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
    openMessage(st, events);
    st.open!.text += delta.content;
    events.push({
      type: "response.output_text.delta",
      item_id: st.open!.id,
      output_index: 0,
      content_index: 0,
      delta: delta.content,
    });
  }
  for (const tc of delta.tool_calls ?? []) {
    if (tc.index == null) continue;
    let t = st.tools.get(tc.index);
    if (!t) {
      closeOpen(st, events);
      const name = tc.function?.name ?? "";
      t = { id: uuid(), type: "function_call", text: "", args: "", callId: tc.id ?? uuid(), name };
      st.tools.set(tc.index, t);
      events.push({
        type: "response.output_item.added",
        output_index: tc.index,
        item: { id: t.id, type: "function_call", call_id: t.callId, name, arguments: "", status: "in_progress" },
      });
    }
    const argDelta = tc.function?.arguments;
    if (argDelta) {
      t.args += argDelta;
      events.push({
        type: "response.function_call_arguments.delta",
        item_id: t.id,
        output_index: tc.index,
        delta: argDelta,
      });
    }
  }
  if (chunk.usage) st.usage = chunk.usage;
  if (choice?.finish_reason) finish(st, events);
  return events;
}

function finish(st: StreamState, events: Record<string, unknown>[]) {
  if (st.done) return;
  st.done = true;
  closeOpen(st, events);
  for (const t of st.tools.values()) {
    events.push(
      { type: "response.function_call_arguments.done", item_id: t.id, output_index: 0, arguments: t.args },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          id: t.id,
          type: "function_call",
          status: "completed",
          call_id: t.callId,
          name: t.name,
          arguments: t.args,
        },
      },
    );
    st.output.push({
      id: t.id,
      type: "function_call",
      status: "completed",
      call_id: t.callId,
      name: t.name,
      arguments: t.args,
    });
  }
  st.tools.clear();
  const u = st.usage;
  const response: Record<string, unknown> = {
    id: st.id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model: st.model,
    output: st.output,
    output_text: st.outputText,
  };
  if (u) {
    response.usage = {
      input_tokens: u.prompt_tokens ?? 0,
      output_tokens: u.completion_tokens ?? 0,
      total_tokens: u.total_tokens ?? 0,
      input_tokens_details: { cached_tokens: u.prompt_tokens_details?.cached_tokens ?? 0 },
      output_tokens_details: { reasoning_tokens: u.completion_tokens_details?.reasoning_tokens ?? 0 },
    };
  }
  events.push({ type: "response.completed", response });
}

export async function handleResponses(body: Record<string, unknown>, deps: ChatDeps): Promise<Response> {
  try {
    const chatBody = toChatBody(body);
    const res = await handleChat(chatBody, deps);
    if (!res.ok) {
      if (deps.requestId) {
        try {
          res.headers.set("x-request-id", deps.requestId);
        } catch {}
      }
      return res;
    }
    const streaming = chatBody.stream === true && (res.headers.get("content-type") ?? "").includes("text/event-stream");
    if (!streaming) {
      const text = await res.text();
      try {
        const headers: Record<string, string> = {
          "content-type": "application/json",
          "access-control-allow-origin": "*",
        };
        if (deps.requestId) headers["x-request-id"] = deps.requestId;
        return new Response(JSON.stringify(toResponses(JSON.parse(text), String(chatBody.model))), {
          status: 200,
          headers,
        });
      } catch {
        if (deps.requestId) {
          try {
            res.headers.set("x-request-id", deps.requestId);
          } catch {}
        }
        return res;
      }
    }
    const st: StreamState = {
      id: `resp_${uuid()}`,
      model: String(chatBody.model),
      output: [],
      outputText: "",
      open: null,
      tools: new Map(),
      started: false,
      done: false,
      usage: null,
    };
    const stream = sseTranslate(
      (ev) => chatChunkToEvents(ev, st),
      (events) => finish(st, events),
    );
    const headers: Record<string, string> = {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "access-control-allow-origin": "*",
    };
    if (deps.requestId) headers["x-request-id"] = deps.requestId;
    return new Response(res.body!.pipeThrough(stream), {
      status: 200,
      headers,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    try {
      console.error(`[panic] handleResponses requestId=${deps.requestId ?? "-"} ${msg}`, stack ?? "");
    } catch {}
    const headers: Record<string, string> = { "content-type": "application/json", "access-control-allow-origin": "*" };
    if (deps.requestId) headers["x-request-id"] = deps.requestId;
    return new Response(
      JSON.stringify({ error: { message: `panic: ${msg.slice(0, 200)}`, type: "troy_panic", code: "internal" } }),
      {
        status: 500,
        headers,
      },
    );
  }
}
