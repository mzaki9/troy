import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Store } from "../src/db";
import { CooldownStore, handleChat, type ChatDeps, type LogRow } from "../src/route";

interface StubBehavior {
  status: number;
  headers?: Record<string, string>;
  body: string;
}

let stubUrl = "";
let behaviors = new Map<string, StubBehavior>();
let lastPayload: unknown = null;

const stub = Bun.serve({
  port: 0,
  async fetch(req) {
    const auth = req.headers.get("authorization") ?? "";
    const key = auth.replace(/^Bearer /, "");
    const text = await req.text();
    lastPayload = JSON.parse(text);
    if (key === "echo") {
      return Response.json({ echo: JSON.parse(text), key }, { status: 200 });
    }
    const b = behaviors.get(key);
    if (b?.headers?.["content-type"] === "text/event-stream") {
      return new Response(b.body, { status: b.status, headers: { "content-type": "text/event-stream" } });
    }
    return new Response(b?.body ?? "{}", { status: b?.status ?? 200, headers: { "content-type": "application/json" } });
  },
});

beforeAll(() => {
  stubUrl = stub.url.toString();
});

afterAll(() => {
  stub.stop(true);
});

function makeDeps(overrides?: Partial<ChatDeps>): { store: Store; cd: CooldownStore; deps: ChatDeps; logs: LogRow[] } {
  const store = new Store(":memory:");
  const cd = new CooldownStore();
  const logs: LogRow[] = [];
  const deps: ChatDeps = {
    store,
    cooldowns: cd,
    strategy: "fill-first",
    rtkOn: false,
    cavemanLevel: "off",
    ponytailLevel: "off",
    onLog: (r) => logs.push(r),
    ...overrides,
  };
  return { store, cd, deps, logs };
}

function addConn(ctx: ReturnType<typeof makeDeps>, provider: string, key: string, priority = 0): string {
  return ctx.store.addConnection({ provider, api_key: key, base_url: stubUrl, priority });
}

describe("multi-account rotation", () => {
  test("first account 429 → second account succeeds", async () => {
    behaviors.set("bad", { status: 429, body: JSON.stringify({ error: { message: "rate limit exceeded" } }) });
    behaviors.set("good", { status: 200, body: JSON.stringify({ ok: true }) });
    const ctx = makeDeps();
    addConn(ctx, "openai", "bad");
    addConn(ctx, "openai", "good");
    const res = await handleChat({ model: "openai/gpt-4o", message: "hi" }, ctx.deps);
    expect(res.status).toBe(200);
  });

  test("all accounts fail → 503", async () => {
    behaviors.set("bad", { status: 429, body: JSON.stringify({ error: { message: "rate limit exceeded" } }) });
    const ctx = makeDeps();
    addConn(ctx, "openai", "bad");
    addConn(ctx, "openai", "bad");
    const res = await handleChat({ model: "openai/gpt-4o", message: "hi" }, ctx.deps);
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).not.toBeNull();
  });

  test("4xx marks account unavailable → 503 with Retry-After", async () => {
    behaviors.set("noauth", { status: 401, body: "{}" });
    const ctx = makeDeps();
    addConn(ctx, "openai", "noauth");
    const first = await handleChat({ model: "openai/gpt-4o", message: "hi" }, ctx.deps);
    expect(first.status).toBe(503);
    expect(first.headers.get("retry-after")).not.toBeNull();
    const second = await handleChat({ model: "openai/gpt-4o", message: "hi" }, ctx.deps);
    expect(second.status).toBe(503);
  });
});

describe("combo fallback", () => {
  test("provider A down → combo walks to provider B", async () => {
    behaviors.set("bad", { status: 500, body: "boom" });
    behaviors.set("good", { status: 200, body: JSON.stringify({ ok: true }) });
    const ctx = makeDeps();
    ctx.store.putCombo("t", ["openai/gpt-4o", "deepseek/deepseek-chat"]);
    addConn(ctx, "openai", "bad");
    addConn(ctx, "deepseek", "good");
    const res = await handleChat({ model: "t", message: "hi" }, ctx.deps);
    expect(res.status).toBe(200);
    expect(ctx.deps.onLog.toString).toBeDefined();
  });

  test("single bare model routes by inference", async () => {
    behaviors.set("good", { status: 200, body: "{}" });
    const ctx = makeDeps();
    addConn(ctx, "deepseek", "good");
    const res = await handleChat({ model: "deepseek-chat", message: "hi" }, ctx.deps);
    expect(res.status).toBe(200);
  });
});

describe("errors", () => {
  test("unknown provider → 404", async () => {
    const ctx = makeDeps();
    const res = await handleChat({ model: "nope/x", message: "hi" }, ctx.deps);
    expect(res.status).toBe(404);
  });
  test("missing model → 400", async () => {
    const ctx = makeDeps();
    const res = await handleChat({ message: "hi" } as never, ctx.deps);
    expect(res.status).toBe(400);
  });
  test("no active credentials → 404", async () => {
    const ctx = makeDeps();
    const res = await handleChat({ model: "openai/gpt-4o" }, ctx.deps);
    expect(res.status).toBe(404);
  });
});

