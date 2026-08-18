import { describe, expect, test } from "bun:test";
import { chatChunkToEvents, toChatBody, toResponses, type StreamState } from "../src/responses";

function newState(): StreamState {
  return { id: "resp_1", model: "openai/gpt-4o", output: [], outputText: "", open: null, tools: new Map(), started: false, done: false, usage: null };
}

describe("/v1/responses bridge", () => {
  test("toChatBody: instructions + items + tools", () => {
    const chat = toChatBody({
      model: "openai/gpt-4o",
      instructions: "be brief",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
        { type: "function_call", call_id: "call_1", name: "ls", arguments: '{"dir":"."}' },
        { type: "function_call_output", call_id: "call_1", output: "a.txt" },
      ],
      tools: [{ type: "function", name: "ls", description: "list files", parameters: { type: "object" } }],
      max_output_tokens: 42,
      reasoning: { effort: "high" },
      stream: true,
    });
    expect(chat.messages).toEqual([
      { role: "system", content: "be brief" },
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "ls", arguments: '{"dir":"."}' } }] },
      { role: "tool", tool_call_id: "call_1", content: "a.txt" },
    ]);
    expect(chat.tools).toEqual([{ type: "function", function: { name: "ls", description: "list files", parameters: { type: "object" } } }]);
    expect(chat.max_tokens).toBe(42);
    expect(chat.reasoning_effort).toBe("high");
    expect(chat.stream).toBe(true);
    expect(chat.input).toBeUndefined();
  });

  test("toChatBody: string input becomes a single user message", () => {
    const chat = toChatBody({ model: "x/y", input: "hello", stream: false });
    expect(chat.messages).toEqual([{ role: "user", content: "hello" }]);
    expect(chat.stream).toBe(false);
  });

  test("toResponses: text + tool calls → output items", () => {
    const res = toResponses(
      {
        id: "chatcmpl-1",
        model: "openai/gpt-4o",
        choices: [
          {
            message: {
              content: "looks good",
              tool_calls: [{ id: "call_2", type: "function", function: { name: "grep", arguments: '{"q":"x"}' } }],
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
      "openai/gpt-4o"
    );
    expect(res.object).toBe("response");
    expect(res.status).toBe("completed");
    expect(res.output_text).toBe("looks good");
    const output = res.output as Record<string, unknown>[];
    expect(output[0]).toMatchObject({ type: "message", role: "assistant", content: [{ type: "output_text", text: "looks good" }] });
    expect(output[1]).toMatchObject({ type: "function_call", call_id: "call_2", name: "grep", arguments: '{"q":"x"}' });
    expect(res.usage).toMatchObject({ input_tokens: 10, output_tokens: 5, total_tokens: 15 });
  });

  test("chatChunkToEvents: content stream → output_text.delta sequence", () => {
    const st = newState();
    const ev1 = chatChunkToEvents({ choices: [{ delta: { content: "Hel" } }] }, st);
    expect(ev1.map((e) => e.type)).toEqual(["response.created", "response.in_progress", "response.output_item.added", "response.content_part.added", "response.output_text.delta"]);
    const ev2 = chatChunkToEvents({ choices: [{ delta: { content: "lo" } }] }, st);
    expect(ev2.map((e) => e.type)).toEqual(["response.output_text.delta"]);
    const ev3 = chatChunkToEvents({ choices: [{ delta: {}, finish_reason: "stop" }] }, st);
    const types = ev3.map((e) => e.type);
    expect(types).toEqual(["response.output_text.done", "response.content_part.done", "response.output_item.done", "response.completed"]);
    const completed = ev3[ev3.length - 1].response as { status: string; output_text: string; output: unknown[] };
    expect(completed.status).toBe("completed");
    expect(completed.output_text).toBe("Hello");
    expect(completed.output).toHaveLength(1);
  });

  test("chatChunkToEvents: tool call deltas → function_call events", () => {
    const st = newState();
    const ev1 = chatChunkToEvents({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_9", function: { name: "ls", arguments: "" } }] } }] }, st);
    expect(ev1.map((e) => e.type)).toEqual(["response.created", "response.in_progress", "response.output_item.added"]);
    expect(ev1[2].item).toMatchObject({ type: "function_call", call_id: "call_9", name: "ls", arguments: "" });
    const ev2 = chatChunkToEvents({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"a":' } }] } }] }, st);
    expect(ev2.map((e) => e.type)).toEqual(["response.function_call_arguments.delta"]);
    expect(ev2[0].delta).toBe('{"a":');
    const ev3 = chatChunkToEvents({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }, st);
    const types = ev3.map((e) => e.type);
    expect(types).toEqual(["response.function_call_arguments.done", "response.output_item.done", "response.completed"]);
    const item = ev3[1].item as { arguments: string };
    expect(item.arguments).toBe('{"a":');
  });
});
