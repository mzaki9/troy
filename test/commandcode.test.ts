import { describe, expect, test } from "bun:test";
import { commandCodeReply, wrapCommandCode } from "../src/providers/commandcode";

function wrap(body: Record<string, unknown>): Record<string, any> {
  return wrapCommandCode(body).body as Record<string, any>;
}

describe("command-code wrap", () => {
  test("chat body → alpha/generate envelope", () => {
    const out = wrap({
      model: "deepseek/deepseek-v4-flash",
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: "hi" },
      ],
      tools: [{ type: "function", function: { name: "ls", description: "list", parameters: { type: "object" } } }],
      max_tokens: 500,
    });
    expect(out.config.environment).toBe("external");
    expect(out.memory).toBe("");
    expect(out.permissionMode).toBe("standard");
    const p = out.params as Record<string, unknown>;
    expect(p.model).toBe("deepseek/deepseek-v4-flash");
    expect(p.stream).toBe(true);
    expect(p.system).toBe("be brief");
    expect(p.max_tokens).toBe(500);
    expect(p.tools).toEqual([{ type: "function", name: "ls", description: "list", input_schema: { type: "object" } }]);
    expect(p.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  test("max_tokens clamped to 200k", () => {
    const out = wrap({ model: "m", messages: [], max_tokens: 999_999 });
    expect((out.params as Record<string, unknown>).max_tokens).toBe(200_000);
  });

  test("paired tool call + result → tool-call/tool-result parts", () => {
    const out = wrap({
      model: "m",
      messages: [
        {
          role: "assistant",
          content: "checking",
          tool_calls: [{ id: "call_1", type: "function", function: { name: "ls", arguments: '{"dir":"."}' } }],
        },
        { role: "tool", tool_call_id: "call_1", content: "a.txt" },
      ],
    });
    const messages = out.params.messages as Record<string, unknown>[];
    expect(messages[0]).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "checking" },
        { type: "tool-call", toolCallId: "call_1", toolName: "ls", input: { dir: "." }, arguments: '{"dir":"."}' },
      ],
    });
    expect(messages[1]).toEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call_1",
          toolName: "ls",
          arguments: '{"dir":"."}',
          output: { type: "text", value: "a.txt" },
        },
      ],
    });
  });

  test("unpaired tool call dropped", () => {
    const out = wrap({
      model: "m",
      messages: [
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "call_x", type: "function", function: { name: "ls", arguments: "{}" } }],
        },
      ],
    });
    expect(out.params.messages).toEqual([]);
  });

  test("reserved tool_search renamed consistently both ways", () => {
    const wrapped = wrapCommandCode({
      model: "m",
      messages: [],
      tools: [{ type: "function", function: { name: "tool_search", parameters: {} } }],
    });
    expect((wrapped.body.params as Record<string, any>).tools as Record<string, any>[]).toHaveLength(1);
    expect(((wrapped.body.params as Record<string, any>).tools as Record<string, any>[])[0].name).toBe(
      "troy_tool_search",
    );
    expect(wrapped.toolMap.get("troy_tool_search")).toBe("tool_search");
  });

  test("tool_search round trip: call + result both wire-renamed", () => {
    const wrapped = wrapCommandCode({
      model: "m",
      messages: [
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "call_1", type: "function", function: { name: "tool_search", arguments: '{"q":"x"}' } }],
        },
        { role: "tool", tool_call_id: "call_1", name: "tool_search", content: "hit" },
      ],
    });
    const messages = (wrapped.body.params as Record<string, any>).messages as Record<string, any>[];
    expect(messages[0].content[0].toolName).toBe("troy_tool_search");
    expect(messages[1].content[0].toolName).toBe("troy_tool_search"); // NOT un-renamed on wire (#7)
  });

  test("reasoning passthrough fields reach params", () => {
    const out = wrap({
      model: "m",
      messages: [],
      reasoning_effort: "high",
      thinking: { type: "enabled" },
      extra_body: { x: 1 },
      effort: "low",
      output_config: { o: 2 },
      reasoning: "banana",
    });
    const p = out.params as Record<string, any>;
    expect(p.reasoning_effort).toBe("high");
    expect(p.thinking).toEqual({ type: "enabled" });
    expect(p.extra_body).toEqual({ x: 1 });
    expect(p.effort).toBe("low");
    expect(p.output_config).toEqual({ o: 2 });
    expect(p.reasoning).toBe("banana");
  });

  test("top-level system merged with message systems", () => {
    const out = wrap({
      model: "m",
      system: "explicit",
      messages: [
        { role: "system", content: "from-msg" },
        { role: "user", content: "hi" },
      ],
    });
    expect((out.params as Record<string, any>).system).toBe("from-msg\n\nexplicit");
  });

  test("max_tokens NaN / -1 / 0 omitted", () => {
    expect(
      (wrap({ model: "m", messages: [], max_tokens: NaN }).params as Record<string, any>).max_tokens,
    ).toBeUndefined();
    expect(
      (wrap({ model: "m", messages: [], max_tokens: -1 }).params as Record<string, any>).max_tokens,
    ).toBeUndefined();
    expect(
      (wrap({ model: "m", messages: [], max_tokens: 0 }).params as Record<string, any>).max_tokens,
    ).toBeUndefined();
    expect(
      (wrap({ model: "m", messages: [], max_completion_tokens: 50 }).params as Record<string, any>).max_tokens,
    ).toBe(50);
  });

  test("vision: image_url preserved for vision model, stripped for text model", () => {
    const img = [
      { type: "text", text: "look" },
      { type: "image_url", image_url: { url: "https://x/y.png" } },
    ];
    const vision = wrap({ model: "kimi-k2.7", messages: [{ role: "user", content: img }] });
    expect(vision.params.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image", image: "https://x/y.png" },
        ],
      },
    ]);
    const text = wrap({ model: "deepseek-v4-flash", messages: [{ role: "user", content: img }] });
    expect(text.params.messages).toEqual([{ role: "user", content: "look" }]);
  });

  test("vision: anthropic base64 source block converted", () => {
    const img = [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "AAEC" } }];
    const out = wrap({ model: "gpt-5.6", messages: [{ role: "user", content: img }] });
    expect(out.params.messages).toEqual([
      { role: "user", content: [{ type: "image", image: "data:image/jpeg;base64,AAEC" }] },
    ]);
  });

  test("call-level name fallback when function.name empty", () => {
    const out = wrap({
      model: "m",
      messages: [
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "c1", type: "function", name: "call-lvl", arguments: "{}" }],
        },
        { role: "tool", tool_call_id: "c1", content: "out" },
      ],
    });
    const messages = out.params.messages as Record<string, any>[];
    expect(messages[0].content[0].toolName).toBe("call-lvl");
    expect(messages[1].content[0].toolName).toBe("call-lvl");
  });
});

