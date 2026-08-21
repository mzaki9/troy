import { describe, expect, test } from "bun:test";
import {
  type AnthropicState,
  chatChunkToAnthropicEvents,
  finalize,
  freshState,
  handleMessages,
  toAnthropic,
  toChatBody,
} from "../src/anthropic";
import { Store } from "../src/db";
import { registerCustomProvider, unregisterCustomProvider } from "../src/registry";
import { type ChatDeps, CooldownStore, type LogRow } from "../src/route";

describe("anthropic → chat translation", () => {
  test("system string becomes system message", () => {
    const out = toChatBody({ model: "m", system: "be terse", messages: [{ role: "user", content: "hi" }] });
    const msgs = out.messages as Record<string, unknown>[];
    expect(msgs[0]).toEqual({ role: "system", content: "be terse" });
    expect(msgs[1]).toEqual({ role: "user", content: "hi" });
  });

  test("tool_use / tool_result roundtrip", () => {
    const out = toChatBody({
      model: "m",
      messages: [
        { role: "user", content: "run ls" },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "ls", input: { path: "/" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "files…" }] },
      ],
      tools: [{ name: "ls", description: "list", input_schema: { type: "object" } }],
    });
    const msgs = out.messages as Record<string, unknown>[];
    expect(msgs[1].tool_calls).toEqual([
      { id: "t1", type: "function", function: { name: "ls", arguments: '{"path":"/"}' } },
    ]);
    expect(msgs[2]).toEqual({ role: "tool", tool_call_id: "t1", content: "files…" });
    expect(out.tools).toEqual([
      { type: "function", function: { name: "ls", description: "list", parameters: { type: "object" } } },
    ]);
  });

  test("base64 image becomes data-url image_url part", () => {
    const out = toChatBody({
      model: "m",
      messages: [
        {
          role: "user",
          content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } }],
        },
      ],
    });
    const msg = (out.messages as { content: { type: string; image_url: { url: string } }[] }[])[0];
    expect(msg.content[0].image_url.url).toBe("data:image/png;base64,AAA");
  });

  test("thinking budget maps to reasoning_effort tiers", () => {
    expect(toChatBody({ model: "m", messages: [], thinking: { budget_tokens: 32000 } }).reasoning_effort).toBe("high");
    expect(toChatBody({ model: "m", messages: [], thinking: { budget_tokens: 8000 } }).reasoning_effort).toBe("medium");
    expect(toChatBody({ model: "m", messages: [], thinking: { budget_tokens: 1024 } }).reasoning_effort).toBe("low");
  });

  test("stop_sequences → stop; max_tokens passes through", () => {
    const out = toChatBody({ model: "m", messages: [], stop_sequences: ["END"], max_tokens: 99 });
    expect(out.stop).toEqual(["END"]);
    expect(out.max_tokens).toBe(99);
  });
});

