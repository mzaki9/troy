import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { CooldownStore, parseRetryAfter } from "../src/proxy/cooldown";
import { registerCustomProvider, unregisterCustomProvider } from "../src/proxy/registry";
import { type ChatDeps, handleChat, type LogRow } from "../src/proxy/route";
import { takeHead } from "../src/proxy/stream";
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
    if (key === "echo") {
      return Response.json({ echo: JSON.parse(text), key }, { status: 200 });
    }
    if (key === "dead") {
      // 200 whose body dies before emitting anything
      return new Response(
        new ReadableStream({
          start(c) {
            c.error(new Error("connection reset by peer"));
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }
    if (key === "empty") {
      return new Response(
        new ReadableStream({
          start(c) {
            c.close();
          },
        }),
        { status: 200 },
      );
    }
    const b = behaviors.get(key);
    if (b?.headers?.["content-type"] === "text/event-stream") {
      return new Response(b.body, { status: b.status, headers: { "content-type": "text/event-stream" } });
    }
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

function addConn(ctx: ReturnType<typeof makeDeps>, provider: string, key: string, priority = 0) {
  ctx.store.addConnection({ provider, api_key: key, base_url: stubUrl, priority });
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
    // failure log names the attempted member, not a blanket "unknown"
    expect(ctx.logs[0].provider).toBe("openai");
    expect(ctx.logs[0].model).toBe("gpt-4o");
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

  test("503 explains the upstream reason when an account is locked", async () => {
    behaviors.set("rl", {
      status: 429,
      body: JSON.stringify({
        error: { message: "Rate limit exceeded. Please try again later.", type: "FreeUsageLimitError" },
      }),
    });
    const ctx = makeDeps();
    addConn(ctx, "openai", "rl");
    await handleChat({ model: "openai/gpt-4o", message: "hi" }, ctx.deps); // first attempt fails → locks account
    const second = await handleChat({ model: "openai/gpt-4o", message: "hi" }, ctx.deps);
    expect(second.status).toBe(503);
    const body = await second.text();
    expect(body).toContain("Rate limit exceeded");
    expect(body).toContain("FreeUsageLimitError");
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

describe("combo strategies", () => {
  function comboWith(ctx: ReturnType<typeof makeDeps>, strategy: string, specs: string[]) {
    ctx.store.putCombo("s", specs, strategy);
    return ctx;
  }

  test("random stays within the chain", async () => {
    const ctx = comboWith(makeDeps(), "random", ["openai/gpt-4o", "deepseek/deepseek-chat", "mistral/mistral-large"]);
    for (const p of ["openai", "deepseek", "mistral"]) addConn(ctx, p, "ok");
    behaviors.set("ok", { status: 200, body: JSON.stringify({ ok: true }) });
    for (let i = 0; i < 20; i++) {
      const res = await handleChat({ model: "s", message: "hi" }, ctx.deps);
      expect(res.status).toBe(200);
    }
  });

  test("round-robin rotates the start spec across requests", async () => {
    const ctx = comboWith(makeDeps(), "round-robin", [
      "openai/gpt-4o",
      "deepseek/deepseek-chat",
      "mistral/mistral-large",
    ]);
    for (const p of ["openai", "deepseek", "mistral"]) addConn(ctx, p, "ok");
    behaviors.set("ok", { status: 200, body: JSON.stringify({ ok: true }) });
    // 3 requests → each start index hits once; capture the order of lastPayload.model
    const models: string[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await handleChat({ model: "s", message: "hi" }, ctx.deps);
      expect(res.status).toBe(200);
      models.push((lastPayload as { model: string }).model);
    }
    expect(models).toEqual(["gpt-4o", "deepseek-chat", "mistral-large"]);
  });
});

describe("circuit breaker", () => {
  test("3 failures in window opens → member skipped on next request", async () => {
    const ctx = makeDeps();
    ctx.store.putCombo("cb", ["openai/gpt-4o", "deepseek/deepseek-chat"]);
    addConn(ctx, "openai", "bad");
    addConn(ctx, "deepseek", "good");
    behaviors.set("bad", { status: 500, body: "boom" });
    behaviors.set("good", { status: 200, body: JSON.stringify({ ok: true }) });
    // first 3 requests: openai fails 3× → circuit opens
    for (let i = 0; i < 3; i++) {
      await handleChat({ model: "cb", message: "hi" }, ctx.deps);
    }
    // 4th request: openai open → immediately deepseek
    const res = await handleChat({ model: "cb", message: "hi" }, ctx.deps);
    expect(res.status).toBe(200);
    expect((lastPayload as { model: string }).model).toBe("deepseek-chat");
  });

  test("single failure does not trip the breaker", async () => {
    const ctx = makeDeps();
    ctx.store.putCombo("cb", ["openai/gpt-4o", "deepseek/deepseek-chat"]);
    addConn(ctx, "openai", "bad");
    addConn(ctx, "deepseek", "good");
    behaviors.set("bad", { status: 500, body: "boom" });
    behaviors.set("good", { status: 200, body: JSON.stringify({ ok: true }) });
    await handleChat({ model: "cb", message: "hi" }, ctx.deps);
    // single failure → breaker not open (account cooldown is separate)
    expect(ctx.cd.isOpen("openai/gpt-4o")).toBe(false);
  });
});

describe("streaming failover + usage capture", () => {
  test("200 with dying body falls through to the next account", async () => {
    behaviors.set("good", { status: 200, body: JSON.stringify({ ok: true }) });
    const ctx = makeDeps();
    addConn(ctx, "openai", "dead");
    addConn(ctx, "openai", "good");
    const res = await handleChat({ model: "openai/gpt-4o", stream: true, messages: [] }, ctx.deps);
    expect(res.status).toBe(200);
    await res.text(); // drain — stream logs are deferred to end of body
    expect(ctx.logs[0].status).toBe("200 OK");
    expect(ctx.logs[0].provider).toBe("openai");
  });

  test("empty 200 body falls through (non-stream)", async () => {
    behaviors.set("good", { status: 200, body: JSON.stringify({ ok: true }) });
    const ctx = makeDeps();
    addConn(ctx, "openai", "empty");
    addConn(ctx, "openai", "good");
    const res = await handleChat({ model: "openai/gpt-4o", messages: [] }, ctx.deps);
    expect(res.status).toBe(200);
  });

  test("usage captured from JSON responses", async () => {
    behaviors.set("tok", {
      status: 200,
      body: JSON.stringify({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 7 } }),
    });
    const ctx = makeDeps();
    addConn(ctx, "openai", "tok");
    await handleChat({ model: "openai/gpt-4o", messages: [] }, ctx.deps);
    expect(ctx.logs[0].tokens).toEqual({ prompt_tokens: 11, completion_tokens: 7 });
  });

  test("usage captured from the final SSE chunk (log deferred to stream end)", async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"hi"}}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2}}',
      "data: [DONE]",
      "",
    ].join("\n\n");
    behaviors.set("sse-tok", { status: 200, headers: { "content-type": "text/event-stream" }, body: sse });
    const ctx = makeDeps();
    addConn(ctx, "openai", "sse-tok");
    const res = await handleChat({ model: "openai/gpt-4o", stream: true, messages: [] }, ctx.deps);
    expect(res.status).toBe(200);
    await res.text(); // drain — the deferred log fires at end of body
    expect(ctx.logs[0].tokens).toEqual({ prompt_tokens: 5, completion_tokens: 2 });
  });

  test("streaming requests ask upstream for usage (stream_options injection)", async () => {
    behaviors.set("sse-tok", {
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: "data: [DONE]\n\n",
    });
    const ctx = makeDeps();
    addConn(ctx, "openai", "sse-tok");
    await handleChat({ model: "openai/gpt-4o", stream: true, messages: [] }, ctx.deps);
    expect(lastPayload).toMatchObject({ stream_options: { include_usage: true } });
  });

  test("client-supplied stream_options are preserved verbatim", async () => {
    behaviors.set("sse-tok", {
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: "data: [DONE]\n\n",
    });
    const ctx = makeDeps();
    addConn(ctx, "openai", "sse-tok");
    await handleChat(
      { model: "openai/gpt-4o", stream: true, messages: [], stream_options: { include_usage: false } },
      ctx.deps,
    );
    expect(lastPayload).toMatchObject({ stream_options: { include_usage: false } });
  });

  test("non-streaming requests are not touched by the usage flag", async () => {
    behaviors.set("tok", { status: 200, body: JSON.stringify({ choices: [], usage: {} }) });
    const ctx = makeDeps();
    addConn(ctx, "openai", "tok");
    await handleChat({ model: "openai/gpt-4o", messages: [] }, ctx.deps);
    expect(lastPayload).not.toHaveProperty("stream_options");
  });

  test("anthropic-dialect usage is normalized onto prompt/completion keys", async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"hi"}}]}',
      'data: {"choices":[],"usage":{"input_tokens":7,"output_tokens":3}}',
      "data: [DONE]",
      "",
    ].join("\n\n");
    behaviors.set("sse-anth", { status: 200, headers: { "content-type": "text/event-stream" }, body: sse });
    const ctx = makeDeps();
    addConn(ctx, "openai", "sse-anth");
    const res = await handleChat({ model: "openai/gpt-4o", stream: true, messages: [] }, ctx.deps);
    await res.text();
    expect(ctx.logs[0].tokens).toMatchObject({ prompt_tokens: 7, completion_tokens: 3 });
  });

  test("mid-stream death surfaces an SSE error frame (takeHead unit)", async () => {
    const enc = new TextEncoder();
    let sent = false;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        if (!sent) {
          sent = true;
          c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));
        } else {
          c.error(new Error("mid-stream reset"));
        }
      },
    });
    const head = await takeHead(new Response(body, { headers: { "content-type": "text/event-stream" } }), true);
    expect(head.error).toBeNull();
    const text = await head.res.text();
    expect(text).toContain('"partial"');
    expect(text).toContain("mid-stream reset");
  });

  test("takeHead flags immediately-empty bodies", async () => {
    const head = await takeHead(
      new Response(
        new ReadableStream({
          start(c) {
            c.close();
          },
        }),
      ),
      false,
    );
    expect(head.error).toBe("upstream returned an empty body");
  });
});