describe("command-code reply", () => {
  test("aggregate SSE → chat completion JSON", async () => {
    const sse = [
      `data: ${JSON.stringify({ type: "text-delta", text: "Hel" })}\n\n`,
      `data: ${JSON.stringify({ type: "text-delta", text: "lo" })}\n\n`,
      `data: ${JSON.stringify({ type: "reasoning-delta", text: "hmm" })}\n\n`,
      `data: ${JSON.stringify({ type: "tool-call", toolCallId: "call_9", toolName: "grep", input: { q: "x" } })}\n\n`,
      `data: ${JSON.stringify({ type: "finish", finishReason: "tool-calls", totalUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, reasoningTokens: 2 } })}\n\n`,
    ].join("");
    const res = await commandCodeReply(
      new Response(sse, { headers: { "content-type": "text/event-stream" } }),
      false,
      "deepseek/deepseek-v4-flash",
      new Map(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      choices: {
        message: {
          content: string;
          reasoning_content: string;
          tool_calls: { id: string; function: { name: string; arguments: string } }[];
        };
        finish_reason: string;
      }[];
      usage: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
        prompt_tokens_details: { cached_tokens: number };
        completion_tokens_details: { reasoning_tokens: number };
        reasoning_tokens: number;
      };
    };
    expect(body.choices[0].message.content).toBe("Hello");
    expect(body.choices[0].message.reasoning_content).toBe("hmm");
    expect(body.choices[0].message.tool_calls[0]).toMatchObject({
      id: "call_9",
      function: { name: "grep", arguments: '{"q":"x"}' },
    });
    expect(body.choices[0].finish_reason).toBe("tool_calls");
    expect(body.usage).toEqual({
      prompt_tokens: 10,
      prompt_tokens_details: { cached_tokens: 0 },
      completion_tokens: 5,
      completion_tokens_details: { reasoning_tokens: 2 },
      total_tokens: 15,
      reasoning_tokens: 2,
    });
  });

  test("streaming → chat chunks", async () => {
    const sse = [
      `data: ${JSON.stringify({ type: "text-delta", text: "yo" })}\n\n`,
      `data: ${JSON.stringify({ type: "finish", finishReason: "stop", totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } })}\n\n`,
    ].join("");
    const res = await commandCodeReply(
      new Response(sse, { headers: { "content-type": "text/event-stream" } }),
      true,
      "m",
      new Map(),
    );
    const text = await res.text();
    const deltas = [...text.matchAll(/"content":"([^"]*)"/g)].map((m) => m[1]);
    expect(deltas).toEqual(["yo"]);
    expect(text).toContain('"finish_reason":"stop"');
    expect(text).toContain("data: [DONE]");
    expect(text).toContain('"usage"');
  });

  test("error event → 502", async () => {
    const sse = `data: ${JSON.stringify({ type: "error", error: { message: "boom" } })}\n\n`;
    const res = await commandCodeReply(
      new Response(sse, { headers: { "content-type": "text/event-stream" } }),
      false,
      "m",
      new Map(),
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe("boom");
  });

  test("empty upstream body → 502 error, not silent 200", async () => {
    const res = await commandCodeReply(new Response(null, { status: 200 }), false, "m", new Map());
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("missing body");
  });

  test("finish-step usage details survive a details-less terminal finish", async () => {
    const sse = [
      `data: ${JSON.stringify({ type: "text-delta", text: "hi" })}\n\n`,
      `data: ${JSON.stringify({ type: "finish-step", usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10, inputTokenDetails: { cachedTokens: 4, noCacheTokens: 3 } } })}\n\n`,
      `data: ${JSON.stringify({ type: "finish", finishReason: "stop", totalUsage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 } })}\n\n`,
    ].join("");
    const res = await commandCodeReply(
      new Response(sse, { headers: { "content-type": "text/event-stream" } }),
      false,
      "m",
      new Map(),
    );
    const body = (await res.json()) as { usage: Record<string, any> };
    expect(body.usage.prompt_tokens_details).toEqual({ cached_tokens: 4 });
    expect(body.usage.cache_read_input_tokens).toBe(4);
    expect(body.usage.no_cache_tokens).toBe(3);
  });
});
