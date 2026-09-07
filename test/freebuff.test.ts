import { describe, expect, test } from "bun:test";
import {
  agentForModel,
  classifyFreebuffError,
  ensureFreebuffRun,
  ensureFreebuffSession,
  ensureMarker,
  freebuffJsonReply,
  freebuffTokenPaths,
  invalidateFreebuff,
  parseFreebuffToken,
  pauseFreebuff,
  UPSTREAM_UA,
  wrapFreebuff,
} from "../src/providers/freebuff";

const MARKER_PREFIX = "You are Buffy, the strategic coding assistant";
const conn = { id: "c1", api_key: "cb_test" };
function sessionFetch(status: object, statusCode = 200) {
  const calls: number[] = [];
  const seen: Record<string, string>[] = [];
  const f = (async (_url: unknown, init?: { headers?: Record<string, string> }) => {
    calls.push(1);
    seen.push({ ...(init?.headers ?? {}) });
    return new Response(JSON.stringify(status), { status: statusCode });
  }) as unknown as typeof fetch;
  return { fetch: f, calls, seen };
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
    const { fetch, calls, seen } = sessionFetch({ status: "active", instanceId: "i1", expiresAt: Date.now() + 60_000 });
    await ensureFreebuffSession("https://codebuff.com", conn, "m", fetch);
    await ensureFreebuffSession("https://codebuff.com", conn, "m", fetch);
    expect(calls.length).toBe(1);
    expect(Object.keys(seen[0]).sort()).toEqual(["authorization", "x-freebuff-model"]);

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

describe("freebuff binary parity", () => {
  test("UA mirrors binary chat UA; session POST is auth-only", async () => {
    expect(UPSTREAM_UA).toBe("ai-sdk/openai-compatible/0.0.171/codebuff");
    invalidateFreebuff(conn.id);
    const { fetch, seen } = sessionFetch({ status: "active", instanceId: "i1", expiresAt: Date.now() + 60_000 });
    await ensureFreebuffSession("https://codebuff.com", conn, "m", fetch);
    expect(Object.keys(seen[0]).sort()).toEqual(["authorization", "x-freebuff-model"]);
    expect("user-agent" in seen[0]).toBe(false);
    expect("content-type" in seen[0]).toBe(false);
  });

  test("createSession binary outcomes carry retryAfterMs", async () => {
    for (const [body, msg] of [
      [{ status: "model_locked", retryAfterMs: 7000 }, "model locked"],
      [{ status: "model_unavailable", retryAfterMs: 7001 }, "model unavailable"],
      [{ status: "rate_limited", retryAfterMs: 7002 }, "rate limited"],
      [{ status: "spend_limited", retryAfterMs: 7003 }, "spend limited"],
      [{ status: "ip_capped", retryAfterMs: 7004 }, "ip capped"],
      [{ status: "premium_slot_taken", retryAfterMs: 7005 }, "premium slot taken"],
    ] as const) {
      invalidateFreebuff(conn.id);
      const { fetch } = sessionFetch(body);
      const want = body.retryAfterMs;
      await expect(ensureFreebuffSession("https://codebuff.com", conn, "m", fetch)).rejects.toMatchObject({
        message: expect.stringContaining(msg),
        retryAfterMs: want,
      });
    }
  });

  test("run cache hit bumps step, keeps expiry", async () => {
    invalidateFreebuff(conn.id);
    const r1 = await ensureFreebuffRun("https://codebuff.com", conn, "base2-free-mimo");
    const s1 = r1.step;
    const r2 = await ensureFreebuffRun("https://codebuff.com", conn, "base2-free-mimo");
    expect(r2.runId).toBe(r1.runId);
    expect(r2.step).toBe(s1 + 1);
    expect(r2.expiresAt).toBe(r1.expiresAt);
  });

  test("expiry margin is max(5s, 10% TTL)", async () => {
    invalidateFreebuff(conn.id);
    const ttl = 100_000;
    const t0 = Date.now();
    const { fetch, calls } = sessionFetch({ status: "active", instanceId: "i1", expiresAt: t0 + ttl });
    await ensureFreebuffSession("https://codebuff.com", conn, "m", fetch);
    expect(calls.length).toBe(1);
    // 8s before expiry: inside 10% margin (10s) but outside the old 5s margin → must refetch
    const realNow = Date.now;
    try {
      Date.now = () => t0 + ttl - 8_000;
      await ensureFreebuffSession("https://codebuff.com", conn, "m", fetch);
    } finally {
      Date.now = realNow;
    }
    expect(calls.length).toBe(2);
  });

  test("cold start across models fires one POST", async () => {
    invalidateFreebuff(conn.id);
    const { fetch, calls } = sessionFetch({ status: "active", instanceId: "i1", expiresAt: Date.now() + 60_000 });
    await Promise.all([
      ensureFreebuffSession("https://codebuff.com", conn, "m1", fetch),
      ensureFreebuffSession("https://codebuff.com", conn, "m2", fetch),
    ]);
    expect(calls.length).toBe(1);
  });

  test("google prefix fallback; pause is local-only", async () => {
    expect(agentForModel("google/gemini-2.5-flash-lite")).toBe("base2-free-gemini-3-8-flash");
    invalidateFreebuff(conn.id);
    const { fetch, calls } = sessionFetch({ status: "active", instanceId: "i1", expiresAt: Date.now() + 60_000 });
    await ensureFreebuffSession("https://codebuff.com", conn, "m", fetch);
    await ensureFreebuffSession("https://codebuff.com", conn, "m", fetch);
    expect(calls.length).toBe(1);
    expect(await pauseFreebuff(conn.id, "m")).toBe(1);
    expect(calls.length).toBe(1);
    await ensureFreebuffSession("https://codebuff.com", conn, "m", fetch);
    expect(calls.length).toBe(2);
  });
});

describe("freebuff error + token + reply (integrated)", () => {
  test("classification, token discovery, and SSE reply", async () => {
    expect(classifyFreebuffError(409, '{"error":"session_superseded"}').invalidate).toBe(true);
    expect(classifyFreebuffError(409, '{"error":"session_limit_reached"}').invalidate).toBe(false);
    expect(classifyFreebuffError(429, '{"error":"ip_capped","retryAfterMs":45000}').reason).toBe("ip capped");
    expect(classifyFreebuffError(429, '{"error":"spend_limited","retryAfterMs":5000}').reason).toBe("spend limited");
    expect(classifyFreebuffError(429, '{"error":"rate_limited","retryAfterMs":5000}').reason).toBe("rate limited");
    expect(classifyFreebuffError(409, '{"status":"model_locked","retryAfterMs":7000}')).toMatchObject({
      reason: "model locked",
      retryAfterMs: 7000,
    });
    expect(classifyFreebuffError(409, '{"status":"model_unavailable"}').reason).toBe("model unavailable");
    expect(classifyFreebuffError(200, '{"status":"premium_slot_taken","retryAfterMs":9000}').reason).toBe(
      "premium slot taken",
    );
    expect(classifyFreebuffError(403, JSON.stringify({ status: "country_blocked" })).retryAfterMs).toBe(
      24 * 3600 * 1000,
    );
    expect(classifyFreebuffError(428, "{}").retryAfterMs).toBe(10_000);
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