describe("streaming passthrough", () => {
  test("SSE body passes through byte-identical", async () => {
    const sse = "data: {\"id\":\"1\",\"object\":\"chat.completion.chunk\"}\n\ndata: [DONE]\n\n";
    behaviors.set("sse", { status: 200, headers: { "content-type": "text/event-stream" }, body: sse });
    const ctx = makeDeps();
    addConn(ctx, "openai", "sse");
    const res = await handleChat({ model: "openai/gpt-4o", stream: true }, ctx.deps);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(await res.text()).toBe(sse);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("rtk + inject", () => {
  test("RTK compresses ls-shaped tool output", async () => {
    behaviors.set("echo", { status: 200, body: "{}" });
    const ctx = makeDeps({ rtkOn: true });
    addConn(ctx, "openai", "echo");
    const rows = Array.from({ length: 300 }, (_, i) => `-rw-r--r--  1 u g ${1000 + i} Jan 01 10:00 file${i}.rs`);
    const toolContent = rows.join("\n");
    expect(toolContent.length).toBeGreaterThan(500);
    await handleChat(
      {
        model: "openai/gpt-4o",
        messages: [{ role: "user", content: "look" }, { role: "tool", tool_call_id: "1", content: toolContent }],
      },
      ctx.deps
    );
    const forwarded = (lastPayload as { messages: { role: string; content: string }[] }).messages.find((m) => m.role === "tool");
    expect(forwarded!.content.length).toBeLessThan(toolContent.length);
  });

  test("tool_result error blocks are preserved (is_error skipped)", async () => {
    behaviors.set("echo", { status: 200, body: "{}" });
    const ctx = makeDeps();
    addConn(ctx, "openai", "echo");
    const big = Array.from({ length: 300 }, (_, i) => `-rw-r--r-- 1 u g ${i} Jan 01 10:00 f${i}.rs`).join("\n");
    await handleChat(
      {
        model: "openai/gpt-4o",
        messages: [{ role: "assistant", content: [{ type: "tool_result", tool_use_id: "1", is_error: true, text: big }] }],
      },
      ctx.deps
    );
    const forwarded = (lastPayload as { messages: { content: { type: string; text: string }[] }[] }).messages[0];
    expect((forwarded.content as { text: string }[])[0].text).toBe(big);
  });

  test("caveman injects system prompt", async () => {
    behaviors.set("echo", { status: 200, body: "{}" });
    const ctx = makeDeps({ cavemanLevel: "full" });
    addConn(ctx, "openai", "echo");
    await handleChat({ model: "openai/gpt-4o", messages: [{ role: "user", content: "hi" }] }, ctx.deps);
    const forwarded = (lastPayload as { messages: unknown[] }).messages;
    const sys = (forwarded as { role?: string; content?: string }[]).find((m) => m.role === "system");
    expect(sys).toBeDefined();
    expect((sys as { content: string }).content).toContain("caveman");
  });
});
describe("opencode free gate", () => {
  test("premium model without a key → 402", async () => {
    const ctx = makeDeps();
    const res = await handleChat({ model: "opencode/claude-sonnet-4.5" }, ctx.deps);
    expect(res.status).toBe(402);
  });

  test("free-tier model passes the gate", async () => {
    const ctx = makeDeps();
    addConn(ctx, "opencode", "echo");
    const res = await handleChat({ model: "opencode/mimo-v2.5-free" }, ctx.deps);
    expect(res.status).toBe(200);
  });

  test("unknown model fails safe → 402", async () => {
    const ctx = makeDeps();
    const res = await handleChat({ model: "opencode/some-unknown-model" }, ctx.deps);
    expect(res.status).toBe(402);
  });
});

describe("reasoning effort (thinking mode)", () => {
  test("effort alias suffix → base model + reasoning_effort", async () => {
    const ctx = makeDeps();
    addConn(ctx, "deepseek", "echo");
    const res = await handleChat({ model: "deepseek/deepseek-reasoner-high", messages: [] }, ctx.deps);
    expect(res.status).toBe(200);
    const p = lastPayload as { model: string; reasoning_effort?: string };
    expect(p.model).toBe("deepseek-reasoner");
    expect(p.reasoning_effort).toBe("high");
  });

  test("alias not stripped from non-reasoning base ids", async () => {
    const ctx = makeDeps();
    addConn(ctx, "openai", "echo");
    const res = await handleChat({ model: "openai/gpt-4o-high", messages: [] }, ctx.deps);
    expect(res.status).toBe(200);
    const p = lastPayload as { model: string; reasoning_effort?: string };
    expect(p.model).toBe("gpt-4o-high");
    expect(p.reasoning_effort).toBeUndefined();
  });

  test("client reasoning_effort dropped for non-reasoning models", async () => {
    const ctx = makeDeps();
    addConn(ctx, "openai", "echo");
    await handleChat({ model: "openai/gpt-4o", reasoning_effort: "high", messages: [] }, ctx.deps);
    const p = lastPayload as { reasoning_effort?: string };
    expect(p.reasoning_effort).toBeUndefined();
  });

  test("client reasoning_effort preserved for reasoning models", async () => {
    const ctx = makeDeps();
    addConn(ctx, "openai", "echo");
    await handleChat({ model: "openai/o3-mini", reasoning_effort: "high", messages: [] }, ctx.deps);
    const p = lastPayload as { model: string; reasoning_effort?: string };
    expect(p.model).toBe("o3-mini");
    expect(p.reasoning_effort).toBe("high");
  });

  test("effort alias works inside combos", async () => {
    const ctx = makeDeps();
    ctx.store.putCombo("think", ["openai/o3-mini-high"]);
    addConn(ctx, "openai", "echo");
    await handleChat({ model: "think", messages: [] }, ctx.deps);
    const p = lastPayload as { model: string; reasoning_effort?: string };
    expect(p.model).toBe("o3-mini");
    expect(p.reasoning_effort).toBe("high");
  });
});
