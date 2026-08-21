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

describe("freebuff wrap", () => {
  test("CLI envelope: marker, metadata, provider deny, forced stream, stop sentinel", () => {
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
    expect(out.stop).toEqual(["cb_easp"]);
    const meta = out.codebuff_metadata as Record<string, unknown>;
    expect(meta.run_id).toBe("run-1");
    expect(meta.freebuff_instance_id).toBe("inst-1");
    expect((meta.client_id as string).length).toBeGreaterThan(5);
    const messages = out.messages as Record<string, unknown>[];
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain(MARKER_PREFIX);
    expect(messages[0].content).toContain("be brief");
  });

  test("existing marker is not duplicated; client stop preserved", () => {
    const out = wrapFreebuff(
      {
        messages: [{ role: "system", content: `${MARKER_PREFIX}. custom` }],
        stop: ["END"],
      },
      { runId: "r" },
    );
    const messages = out.messages as Record<string, unknown>[];
    expect(String(messages[0].content).split(MARKER_PREFIX).length - 1).toBe(1);
    expect(out.stop).toEqual(["END"]);
    const meta = out.codebuff_metadata as Record<string, unknown>;
    expect("freebuff_instance_id" in meta).toBe(false); // disabled session → no instance id
  });

  test("parts-array system content gets a prepended text part", () => {
    const out = ensureMarker([{ role: "system", content: [{ type: "text", text: "rules" }] }]);
    const content = (out[0] as Record<string, unknown>).content as Record<string, unknown>[];
    expect(content[0]).toEqual({ type: "text", text: expect.stringContaining(MARKER_PREFIX) });
    expect(content[1]).toEqual({ type: "text", text: "rules" });
  });
});

function sessionFetch(status: object, statusCode = 200): { fetch: typeof fetch; calls: number[] } {
  const calls: number[] = [];
  const f = (async () => {
    calls.push(1);
    return new Response(JSON.stringify(status), { status: statusCode });
  }) as unknown as typeof fetch;
  return { fetch: f, calls };
}

const conn = { id: "c1", api_key: "cb_test" };

describe("freebuff session", () => {
  test("active session cached until expiry margin", async () => {
    invalidateFreebuff(conn.id);
    const { fetch, calls } = sessionFetch({ status: "active", instanceId: "i1", expiresAt: Date.now() + 60_000 });
    await ensureFreebuffSession("https://codebuff.com", conn, "m", fetch);
    await ensureFreebuffSession("https://codebuff.com", conn, "m", fetch);
    expect(calls.length).toBe(1);
  });

  test("expired session re-admits", async () => {
    invalidateFreebuff(conn.id);
    let expires = Date.now() + 1000;
    const calls: number[] = [];
    const impl = async () => {
      calls.push(1);
      return new Response(JSON.stringify({ status: "active", instanceId: `i${calls.length}`, expiresAt: expires }));
    };
    const fetch = impl as unknown as typeof globalThis.fetch;
    await ensureFreebuffSession("https://codebuff.com", conn, "m", fetch);
    expires = Date.now() - 10_000; // past the 5s margin
    await ensureFreebuffSession("https://codebuff.com", conn, "m", fetch);
    expect(calls.length).toBe(2);
  });

  test("queued surfaces retry hint", async () => {
    invalidateFreebuff(conn.id);
    const { fetch } = sessionFetch({ status: "queued", position: 2, queueDepth: 5, retryAfterMs: 1234 });
    try {
      await ensureFreebuffSession("https://codebuff.com", conn, "m", fetch);
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as Error & { retryAfterMs?: number }).retryAfterMs).toBe(1234);
    }
  });

  test("create 404 maps to disabled (no instance id)", async () => {
    invalidateFreebuff(conn.id);
    const { fetch } = sessionFetch({}, 404);
    const sess = await ensureFreebuffSession("https://codebuff.com", conn, "m", fetch);
    expect(sess.instanceId).toBe("");
  });

  test("concurrent callers share one refresh", async () => {
    invalidateFreebuff(conn.id);
    const { fetch, calls } = sessionFetch({ status: "active", instanceId: "i9", expiresAt: Date.now() + 60_000 });
    await Promise.all([
      ensureFreebuffSession("https://codebuff.com", conn, "m", fetch),
      ensureFreebuffSession("https://codebuff.com", conn, "m", fetch),
    ]);
    expect(calls.length).toBe(1);
  });
});

