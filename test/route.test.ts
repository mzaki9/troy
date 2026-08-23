import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { CooldownStore, parseRetryAfter } from "../src/proxy/cooldown";
import { registerCustomProvider, unregisterCustomProvider } from "../src/proxy/registry";
import { type ChatDeps, handleChat, type LogRow } from "../src/proxy/route";
import type { StateEvent } from "../src/store/db";
import { Store } from "../src/store/db";

interface StubBehavior {
  status: number;
  headers?: Record<string, string>;
  body: string;
}

let stubUrl = "";
const behaviors = new Map<string, StubBehavior>();
let lastPayload: unknown = null;

const stub = Bun.serve({
  port: 0,
  async fetch(req) {
    const auth = req.headers.get("authorization") ?? "";
    const key = auth.replace(/^Bearer /, "");
    const text = await req.text();
    lastPayload = JSON.parse(text);
    if (key === "echo") return Response.json({ echo: JSON.parse(text), key }, { status: 200 });
    if (key === "dead")
      return new Response(
        new ReadableStream({
          start(c) {
            c.error(new Error("connection reset by peer"));
          },
        }),
        {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        },
      );
    if (key === "empty")
      return new Response(
        new ReadableStream({
          start(c) {
            c.close();
          },
        }),
        { status: 200 },
      );
    if (key === "midstream") {
      const enc = (s: string) => new TextEncoder().encode(s);
      return new Response(
        new ReadableStream({
          async start(c) {
            c.enqueue(enc('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n'));
            await new Promise((r) => setTimeout(r, 10));
            c.enqueue(enc('data: {"choices":[{"delta":{"content":"lo"}}]}\n\n'));
            c.error(new Error("connection reset by peer"));
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }
    const b = behaviors.get(key);
    if (b?.headers?.["content-type"] === "text/event-stream")
      return new Response(b.body, { status: b.status, headers: { "content-type": "text/event-stream" } });
    return new Response(b?.body ?? "{}", {
      status: b?.status ?? 200,
      headers: { "content-type": "application/json", ...(b?.headers ?? {}) },
    });
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
  return {
    store,
    cd,
    deps: {
      store,
      cooldowns: cd,
      strategy: "fill-first",
      rtkOn: false,
      cavemanLevel: "off",
      ponytailLevel: "off",
      onLog: (r) => logs.push(r),
      ...overrides,
    },
    logs,
  };
}
function addConn(ctx: ReturnType<typeof makeDeps>, provider: string, key: string, priority = 0) {
  ctx.store.addConnection({ provider, api_key: key, base_url: stubUrl, priority });
}

describe("multi-account rotation + combo fallback (integrated)", () => {
  test("429→next succeeds, all fail→503 with retry-after, and combo walks", async () => {
    behaviors.set("bad", { status: 429, body: JSON.stringify({ error: { message: "rate limit exceeded" } }) });
    behaviors.set("good", { status: 200, body: JSON.stringify({ ok: true }) });
    const ctx = makeDeps();
    addConn(ctx, "openai", "bad");
    addConn(ctx, "openai", "good");
    expect((await handleChat({ model: "openai/gpt-4o", message: "hi" }, ctx.deps)).status).toBe(200);

    const ctx2 = makeDeps();
    addConn(ctx2, "openai", "bad");
    addConn(ctx2, "openai", "bad");
    const res2 = await handleChat({ model: "openai/gpt-4o", message: "hi" }, ctx2.deps);
    expect(res2.status).toBe(503);
    expect(res2.headers.get("retry-after")).not.toBeNull();
    expect(ctx2.logs[0].provider).toBe("openai");

    const ctx3 = makeDeps();
    ctx3.store.putCombo("t", ["openai/gpt-4o", "deepseek/deepseek-chat"]);
    addConn(ctx3, "openai", "bad");
    addConn(ctx3, "deepseek", "good");
    expect((await handleChat({ model: "t", message: "hi" }, ctx3.deps)).status).toBe(200);
  });
});

describe("strategies (integrated)", () => {
  test("random stays in chain and round-robin rotates", async () => {
    behaviors.clear();
    behaviors.set("ok", { status: 200, body: JSON.stringify({ ok: true }) });
    const ctx = makeDeps();
    ctx.store.putCombo("s", ["openai/gpt-4o", "deepseek/deepseek-chat", "mistral/mistral-large"], "random");
    for (const p of ["openai", "deepseek", "mistral"]) addConn(ctx, p, "ok");
    for (let i = 0; i < 5; i++) expect((await handleChat({ model: "s", message: "hi" }, ctx.deps)).status).toBe(200);

    const ctx2 = makeDeps();
    ctx2.store.putCombo("s", ["openai/gpt-4o", "deepseek/deepseek-chat", "mistral/mistral-large"], "round-robin");
    for (const p of ["openai", "deepseek", "mistral"]) addConn(ctx2, p, "ok");
    const models: string[] = [];
    for (let i = 0; i < 3; i++) {
      expect((await handleChat({ model: "s", message: "hi" }, ctx2.deps)).status).toBe(200);
      models.push((lastPayload as { model: string }).model);
    }
    expect(models).toEqual(["gpt-4o", "deepseek-chat", "mistral-large"]);
  });
});

describe("circuit breaker (integrated)", () => {
  test("3 failures opens circuit → next request skips to next member", async () => {
    behaviors.clear();
    behaviors.set("bad", { status: 500, body: "boom" });
    behaviors.set("good", { status: 200, body: JSON.stringify({ ok: true }) });
    const ctx3 = makeDeps();
    ctx3.store.putCombo("cb", ["openai/gpt-4o", "deepseek/deepseek-chat"]);
    addConn(ctx3, "openai", "bad");
    addConn(ctx3, "deepseek", "good");
    for (let i = 0; i < 3; i++) await handleChat({ model: "cb", message: "hi" }, ctx3.deps);
    const res = await handleChat({ model: "cb", message: "hi" }, ctx3.deps);
    expect(res.status).toBe(200);
    expect((lastPayload as { model: string }).model).toBe("deepseek-chat");
  });
});

describe("streaming failover + usage (integrated)", () => {
  test("dying/empty/mid-stream failover, usage capture, stream_options injection", async () => {
    behaviors.set("good", { status: 200, body: JSON.stringify({ ok: true }) });
    const ctx = makeDeps();
    addConn(ctx, "openai", "dead");
    addConn(ctx, "openai", "good");
    const r1 = await handleChat({ model: "openai/gpt-4o", stream: true, messages: [] }, ctx.deps);
    expect(r1.status).toBe(200);
    await r1.text();
    expect(ctx.logs[0].status).toBe("200 OK");

    const ctx2 = makeDeps();
    addConn(ctx2, "openai", "midstream");
    const conn = ctx2.store.listConnections("openai")[0];
    const r2 = await handleChat({ model: "openai/gpt-4o", stream: true, messages: [] }, ctx2.deps);
    const t2 = await r2.text();
    expect(t2).toContain('"content":"Hel"');
    expect(t2).toContain('"code":"bad_gateway"');
    expect(ctx2.cd.isEligible(conn.id, "gpt-4o")).toBe(false);

    behaviors.set("tok", {
      status: 200,
      body: JSON.stringify({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 7 } }),
    });
    const ctx3 = makeDeps();
    addConn(ctx3, "openai", "tok");
    await handleChat({ model: "openai/gpt-4o", messages: [] }, ctx3.deps);
    expect(ctx3.logs[0].tokens).toEqual({ prompt_tokens: 11, completion_tokens: 7 });

    const sse =
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\ndata: [DONE]\n\n';
    behaviors.set("sse-tok", { status: 200, headers: { "content-type": "text/event-stream" }, body: sse });
    const ctx4 = makeDeps();
    addConn(ctx4, "openai", "sse-tok");
    const r4 = await handleChat({ model: "openai/gpt-4o", stream: true, messages: [] }, ctx4.deps);
    await r4.text();
    expect(ctx4.logs[0].tokens).toEqual({ prompt_tokens: 5, completion_tokens: 2 });
    expect((lastPayload as { stream_options: { include_usage: boolean } }).stream_options).toEqual({
      include_usage: true,
    });

    behaviors.set("tok2", { status: 200, body: JSON.stringify({ choices: [], usage: {} }) });
    const ctx5 = makeDeps();
    addConn(ctx5, "openai", "tok2");
    await handleChat({ model: "openai/gpt-4o", messages: [] }, ctx5.deps);
    expect(lastPayload).not.toHaveProperty("stream_options");
  });
});

describe("errors + passthrough (integrated)", () => {
  test("404/400 and SSE byte-identical", async () => {
    const ctx = makeDeps();
    expect((await handleChat({ model: "nope/x", message: "hi" }, ctx.deps)).status).toBe(404);
    expect((await handleChat({ message: "hi" } as never, ctx.deps)).status).toBe(400);
    expect((await handleChat({ model: "openai/gpt-4o" }, ctx.deps)).status).toBe(404);

    const sse = 'data: {"id":"1","object":"chat.completion.chunk"}\n\ndata: [DONE]\n\n';
    behaviors.set("sse", { status: 200, headers: { "content-type": "text/event-stream" }, body: sse });
    const ctx2 = makeDeps();
    addConn(ctx2, "openai", "sse");
    const res = await handleChat({ model: "openai/gpt-4o", stream: true }, ctx2.deps);
    expect(await res.text()).toBe(sse);
  });
});

describe("rtk + inject + keyless + reasoning (integrated)", () => {
  test("RTK compress, caveman inject, keyless, and reasoning_effort", async () => {
    behaviors.set("echo", { status: 200, body: "{}" });
    const ctx = makeDeps({ rtkOn: true });
    addConn(ctx, "openai", "echo");
    const rows = Array.from({ length: 300 }, (_, i) => `-rw-r--r--  1 u g ${1000 + i} Jan 01 10:00 file${i}.rs`).join(
      "\n",
    );
    await handleChat(
      {
        model: "openai/gpt-4o",
        messages: [
          { role: "user", content: "look" },
          { role: "tool", tool_call_id: "1", content: rows },
        ],
      },
      ctx.deps,
    );
    const fwd = (lastPayload as { messages: { role: string; content: string }[] }).messages.find(
      (m) => m.role === "tool",
    )!;
    expect(fwd.content.length).toBeLessThan(rows.length);

    const ctx2 = makeDeps({ cavemanLevel: "full" });
    addConn(ctx2, "openai", "echo");
    await handleChat({ model: "openai/gpt-4o", messages: [{ role: "user", content: "hi" }] }, ctx2.deps);
    const sys = (lastPayload as { messages: { role?: string; content?: string }[] }).messages.find(
      (m) => m.role === "system",
    );
    expect(sys?.content).toContain("caveman");

    const ctx3 = makeDeps();
    addConn(ctx3, "opencode", "echo");
    expect((await handleChat({ model: "opencode/mimo-v2.5-free", messages: [] }, ctx3.deps)).status).toBe(200);
    expect((await handleChat({ model: "opencode/claude-sonnet-4.5", messages: [] }, ctx3.deps)).status).toBe(200);
    behaviors.set("", { status: 200, body: JSON.stringify({ ok: true }) });
    const ctx4 = makeDeps();
    registerCustomProvider({
      id: "keyless-test",
      aliases: ["keyless-test"],
      name: "Keyless",
      baseUrl: stubUrl,
      auth: "none",
    });
    try {
      expect((await handleChat({ model: "keyless-test/mimo", messages: [] }, ctx4.deps)).status).toBe(200);
    } finally {
      unregisterCustomProvider("keyless-test");
    }

    const ctx5 = makeDeps();
    addConn(ctx5, "deepseek", "echo");
    await handleChat({ model: "deepseek/deepseek-reasoner-high", messages: [] }, ctx5.deps);
    const p = lastPayload as { model: string; reasoning_effort?: string };
    expect(p.model).toBe("deepseek-reasoner");
    expect(p.reasoning_effort).toBe("high");
    const ctx6 = makeDeps();
    addConn(ctx6, "openai", "echo");
    await handleChat({ model: "openai/gpt-4o", reasoning_effort: "high", messages: [] }, ctx6.deps);
    expect((lastPayload as { reasoning_effort?: string }).reasoning_effort).toBeUndefined();
  });
});

describe("cooldown + preflight (integrated)", () => {
  test("parseRetryAfter, quota vs rate backoff, replay, and preflight skips", async () => {
    expect(parseRetryAfter("5")).toBe(5000);
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter("soon")).toBeNull();

    const cd = new CooldownStore();
    cd.fail("c1", "m", 402, "insufficient balance");
    expect(cd.backoffLevel("c1")).toBe(0);
    expect(cd.lockExpiry("c1", "m") - Date.now()).toBeGreaterThan(100000);

    const cd2 = new CooldownStore();
    cd2.fail("c1", "m", 429, "rate limit exceeded");
    expect(cd2.backoffLevel("c1")).toBe(1);

    const events: StateEvent[] = [];
    const src = new CooldownStore({ append: (e) => events.push(e) });
    src.fail("c1", "m1", 429, "rate limit exceeded");
    src.success("c1", "m1");
    src.fail("c2", "m2", 402, "insufficient balance");
    for (let i = 0; i < 3; i++) src.fail("c3", "m3", 500, "boom", "prov/m3");
    const replayed = CooldownStore.replay(events);
    expect(replayed.isEligible("c1", "m1")).toBe(true);
    expect(replayed.isEligible("c2", "m2")).toBe(false);
    expect(replayed.isOpen("prov/m3")).toBe(true);

    behaviors.set("good", { status: 200, body: JSON.stringify({ ok: true }) });
    const ctx = makeDeps();
    addConn(ctx, "openai", "good");
    const r1 = await handleChat(
      {
        model: "openai/gpt-3.5-turbo",
        messages: [{ role: "user", content: "hi" }],
        tools: [{ type: "function", function: { name: "f", parameters: {} } }],
      },
      ctx.deps,
    );
    expect(r1.status).toBe(503);
    expect(await r1.text()).toContain("preflight: no tools");
    const r2 = await handleChat(
      {
        model: "openai/gpt-3.5-turbo",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "look" },
              { type: "image_url", image_url: { url: "data:image/png;base64,x" } },
            ],
          },
        ],
      },
      ctx.deps,
    );
    expect(r2.status).toBe(503);
    expect(
      (
        await handleChat(
          {
            model: "openai/gpt-4o",
            messages: [{ role: "user", content: "hi" }],
            tools: [{ type: "function", function: { name: "f", parameters: {} } }],
          },
          ctx.deps,
        )
      ).status,
    ).toBe(200);
  });
});
