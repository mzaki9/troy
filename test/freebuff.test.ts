import { describe, expect, test } from "bun:test";
import {
  classifyFreebuffError,
  ensureFreebuffSession,
  ensureMarker,
  freebuffJsonReply,
  freebuffTokenPaths,
  invalidateFreebuff,
  parseFreebuffToken,
  wrapFreebuff,
} from "../src/providers/freebuff";

const MARKER_PREFIX = "You are Buffy, the strategic coding assistant";
const conn = { id: "c1", api_key: "cb_test" };
function sessionFetch(status: object, statusCode = 200) {
  const calls: number[] = [];
  const f = (async () => {
    calls.push(1);
    return new Response(JSON.stringify(status), { status: statusCode });
  }) as unknown as typeof fetch;
  return { fetch: f, calls };
}
function sse(chunks: object[]): Response {
  const body = `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, { status: 200 });
}

describe("freebuff wrap + session (integrated)", () => {
  test("envelope, marker, and session cache", async () => {
    const out = wrapFreebuff(
      {
        model: "deepseek/deepseek-v4-flash",
        messages: [
          { role: "system", content: "be brief" },
          { role: "user", content: "hi" },
        ],
      },
      { runId: "run-1", instanceId: "inst-1" },
    );
    expect(out.stream).toBe(true);
    expect(out.provider).toEqual({ data_collection: "deny" });
    expect((out.codebuff_metadata as Record<string, unknown>).freebuff_instance_id).toBe("inst-1");
    expect((out.messages as Record<string, unknown>[])[0].content).toContain(MARKER_PREFIX);
    expect(ensureMarker([{ role: "system", content: [{ type: "text", text: "rules" }] }])[0].content).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "text" })]),
    );

    invalidateFreebuff(conn.id);
    const { fetch, calls } = sessionFetch({ status: "active", instanceId: "i1", expiresAt: Date.now() + 60_000 });
    await ensureFreebuffSession("https://codebuff.com", conn, "m", fetch);
    await ensureFreebuffSession("https://codebuff.com", conn, "m", fetch);
    expect(calls.length).toBe(1);

    invalidateFreebuff(conn.id);
    const { fetch: f2 } = sessionFetch({ status: "queued", position: 2, queueDepth: 5, retryAfterMs: 1234 });
    await expect(ensureFreebuffSession("https://codebuff.com", conn, "m", f2)).rejects.toMatchObject({
      retryAfterMs: 1234,
    });

    invalidateFreebuff(conn.id);
    const { fetch: f3 } = sessionFetch({}, 404);
    expect((await ensureFreebuffSession("https://codebuff.com", conn, "m", f3)).instanceId).toBe("");

    invalidateFreebuff(conn.id);
    const { fetch: f4, calls: c4 } = sessionFetch({
      status: "active",
      instanceId: "i9",
      expiresAt: Date.now() + 60_000,
    });
    await Promise.all([
      ensureFreebuffSession("https://codebuff.com", conn, "m", f4),
      ensureFreebuffSession("https://codebuff.com", conn, "m", f4),
    ]);
    expect(c4.length).toBe(1);
  });
});

describe("freebuff error + token + reply (integrated)", () => {
  test("classification, token discovery, and SSE reply", async () => {
    expect(classifyFreebuffError(409, '{"error":"session_superseded"}').invalidate).toBe(true);
    expect(classifyFreebuffError(409, '{"error":"session_limit_reached"}').invalidate).toBe(false);
    const at = Date.now() + 3_600_000;
    expect(classifyFreebuffError(403, JSON.stringify({ status: "banned", resumes_at: at })).reason).toBe(
      "account banned",
    );
    expect(classifyFreebuffError(429, '{"error":"ip_capped","retryAfterMs":45000}').reason).toBe("ip capped");
    expect(classifyFreebuffError(503, '{"error":"free_mode_capacity_deferred"}').retryAfterMs).toBe(10_000);

    const json = JSON.stringify({ default: { authToken: "01234567-89ab-cdef-0123-456789abcdef" } });
    expect(parseFreebuffToken(json)).toBe("01234567-89ab-cdef-0123-456789abcdef");
    expect(freebuffTokenPaths("/home/u")[0]).toBe("/home/u/.config/manicode/credentials.json");

    const res = await freebuffJsonReply(
      sse([
        { id: "x", model: "m", created: 1, choices: [{ index: 0, delta: { role: "assistant" } }] },
        { choices: [{ index: 0, delta: { content: "he" } }] },
        { choices: [{ index: 0, delta: { content: "llo" } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { total_tokens: 7 } },
      ]),
    );
    expect(((await res.json()) as Record<string, unknown>).object).toBe("chat.completion");
    const res2 = await freebuffJsonReply(
      sse([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "t1", function: { name: "ls", arguments: '{"d' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ir":"."}' } }] } }] },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      ]),
    );
    expect(
      ((await res2.json()) as { choices: { message: { tool_calls: unknown[] } }[] }).choices[0].message.tool_calls
        .length,
    ).toBe(1);
    await expect(freebuffJsonReply(sse([{ error: { message: "boom" } }]))).rejects.toThrow("boom");
  });
});