describe("errors", () => {
  test("unknown provider → 404", async () => {
    const ctx = makeDeps();
    const res = await handleChat({ model: "nope/x", message: "hi" }, ctx.deps);
    expect(res.status).toBe(404);
    expect(ctx.logs[0].provider).toBe("nope");
  });
  test("combo all-fail logs the last attempted member", async () => {
    behaviors.set("bad", { status: 500, body: "boom" });
    const ctx = makeDeps();
    ctx.store.putCombo("f", ["openai/gpt-4o", "deepseek/deepseek-chat"]);
    addConn(ctx, "openai", "bad");
    addConn(ctx, "deepseek", "bad");
    const res = await handleChat({ model: "f", message: "hi" }, ctx.deps);
    expect(res.status).toBe(503);
    expect(ctx.logs[0].provider).toBe("deepseek");
    expect(ctx.logs[0].model).toBe("deepseek-chat");
    expect(ctx.logs[0].combo).toBe("f");
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
    const sse = 'data: {"id":"1","object":"chat.completion.chunk"}\n\ndata: [DONE]\n\n';
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
        messages: [
          { role: "user", content: "look" },
          { role: "tool", tool_call_id: "1", content: toolContent },
        ],
      },
      ctx.deps,
    );
    const forwarded = (lastPayload as { messages: { role: string; content: string }[] }).messages.find(
      (m) => m.role === "tool",
    );
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
        messages: [
          { role: "assistant", content: [{ type: "tool_result", tool_use_id: "1", is_error: true, text: big }] },
        ],
      },
      ctx.deps,
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
describe("opencode keyless (no gate, upstream-authoritative)", () => {
  test("free model routes keyless with no stored connection", async () => {
    // synthetic opencode-keyless uses real zen URL — stub it via addConnection to avoid network
    behaviors.set("echo", { status: 200, body: JSON.stringify({ ok: true }) });
    const ctx = makeDeps();
    addConn(ctx, "opencode", "echo");
    const res = await handleChat({ model: "opencode/mimo-v2.5-free", messages: [] }, ctx.deps);
    expect(res.status).toBe(200);
  });

  test("big-pickle routes keyless with no stored connection", async () => {
    behaviors.set("echo", { status: 200, body: JSON.stringify({ ok: true }) });
    const ctx = makeDeps();
    addConn(ctx, "opencode", "echo");
    const res = await handleChat({ model: "opencode/big-pickle", messages: [] }, ctx.deps);
    expect(res.status).toBe(200);
  });

  test("premium model also routes keyless (no local 402 — upstream decides)", async () => {
    behaviors.set("echo", { status: 200, body: JSON.stringify({ ok: true }) });
    const ctx = makeDeps();
    addConn(ctx, "opencode", "echo");
    const res = await handleChat({ model: "opencode/claude-sonnet-4.5", messages: [] }, ctx.deps);
    expect(res.status).toBe(200);
  });

  test("unknown model also routes keyless", async () => {
    behaviors.set("echo", { status: 200, body: JSON.stringify({ ok: true }) });
    const ctx = makeDeps();
    addConn(ctx, "opencode", "echo");
    const res = await handleChat({ model: "opencode/some-unknown-model", messages: [] }, ctx.deps);
    expect(res.status).toBe(200);
  });

  test("keyless provider works with no stored connection", async () => {
    behaviors.set("", { status: 200, body: JSON.stringify({ ok: true }) });
    const ctx = makeDeps();
    registerCustomProvider({
      id: "keyless-test",
      aliases: ["keyless-test"],
      name: "Keyless",
      baseUrl: stubUrl,
      auth: "none",
    });
    try {
      const res = await handleChat({ model: "keyless-test/mimo", messages: [] }, ctx.deps);
      expect(res.status).toBe(200);
      const payload = lastPayload as { model?: string };
      expect(payload.model).toBe("mimo");
      expect(ctx.logs).toHaveLength(1);
      expect(ctx.logs[0].status).toBe("200 OK");
    } finally {
      unregisterCustomProvider("keyless-test");
    }
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

describe("statsDaily (7d chart feed)", () => {
  test("buckets requests per local day + model, zero-filled window", () => {
    const { store } = makeDeps();
    const now = new Date();
    // local noon — safe from tz day-boundary shifts
    const at = (daysAgo: number) => {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo, 12, 0, 0);
      return d.toISOString();
    };
    const ins = store.raw.query(
      "INSERT INTO usage_history (ts, provider, model, combo, status, latency_ms, tokens) VALUES (?, ?, ?, NULL, '200 OK', 0, '{}')",
    );
    const log = (daysAgo: number, model: string) => ins.run(at(daysAgo), "openai", model);
    log(0, "gpt-4o");
    log(0, "gpt-4o");
    log(0, "deepseek-chat");
    log(1, "gpt-4o");
    log(6, "llama-3.3");
    log(9, "gpt-4o"); // outside the 7d window — must be excluded

    const res = store.statsDaily(7);
    expect(res.days).toHaveLength(7);
    expect(res.days[0].day).toBe(at(6).slice(0, 10)); // window starts 6 days ago
    expect(res.days[6].day).toBe(at(0).slice(0, 10)); // ends today
    const counts = (d: (typeof res.days)[number]) => Object.fromEntries(d.models.map((m) => [m.model, m.requests]));
    expect(counts(res.days[6])).toEqual({ "gpt-4o": 2, "deepseek-chat": 1 });
    expect(counts(res.days[5])).toEqual({ "gpt-4o": 1 });
    expect(counts(res.days[0])).toEqual({ "llama-3.3": 1 });
    const total = res.days.reduce((s, d) => s + d.models.reduce((x, m) => x + m.requests, 0), 0);
    expect(total).toBe(5);
  });
});

describe("cooldown management (dsh-derived)", () => {
  test("parseRetryAfter: seconds, HTTP-date, garbage", () => {
    expect(parseRetryAfter("5")).toBe(5000);
    const future = new Date(Date.now() + 60_000).toUTCString();
    const v = parseRetryAfter(future)!;
    expect(v).toBeGreaterThan(50_000);
    expect(v).toBeLessThanOrEqual(60_000);
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter("soon")).toBeNull();
  });

  test("quota death locks long without backoff escalation", () => {
    const cd = new CooldownStore();
    cd.fail("c1", "m", 402, "insufficient balance");
    expect(cd.backoffLevel("c1")).toBe(0); // no escalation — retrying sooner never helps
    const lock = cd.lockExpiry("c1", "m") - Date.now();
    expect(lock).toBeGreaterThan(100_000); // ~120s, not the 2s backoff base
  });

  test("rate limit escalates backoff with ±10% jitter", () => {
    for (let i = 0; i < 20; i++) {
      const cd = new CooldownStore();
      cd.fail("c1", "m", 429, "rate limit exceeded");
      expect(cd.backoffLevel("c1")).toBe(1);
      const lock = cd.lockExpiry("c1", "m") - Date.now();
      expect(lock).toBeGreaterThanOrEqual(1800);
      expect(lock).toBeLessThanOrEqual(2200);
    }
  });

  test("upstream Retry-After header wins over local backoff", async () => {
    behaviors.set("ra", { status: 429, headers: { "retry-after": "1" }, body: "{}" });
    const ctx = makeDeps();
    addConn(ctx, "openai", "ra");
    await handleChat({ model: "openai/gpt-4o", message: "hi" }, ctx.deps);
    const id = ctx.store.listConnections("openai")[0].id;
    const lock = ctx.cd.lockExpiry(id, "gpt-4o") - Date.now();
    expect(lock).toBeGreaterThan(0);
    expect(lock).toBeLessThanOrEqual(1100); // honored verbatim, not the 2s backoff base
  });

  test("replay folds the event log back into live state", () => {
    const events: StateEvent[] = [];
    const cd = new CooldownStore({ append: (e) => events.push(e) });
    cd.fail("c1", "m1", 429, "rate limit exceeded");
    cd.success("c1", "m1");
    cd.fail("c2", "m2", 402, "insufficient balance");
    for (let i = 0; i < 3; i++) cd.fail("c3", "m3", 500, "boom", "prov/m3"); // opens circuit

    const cd2 = CooldownStore.replay(events);
    expect(cd2.isEligible("c1", "m1")).toBe(true); // success cleared it
    expect(cd2.isEligible("c2", "m2")).toBe(false);
    expect(cd2.lockExpiry("c2", "m2")).toBe(cd.lockExpiry("c2", "m2")); // exact until_ms restored
    expect(cd2.isOpen("prov/m3")).toBe(true);

    // expired entries are dropped on fold
    const cd3 = CooldownStore.replay([
      { ts: Date.now(), kind: "fail", conn_id: "c4", key: "m4", until_ms: Date.now() - 1000, backoff_level: 2 },
    ]);
    expect(cd3.isEligible("c4", "m4")).toBe(true);
  });
});

describe("capability preflight", () => {
  test("tools request skips members known to lack tool_call", async () => {
    behaviors.set("good", { status: 200, body: JSON.stringify({ ok: true }) });
    const ctx = makeDeps();
    addConn(ctx, "openai", "good");
    const res = await handleChat(
      {
        model: "openai/gpt-3.5-turbo",
        messages: [{ role: "user", content: "hi" }],
        tools: [{ type: "function", function: { name: "f", parameters: {} } }],
      },
      ctx.deps,
    );
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("preflight: no tools");
  });

  test("image input skips text-only members", async () => {
    behaviors.set("good", { status: 200, body: JSON.stringify({ ok: true }) });
    const ctx = makeDeps();
    addConn(ctx, "openai", "good");
    const res = await handleChat(
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
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("preflight: no vision");
  });

  test("unknown models stay eligible (regex floor defaults)", async () => {
    behaviors.set("good", { status: 200, body: JSON.stringify({ ok: true }) });
    const ctx = makeDeps();
    addConn(ctx, "openai", "good");
    const res = await handleChat(
      {
        model: "openai/gpt-4o",
        messages: [{ role: "user", content: "hi" }],
        tools: [{ type: "function", function: { name: "f", parameters: {} } }],
      },
      ctx.deps,
    );
    expect(res.status).toBe(200);
  });
});