describe("freebuff error classification", () => {
  test("409 superseded invalidates; session_limit_reached does not", () => {
    expect(classifyFreebuffError(409, '{"error":"session_superseded"}').invalidate).toBe(true);
    expect(classifyFreebuffError(409, '{"error":"session_limit_reached"}').invalidate).toBe(false);
  });

  test("banned carries resumes_at retry hint", () => {
    const at = Date.now() + 3_600_000;
    const info = classifyFreebuffError(403, JSON.stringify({ status: "banned", resumes_at: at }));
    expect(info.reason).toBe("account banned");
    expect(info.retryAfterMs).toBeGreaterThan(3_500_000);
  });

  test("429 ip_capped keeps body retryAfterMs", () => {
    const info = classifyFreebuffError(429, '{"error":"ip_capped","retryAfterMs":45000}');
    expect(info.reason).toBe("ip capped");
    expect(info.retryAfterMs).toBe(45_000);
  });

  test("capacity deferred floors at 10s", () => {
    const info = classifyFreebuffError(503, '{"error":"free_mode_capacity_deferred"}');
    expect(info.retryAfterMs).toBe(10_000);
  });
});

describe("freebuff token discovery", () => {
  test("authToken read from the CLI credentials shape", () => {
    const json = JSON.stringify({
      default: {
        id: "00000000-0000-0000-0000-000000000000",
        name: "Test User",
        email: "test@example.com",
        authToken: "01234567-89ab-cdef-0123-456789abcdef",
        fingerprintId: "enhanced-test",
        fingerprintHash: "deadbeef",
      },
    });
    expect(parseFreebuffToken(json)).toBe("01234567-89ab-cdef-0123-456789abcdef");
    expect(parseFreebuffToken("not json")).toBe("");
    expect(parseFreebuffToken("{}")).toBe("");
  });

  test("manicode path wins over codebuff", () => {
    const [manicode, codebuff] = freebuffTokenPaths("/home/u");
    expect(manicode).toBe("/home/u/.config/manicode/credentials.json");
    expect(codebuff).toBe("/home/u/.config/codebuff/credentials.json");
  });
});

function sse(chunks: object[]): Response {
  const body = `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, { status: 200 });
}

describe("freebuff json reply", () => {
  test("SSE chunks accumulate into chat.completion", async () => {
    const res = await freebuffJsonReply(
      sse([
        { id: "x", model: "m", created: 1, choices: [{ index: 0, delta: { role: "assistant" } }] },
        { choices: [{ index: 0, delta: { content: "he" } }] },
        { choices: [{ index: 0, delta: { content: "llo" } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { total_tokens: 7 } },
      ]),
    );
    const json = (await res.json()) as Record<string, any>;
    expect(json.object).toBe("chat.completion");
    expect(json.model).toBe("m");
    expect(json.choices[0].message.content).toBe("hello");
    expect(json.choices[0].finish_reason).toBe("stop");
    expect(json.usage).toEqual({ total_tokens: 7 });
  });

  test("tool call deltas merge by index", async () => {
    const res = await freebuffJsonReply(
      sse([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "t1", function: { name: "ls", arguments: '{"d' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ir":"."}' } }] } }] },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      ]),
    );
    const json = (await res.json()) as Record<string, any>;
    expect(json.choices[0].message.tool_calls).toEqual([
      { id: "t1", type: "function", function: { name: "ls", arguments: '{"dir":"."}' } },
    ]);
    expect(json.choices[0].finish_reason).toBe("tool_calls");
  });

  test("in-stream error event rejects", async () => {
    await expect(freebuffJsonReply(sse([{ error: { message: "boom" } }]))).rejects.toThrow("boom");
  });
});