describe("chat → anthropic translation", () => {
  test("text + tool_calls + stop_reason mapping + usage", () => {
    const out = toAnthropic(
      {
        choices: [
          {
            message: {
              content: "doing it",
              tool_calls: [{ id: "c1", function: { name: "ls", arguments: "{}" } }],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 4 },
      },
      "m",
    );
    expect(out.stop_reason).toBe("tool_use");
    expect(out.usage).toEqual({ input_tokens: 3, output_tokens: 4 });
    expect((out.content as { type: string }[]).map((c) => c.type)).toEqual(["text", "tool_use"]);
    expect(out.type).toBe("message");
    expect(out.role).toBe("assistant");
  });

  test("length finish → max_tokens stop reason", () => {
    const out = toAnthropic({ choices: [{ message: { content: "x" }, finish_reason: "length" }] }, "m");
    expect(out.stop_reason).toBe("max_tokens");
  });

  test("empty message still yields one text block", () => {
    const out = toAnthropic({ choices: [{ message: {}, finish_reason: "stop" }] }, "m");
    expect(out.content).toEqual([{ type: "text", text: "" }]);
  });
});

describe("streaming events", () => {
  test("text delta sequence", () => {
    const st = freshState("m");
    const ev1 = chatChunkToAnthropicEvents({ choices: [{ delta: { content: "he" } }] }, st);
    const ev2 = chatChunkToAnthropicEvents(
      { choices: [{ delta: { content: "y" }, finish_reason: "stop" }], usage: { completion_tokens: 2 } },
      st,
    );
    const all = [...ev1, ...ev2];
    expect(all[0].type).toBe("message_start");
    expect(all[1]).toMatchObject({ type: "content_block_start", index: 0, content_block: { type: "text" } });
    expect(all[2]).toMatchObject({ type: "content_block_delta", delta: { type: "text_delta", text: "he" } });
    expect(all[3]).toMatchObject({ type: "content_block_delta", delta: { text: "y" } });
    expect(all[4].type).toBe("content_block_stop");
    expect(all[5]).toMatchObject({
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 2 },
    });
    expect(all[6].type).toBe("message_stop");
  });

  test("tool_use blocks get their own indices + input_json_delta", () => {
    const st = freshState("m");
    const all = [
      ...chatChunkToAnthropicEvents(
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "t9", function: { name: "ls", arguments: "" } }] } }] },
        st,
      ),
      ...chatChunkToAnthropicEvents(
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"a":1}' } }] } }] },
        st,
      ),
      ...chatChunkToAnthropicEvents({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }, st),
    ];
    expect(all[1]).toMatchObject({
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "t9", name: "ls" },
    });
    expect(all[2]).toMatchObject({
      type: "content_block_delta",
      delta: { type: "input_json_delta", partial_json: '{"a":1}' },
    });
    const stop = all.find((e) => e.type === "message_delta") as { delta: { stop_reason: string } };
    expect(stop.delta.stop_reason).toBe("tool_use");
  });

  test("flush finalizes an unterminated stream", () => {
    const st: AnthropicState = freshState("m");
    chatChunkToAnthropicEvents({ choices: [{ delta: { content: "partial" } }] }, st);
    const events: Record<string, unknown>[] = [];
    finalize(st, events);
    expect(events.map((e) => e.type)).toEqual(["content_block_stop", "message_delta", "message_stop"]);
  });
});

describe("handleMessages end-to-end", () => {
  function deps(): ChatDeps {
    return {
      store: new Store(":memory:"),
      cooldowns: new CooldownStore(),
      strategy: "fill-first",
      rtkOn: false,
      cavemanLevel: "off",
      ponytailLevel: "off",
      onLog: () => {},
    };
  }

  test("routes through the chain and returns the anthropic shape", async () => {
    const logs: LogRow[] = [];
    const upstream = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({
          choices: [{ message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        });
      },
    });
    registerCustomProvider({
      id: "anthro-e2e",
      aliases: ["anthro-e2e"],
      baseUrl: upstream.url.toString(),
      auth: "none",
    });
    try {
      const d = deps();
      d.onLog = (r) => logs.push(r);
      const res = await handleMessages(
        { model: "anthro-e2e/m", max_tokens: 8, system: "s", messages: [{ role: "user", content: "hi" }] },
        d,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { type: string; content: { text: string }[] };
      expect(body.type).toBe("message");
      expect(body.content[0].text).toBe("hello");
      expect(logs[0].status).toBe("200 OK");
    } finally {
      unregisterCustomProvider("anthro-e2e");
      upstream.stop(true);
    }
  });

  test("upstream failure comes back in the anthropic error envelope", async () => {
    const upstream = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({ error: { message: "bad key" } }, { status: 401 });
      },
    });
    registerCustomProvider({
      id: "anthro-err",
      aliases: ["anthro-err"],
      baseUrl: upstream.url.toString(),
      auth: "none",
    });
    try {
      const res = await handleMessages(
        { model: "anthro-err/m", max_tokens: 8, messages: [{ role: "user", content: "hi" }] },
        deps(),
      );
      expect(res.status).toBe(503);
      const body = (await res.json()) as { type: string; error: { type: string; message: string } };
      expect(body.type).toBe("error");
      expect(body.error.message).toContain("unavailable");
    } finally {
      unregisterCustomProvider("anthro-err");
      upstream.stop(true);
    }
  });
});
