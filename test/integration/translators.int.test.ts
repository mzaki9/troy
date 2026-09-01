import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createTestTroy, type TestTroy } from "../helpers/troy";

let t: TestTroy;
beforeEach(() => {
  t = createTestTroy();
});
afterEach(() => {
  t.stop();
});

describe("Anthropic + Responses translation via HTTP (integrated)", () => {
  test("anthropic system/tool/image/thinking → chat, and chat→anthropic blocks", async () => {
    t.upstream.setBehavior("sk", { status: 200, body: JSON.stringify({ choices: [{ message: { content: "ok" } }] }) });
    t.addConnection("openai", "sk");
    // system
    await t.fetch("/v1/messages", {
      method: "POST",
      body: JSON.stringify({ model: "openai/gpt-4o", system: "be terse", messages: [{ role: "user", content: "hi" }] }),
    });
    expect((t.upstream.getLastPayload() as { messages: { role: string }[] }).messages[0].role).toBe("system");
    // tool roundtrip
    await t.fetch("/v1/messages", {
      method: "POST",
      body: JSON.stringify({
        model: "openai/gpt-4o",
        messages: [
          { role: "user", content: "run ls" },
          { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "ls", input: { path: "/" } }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "files…" }] },
        ],
        tools: [{ name: "ls", description: "list", input_schema: { type: "object" } }],
      }),
    });
    expect((t.upstream.getLastPayload() as { tools: unknown[] }).tools).toBeDefined();
    // image
    await t.fetch("/v1/messages", {
      method: "POST",
      body: JSON.stringify({
        model: "openai/gpt-4o",
        messages: [
          {
            role: "user",
            content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } }],
          },
        ],
      }),
    });
    expect(JSON.stringify(t.upstream.getLastPayload())).toContain("data:image/png;base64,AAA");
    // thinking on reasoning model
    await t.fetch("/v1/messages", {
      method: "POST",
      body: JSON.stringify({
        model: "openai/o3-mini",
        messages: [{ role: "user", content: "hi" }],
        thinking: { type: "enabled", budget_tokens: 32000 },
      }),
    });
    expect((t.upstream.getLastPayload() as { reasoning_effort?: string }).reasoning_effort).toBe("high");
    // response back: tool_calls + usage
    t.upstream.setBehavior("sk", {
      status: 200,
      body: JSON.stringify({
        choices: [
          {
            message: {
              content: "doing it",
              tool_calls: [{ id: "c1", type: "function", function: { name: "ls", arguments: "{}" } }],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 4 },
      }),
    });
    const res = await t.fetch("/v1/messages", {
      method: "POST",
      body: JSON.stringify({ model: "openai/gpt-4o", messages: [{ role: "user", content: "hi" }] }),
    });
    const body = (await res.json()) as { content: { type: string }[]; stop_reason: string };
    expect(body.stop_reason).toBe("tool_use");
    expect(body.content.map((c) => c.type)).toContain("tool_use");
  });

  test("responses instructions/function_call/string input and streaming", async () => {
    t.upstream.setBehavior("sk", {
      status: 200,
      body: JSON.stringify({ choices: [{ message: { content: "done" } }] }),
    });
    t.addConnection("openai", "sk");
    await t.fetch("/v1/responses", {
      method: "POST",
      body: JSON.stringify({
        model: "openai/gpt-4o",
        instructions: "be brief",
        input: [
          { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
          { type: "function_call", call_id: "call_1", name: "ls", arguments: '{"dir":"."}' },
          { type: "function_call_output", call_id: "call_1", output: "a.txt" },
        ],
        tools: [{ type: "function", name: "ls", description: "list", parameters: { type: "object" } }],
      }),
    });
    expect((t.upstream.getLastPayload() as { messages: unknown[] }).messages.length).toBeGreaterThan(1);
    await t.fetch("/v1/responses", {
      method: "POST",
      body: JSON.stringify({ model: "openai/gpt-4o", input: "hello" }),
    });
    expect(
      (t.upstream.getLastPayload() as unknown as { messages: { role: string; content: string }[] }).messages,
    ).toEqual([{ role: "user", content: "hello" }]);
    const lookBody = JSON.stringify({
      choices: [
        {
          message: {
            content: "looks good",
            tool_calls: [{ id: "call_2", type: "function", function: { name: "grep", arguments: '{"q":"x"}' } }],
          },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
    t.upstream.setBehavior("sk", { status: 200, body: lookBody });
    const r = await t.fetch("/v1/responses", {
      method: "POST",
      body: JSON.stringify({ model: "openai/gpt-4o", input: "hi" }),
    });
    expect(((await r.json()) as { output_text: string }).output_text).toBe("looks good");
    const sse =
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\ndata: {"choices":[{"delta":{"content":"lo"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
    t.upstream.setBehavior("sk", { status: 200, headers: { "content-type": "text/event-stream" }, body: sse });
    expect(
      (
        await t.fetch("/v1/responses", {
          method: "POST",
          body: JSON.stringify({ model: "openai/gpt-4o", input: "hi", stream: true }),
        })
      ).headers
        .get("content-type")
        ?.includes("text/event-stream"),
    ).toBe(true);
  });
});

describe("Command-Code via HTTP (integrated)", () => {
  test("envelope, clamp, reasoning, tool_search, vision, and tool parts", async () => {
    const sse = `data: ${JSON.stringify({ type: "text-delta", text: "ok" })}\n\ndata: ${JSON.stringify({ type: "finish", finishReason: "stop", totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } })}\n\n`;
    t.upstream.setBehavior("cc", { status: 200, headers: { "content-type": "text/event-stream" }, body: sse });
    t.addConnection("command-code", "cc");
    await t.fetch("/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: "command-code/deepseek-v4-flash",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 500,
      }),
    });
    expect((t.upstream.getLastPayload() as { params: { model: string; max_tokens: number } }).params.model).toBe(
      "deepseek-v4-flash",
    );

    t.upstream.setBehavior("cc", { status: 200, headers: { "content-type": "text/event-stream" }, body: sse });
    await t.fetch("/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: "command-code/kimi-k2.7",
        messages: [],
        max_tokens: 999999,
        reasoning_effort: "high",
        tools: [{ type: "function", function: { name: "tool_search", description: "x", parameters: {} } }],
      }),
    });
    const p = t.upstream.getLastPayload() as {
      params: { max_tokens?: number; reasoning_effort?: string; tools: { name: string }[] };
    };
    expect(p.params.max_tokens).toBe(200000);
    expect(p.params.reasoning_effort).toBe("high");
    expect(p.params.tools[0].name).toBe("troy_tool_search");

    const img = [
      { type: "text", text: "look" },
      { type: "image_url", image_url: { url: "https://x/y.png" } },
    ];
    await t.fetch("/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "command-code/kimi-k2.7", messages: [{ role: "user", content: img }] }),
    });
    expect(JSON.stringify(t.upstream.getLastPayload())).toContain("image");

    await t.fetch("/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: "command-code/m",
        messages: [
          {
            role: "assistant",
            content: "checking",
            tool_calls: [{ id: "call_1", type: "function", function: { name: "ls", arguments: '{"dir":"."}' } }],
          },
          { role: "tool", tool_call_id: "call_1", content: "a.txt" },
        ],
      }),
    });
    const pp = t.upstream.getLastPayload() as { params: { messages: { content: { type: string }[] }[] } };
    expect(pp.params.messages[0].content.some((c) => c.type === "tool-call")).toBe(true);

    const sseErr = `data: ${JSON.stringify({ type: "error", error: { message: "boom" } })}\n\n`;
    t.upstream.setBehavior("cc", { status: 200, headers: { "content-type": "text/event-stream" }, body: sseErr });
    const res = await t.fetch("/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "command-code/m", messages: [{ role: "user", content: "hi" }] }),
    });
    expect([502, 200].includes(res.status)).toBe(true);
  });
});
