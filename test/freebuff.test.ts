import { describe, expect, test } from "bun:test";
import {
  agentForModel,
  classifyFreebuffError,
  ensureFreebuffRun,
  ensureFreebuffSession,
  ensureMarker,
  fetchFreebuffCatalog,
  freebuffJsonReply,
  freebuffTokenPaths,
  invalidateFreebuff,
  parseFreebuffToken,
  pauseFreebuff,
  UPSTREAM_UA,
  wrapFreebuff,
} from "../src/providers/freebuff";
import { CooldownStore } from "../src/proxy/cooldown";
import { handleChat } from "../src/proxy/route";
import { Store } from "../src/store/db";

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

describe("freebuff admission gate (integrated)", () => {
  test("model_locked/model_unavailable classify floors at 60s without a hint", async () => {
    for (const [marker, reason] of [
      ["model_locked", "model locked"],
      ["model_unavailable", "model unavailable"],
    ] as const) {
      expect(classifyFreebuffError(409, `{"status":"${marker}"}`)).toMatchObject({ reason, retryAfterMs: 60_000 });
      expect(classifyFreebuffError(429, `{"error":"${marker}"}`)).toMatchObject({ reason, retryAfterMs: 60_000 });
      expect(classifyFreebuffError(200, `{"status":"${marker}","retryAfterMs":9000}`)).toMatchObject({
        reason,
        retryAfterMs: 9000,
      });
    }
    // byte-identical neighbors: 24h country block, 10s 428 floor, no invalidate on model states
    expect(classifyFreebuffError(403, JSON.stringify({ status: "country_blocked" })).retryAfterMs).toBe(
      24 * 3600 * 1000,
    );
    expect(classifyFreebuffError(428, "{}").retryAfterMs).toBe(10_000);
    expect(classifyFreebuffError(409, '{"status":"model_locked"}').invalidate).toBe(false);
    expect(classifyFreebuffError(409, '{"error":"session_superseded"}').invalidate).toBe(true);
  });

  test("admission failure never forwards chat: 60s model-scoped cooldown, zero chat POST", async () => {
    const chatHits: string[] = [];
    const realFetch = globalThis.fetch;
    const model = `admit-locked-${Math.random().toString(36).slice(2, 8)}`;
    (globalThis as Record<string, unknown>).fetch = (async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/api/v1/freebuff/session")) {
        return new Response(JSON.stringify({ status: "model_unavailable" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      chatHits.push(u);
      throw new Error(`chat must never forward, hit ${u} ${init?.method}`);
    }) as unknown as typeof fetch;
    const store = new Store(":memory:");
    const cooldowns = new CooldownStore();
    const account = store.addConnection({ provider: "freebuff", api_key: "cb_test" });
    invalidateFreebuff(account.id);
    try {
      const t0 = Date.now();
      const res = await handleChat(
        { model: `freebuff/${model}`, messages: [{ role: "user", content: "hi" }] },
        {
          store,
          cooldowns,
          strategy: "fill-first",
          rtkOn: false,
          cavemanLevel: "off",
          ponytailLevel: "off",
          onLog: () => {},
        },
      );
      expect(chatHits.length).toBe(0);
      expect(res.status).toBe(503);
      expect(await res.text()).toContain("model unavailable");
      const expiry = cooldowns.lockExpiry(account.id, model);
      expect(expiry - t0).toBeGreaterThanOrEqual(59_000);
      expect(expiry - t0).toBeLessThanOrEqual(61_000);
    } finally {
      (globalThis as Record<string, unknown>).fetch = realFetch;
      invalidateFreebuff(account.id);
    }
  });
});

describe("freebuff live catalog (integrated)", () => {
  const BODY = {
    status: "active",
    freebucks: { prices: { "mimo/mimo-v2.5": 1, "z-ai/glm-5.3-flash": 2, "openai/gpt-5.6-luna": 3 } },
    rateLimitsByModel: { "mimo/mimo-v2.5": {}, "upstage/solar-pro4": {} },
  };
  function catalogFetch(body: unknown, status = 200) {
    const seen: { url: unknown; method?: string; headers?: Record<string, string> }[] = [];
    const f = (async (url: unknown, init?: { method?: string; headers?: Record<string, string> }) => {
      seen.push({ url, method: init?.method, headers: { ...(init?.headers ?? {}) } });
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch;
    return { fetch: f, seen };
  }
  test("prices ∪ rateLimits, deduped + sorted, GET auth-only", async () => {
    const { fetch: f, seen } = catalogFetch(BODY);
    const out = await fetchFreebuffCatalog("https://www.codebuff.com", "tok", f);
    expect(out.url).toBe("https://www.codebuff.com/api/v1/freebuff/session");
    expect(out.models).toEqual(["mimo/mimo-v2.5", "openai/gpt-5.6-luna", "upstage/solar-pro4", "z-ai/glm-5.3-flash"]);
    expect(seen.length).toBe(1);
    expect(seen[0].method).toBe("GET");
    expect(seen[0].url).toBe("https://www.codebuff.com/api/v1/freebuff/session");
    expect(seen[0].headers).toEqual({ authorization: "Bearer tok" });
  });
  test("non-ok throws upstream status", async () => {
    const { fetch: f } = catalogFetch({}, 429);
    await expect(fetchFreebuffCatalog("https://www.codebuff.com", "tok", f)).rejects.toThrow("upstream 429");
  });
  test("malformed shape → empty models", async () => {
    for (const body of ["oops", 42, null, {}, { freebucks: null, rateLimitsByModel: [] }]) {
      const { fetch: f } = catalogFetch(body);
      const out = await fetchFreebuffCatalog("https://www.codebuff.com", "tok", f);
      expect(out.models).toEqual([]);
      expect(out.url).toBe("https://www.codebuff.com/api/v1/freebuff/session");
    }
  });
});
