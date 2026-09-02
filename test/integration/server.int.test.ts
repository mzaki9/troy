import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { TAG } from "../../src/logger";
import { cookieHeader, createTestTroy, type TestTroy } from "../helpers/troy";

let t: TestTroy;
beforeEach(() => {
  t = createTestTroy();
});
afterEach(() => {
  t.stop();
});

describe("proxy + dashboard gate (integrated)", () => {
  test("auth gate and dashboard session flow", async () => {
    // proxy: missing/invalid →401, valid →200, x-api-key, toggle off
    expect(
      (
        await t.fetch("/v1/chat/completions", {
          method: "POST",
          body: JSON.stringify({ model: "openai/gpt-4o", messages: [] }),
          noAuth: true,
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(`${t.url}/v1/chat/completions`, {
          method: "POST",
          headers: { authorization: "Bearer wrong", "content-type": "application/json" },
          body: JSON.stringify({ model: "openai/gpt-4o", messages: [] }),
        })
      ).status,
    ).toBe(401);
    t.upstream.setBehavior("upstream-key", { status: 200, body: JSON.stringify({ choices: [] }) });
    t.addConnection("openai", "upstream-key");
    expect(
      (
        await t.fetch("/v1/chat/completions", {
          method: "POST",
          body: JSON.stringify({ model: "openai/gpt-4o", messages: [] }),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await fetch(`${t.url}/v1/chat/completions`, {
          method: "POST",
          headers: { "x-api-key": t.apiKey, "content-type": "application/json" },
          body: JSON.stringify({ model: "openai/gpt-4o", messages: [] }),
        })
      ).status,
    ).toBe(200);
    const { cookie } = await t.login();
    await fetch(`${t.url}/api/key`, {
      method: "PUT",
      headers: { ...cookieHeader(cookie), "content-type": "application/json" },
      body: JSON.stringify({ on: false }),
    });
    expect(
      (
        await fetch(`${t.url}/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "openai/gpt-4o", messages: [] }),
        })
      ).status,
    ).toBe(200);
    // restore auth for next checks
    await fetch(`${t.url}/api/key`, {
      method: "PUT",
      headers: { ...cookieHeader(cookie), "content-type": "application/json" },
      body: JSON.stringify({ on: true }),
    });
    expect((await t.fetch("/v1/chat/completions", { method: "POST", body: "not json" })).status).toBe(400);
    expect((await fetch(`${t.url}/v1/chat/completions`, { method: "OPTIONS" })).status).toBe(204);

    // dashboard session: unauthed, login, authed, logout, password change
    expect(((await (await fetch(`${t.url}/api/session`)).json()) as { authed: boolean }).authed).toBe(false);
    expect(
      (
        await fetch(`${t.url}/api/login`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ password: "wrong" }),
        })
      ).status,
    ).toBe(401);
    const { cookie: c2 } = await t.login("troy123");
    expect(
      ((await (await fetch(`${t.url}/api/session`, { headers: cookieHeader(c2) })).json()) as { authed: boolean })
        .authed,
    ).toBe(true);
    expect((await fetch(`${t.url}/api/combos`, { headers: cookieHeader(c2) })).status).toBe(200);
    expect((await fetch(`${t.url}/api/combos`)).status).toBe(401);
    await fetch(`${t.url}/api/logout`, { method: "POST", headers: cookieHeader(c2) });
    expect(
      ((await (await fetch(`${t.url}/api/session`, { headers: cookieHeader(c2) })).json()) as { authed: boolean })
        .authed,
    ).toBe(false);
    const { cookie: c3 } = await t.login();
    expect(
      (
        await fetch(`${t.url}/api/password`, {
          method: "POST",
          headers: { ...cookieHeader(c3), "content-type": "application/json" },
          body: JSON.stringify({ current: "troy123", next: "ab" }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(`${t.url}/api/password`, {
          method: "POST",
          headers: { ...cookieHeader(c3), "content-type": "application/json" },
          body: JSON.stringify({ current: "wrong", next: "newpass" }),
        })
      ).status,
    ).toBe(403);
    const ch = await fetch(`${t.url}/api/password`, {
      method: "POST",
      headers: { ...cookieHeader(c3), "content-type": "application/json" },
      body: JSON.stringify({ current: "troy123", next: "newpass123" }),
    });
    expect(ch.status).toBe(200);
    expect(
      (
        await fetch(`${t.url}/api/login`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ password: "troy123" }),
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(`${t.url}/api/login`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ password: "newpass123" }),
        })
      ).status,
    ).toBe(200);
  });
  test("read-only model endpoints are session-or-key", async () => {
    expect((await fetch(`${t.url}/api/health`)).status).toBe(200);
    expect((await fetch(`${t.url}/healthz`)).status).toBe(200);
    expect((await fetch(`${t.url}/api/healthz`)).status).toBe(200);
    expect((await fetch(`${t.url}/api/logs`)).status).toBe(401);
    const apiKeyHeaders = { "x-api-key": t.apiKey } as Record<string, string>;
    const r1 = await fetch(`${t.url}/api/models`, { headers: apiKeyHeaders });
    expect([200, 502].includes(r1.status)).toBe(true);
    const r2 = await fetch(`${t.url}/api/providers/freebuff/models`, { headers: apiKeyHeaders });
    expect(r2.status).not.toBe(401);
    expect(r2.status).toBe(200);
    const r2b = await fetch(`${t.url}/api/providers/openai/models`, { headers: apiKeyHeaders });
    expect(r2b.status).not.toBe(401);
    const { cookie } = await t.login();
    const r3b = await fetch(`${t.url}/v1/models`, { headers: cookieHeader(cookie) });
    expect(r3b.status).toBe(200);
    expect((await fetch(`${t.url}/v1/models`)).status).toBe(401);
  });

  test("logger TAG taxonomy", () => {
    expect(TAG.HTTP).toBe("troy:http");
    expect(TAG.AUTH).toBe("troy:auth");
    expect(TAG.PROXY).toBe("troy:proxy");
    expect(TAG.PROVIDER).toBe("troy:provider");
    expect(TAG.STORE).toBe("troy:store");
    expect(TAG.MODELSDEV).toBe("troy:modelsdev");
    expect(TAG.SYSTEM).toBe("troy:system");
  });

  test("provider model probe cache", async () => {
    const key = `cache-${Math.random().toString(36).slice(2, 8)}`;
    t.upstream.setBehavior(key, {
      status: 200,
      body: JSON.stringify({ data: [{ id: "gpt-4o" }, { id: "gpt-4o-mini" }] }),
    });
    t.addConnection("openai", key);
    const hdr = { "x-api-key": t.apiKey } as Record<string, string>;
    const first = await fetch(`${t.url}/api/providers/openai/models`, { headers: hdr });
    expect(first.status).toBe(200);
    const j1 = (await first.json()) as { url: string; models: { id: string }[] };
    expect(j1.models.length).toBe(2);
    expect(first.headers.get("x-cache")).toBeNull();
    const second = await fetch(`${t.url}/api/providers/openai/models`, { headers: hdr });
    expect(second.status).toBe(200);
    expect(second.headers.get("x-cache")).toBe("hit");
    // within TTL upstream failure still served from cache (hit shields it)
    t.upstream.setBehavior(key, { status: 500, body: "boom" });
    const third = await fetch(`${t.url}/api/providers/openai/models`, { headers: hdr });
    expect(third.status).toBe(200);
    expect(third.headers.get("x-cache")).toBe("hit");
  });
});

describe("dashboard CRUD (integrated)", () => {
  test("key, settings, combos, connections, custom providers, models, and catalog", async () => {
    const { cookie } = await t.login();
    const h = cookieHeader(cookie);
    const k1 = (await (await fetch(`${t.url}/api/key`, { headers: h })).json()) as { key: string; on: boolean };
    expect(k1.on).toBe(true);
    const k2 = (await (
      await fetch(`${t.url}/api/key`, {
        method: "PUT",
        headers: { ...h, "content-type": "application/json" },
        body: JSON.stringify({ on: false }),
      })
    ).json()) as { on: boolean };
    expect(k2.on).toBe(false);
    const k3 = (await (await fetch(`${t.url}/api/key/rotate`, { method: "POST", headers: h })).json()) as {
      key: string;
    };
    expect(k3.key).not.toBe(k1.key);

    const s1 = (await (await fetch(`${t.url}/api/settings`, { headers: h })).json()) as { rtk_on: number };
    expect(typeof s1.rtk_on).toBe("number");
    await fetch(`${t.url}/api/settings`, {
      method: "PUT",
      headers: { ...h, "content-type": "application/json" },
      body: JSON.stringify({ rtk_on: 0 }),
    });
    expect(((await (await fetch(`${t.url}/api/settings`, { headers: h })).json()) as { rtk_on: number }).rtk_on).toBe(
      0,
    );

    // combos validation
    expect(
      (
        await fetch(`${t.url}/api/combos`, {
          method: "POST",
          headers: { ...h, "content-type": "application/json" },
          body: JSON.stringify({ models: ["openai/gpt-4o"] }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(`${t.url}/api/combos`, {
          method: "POST",
          headers: { ...h, "content-type": "application/json" },
          body: JSON.stringify({ name: "c", models: ["bad"] }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(`${t.url}/api/combos`, {
          method: "POST",
          headers: { ...h, "content-type": "application/json" },
          body: JSON.stringify({ name: "c", models: ["unknown/m"] }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(`${t.url}/api/combos`, {
          method: "POST",
          headers: { ...h, "content-type": "application/json" },
          body: JSON.stringify({
            name: "my-combo",
            models: ["openai/gpt-4o", "deepseek/deepseek-chat"],
            strategy: "random",
          }),
        })
      ).status,
    ).toBe(200);
    expect(
      ((await (await fetch(`${t.url}/api/combos`, { headers: h })).json()) as { name: string }[]).some(
        (c) => c.name === "my-combo",
      ),
    ).toBe(true);
    await fetch(`${t.url}/api/combos/my-combo`, { method: "DELETE", headers: h });

    // connections
    expect(
      (
        await fetch(`${t.url}/api/connections`, {
          method: "POST",
          headers: { ...h, "content-type": "application/json" },
          body: JSON.stringify({ provider: "openai" }),
        })
      ).status,
    ).toBe(400);
    const conn = (await (
      await fetch(`${t.url}/api/connections`, {
        method: "POST",
        headers: { ...h, "content-type": "application/json" },
        body: JSON.stringify({ provider: "openai", api_key: "k1" }),
      })
    ).json()) as { id: string };
    expect(
      ((await (await fetch(`${t.url}/api/connections`, { headers: h })).json()) as { id: string }[]).some(
        (c) => c.id === conn.id,
      ),
    ).toBe(true);
    expect(
      (
        await fetch(`${t.url}/api/connections/${conn.id}`, {
          method: "PUT",
          headers: { ...h, "content-type": "application/json" },
          body: JSON.stringify({ priority: 10 }),
        })
      ).status,
    ).toBe(200);
    await fetch(`${t.url}/api/connections/${conn.id}`, { method: "DELETE", headers: h });

    // custom providers
    expect(
      (
        await fetch(`${t.url}/api/custom-providers`, {
          method: "POST",
          headers: { ...h, "content-type": "application/json" },
          body: JSON.stringify({ id: "Bad_ID", baseUrl: "https://example.com/v1" }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(`${t.url}/api/custom-providers`, {
          method: "POST",
          headers: { ...h, "content-type": "application/json" },
          body: JSON.stringify({ id: "myprov", baseUrl: "https://example.com/v1/chat/completions" }),
        })
      ).status,
    ).toBe(200);
    await fetch(`${t.url}/api/connections`, {
      method: "POST",
      headers: { ...h, "content-type": "application/json" },
      body: JSON.stringify({ provider: "myprov", api_key: "k" }),
    });
    expect((await fetch(`${t.url}/api/custom-providers/myprov`, { method: "DELETE", headers: h })).status).toBe(200);

    // models
    expect(
      (
        await fetch(`${t.url}/api/models`, {
          method: "POST",
          headers: { ...h, "content-type": "application/json" },
          body: JSON.stringify({ provider: "unknown", model: "m" }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(`${t.url}/api/models`, {
          method: "POST",
          headers: { ...h, "content-type": "application/json" },
          body: JSON.stringify({ provider: "openai", model: "gpt-4o" }),
        })
      ).status,
    ).toBe(200);
    await fetch(`${t.url}/api/models/${encodeURIComponent("openai/gpt-4o")}`, { method: "DELETE", headers: h });

    // catalog + probes
    await fetch(`${t.url}/api/models`, {
      method: "POST",
      headers: { ...h, "content-type": "application/json" },
      body: JSON.stringify({ provider: "openai", model: "gpt-4o" }),
    });
    expect((await t.fetch("/v1/models")).status).toBe(200);
    expect((await fetch(`${t.url}/api/providers`, { headers: h })).status).toBe(200);
    expect((await fetch(`${t.url}/api/stats`, { headers: h })).status).toBe(200);
    expect(
      ((await (await fetch(`${t.url}/api/stats/daily?days=7`, { headers: h })).json()) as { days: unknown[] }).days
        .length,
    ).toBe(7);
    expect((await fetch(`${t.url}/api/logs?limit=10`, { headers: h })).status).toBe(200);
    expect((await fetch(`${t.url}/api/modelsdev/status`, { headers: h })).status).toBe(200);
    expect(
      ((await (await fetch(`${t.url}/api/providers/freebuff/models`, { headers: h })).json()) as { url: string }).url,
    ).toBe("static");
    expect((await fetch(`${t.url}/api/providers/unknown/models`, { headers: h })).status).toBe(404);
    expect(
      typeof (
        (await (await fetch(`${t.url}/api/providers/freebuff/cli-token`, { headers: h })).json()) as { token: string }
      ).token,
    ).toBe("string");
    expect((await fetch(`${t.url}/api/unknown-path-xyz`, { headers: h })).status).toBe(404);
  });
});

describe("proxy E2E via HTTP (integrated)", () => {
  test("combo fallback, cooldown replay, streaming, and RTK", async () => {
    const { cookie } = await t.login();
    const h = cookieHeader(cookie);
    t.upstream.setBehavior("bad", { status: 500, body: "boom" });
    t.upstream.setBehavior("good", {
      status: 200,
      body: JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
    });
    await fetch(`${t.url}/api/connections`, {
      method: "POST",
      headers: { ...h, "content-type": "application/json" },
      body: JSON.stringify({ provider: "openai", api_key: "bad", base_url: t.upstream.url }),
    });
    await fetch(`${t.url}/api/connections`, {
      method: "POST",
      headers: { ...h, "content-type": "application/json" },
      body: JSON.stringify({ provider: "deepseek", api_key: "good", base_url: t.upstream.url }),
    });
    await fetch(`${t.url}/api/combos`, {
      method: "POST",
      headers: { ...h, "content-type": "application/json" },
      body: JSON.stringify({ name: "e2e", models: ["openai/gpt-4o", "deepseek/deepseek-chat"] }),
    });
    expect(
      (
        await t.fetch("/v1/chat/completions", {
          method: "POST",
          body: JSON.stringify({ model: "e2e", messages: [{ role: "user", content: "hi" }] }),
        })
      ).status,
    ).toBe(200);
    t.store.flushLogs();
    expect(t.store.listLogs(10).some((l) => (l as unknown as { provider: string }).provider === "deepseek")).toBe(true);

    // cooldown replay
    t.upstream.setBehavior("bad2", {
      status: 429,
      body: JSON.stringify({ error: { message: "rate limit exceeded" } }),
    });
    t.addConnection("openai", "bad2");
    expect(
      (
        await t.fetch("/v1/chat/completions", {
          method: "POST",
          body: JSON.stringify({ model: "openai/gpt-4o", messages: [{ role: "user", content: "hi" }] }),
        })
      ).status,
    ).toBe(503);
    t.cooldowns.flushPending();
    const events = t.store.foldStateEvents();
    expect(events.some((e) => e.kind === "fail")).toBe(true);
    const { CooldownStore } = await import("../../src/proxy/cooldown");
    const replayed = CooldownStore.replay(events);
    const connId = t.store.listConnections("openai")[0].id;
    expect(replayed.isEligible(connId, "gpt-4o")).toBe(false);

    // streaming passthrough
    const sse = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n';
    t.upstream.setBehavior("skey", { status: 200, headers: { "content-type": "text/event-stream" }, body: sse });
    t.addConnection("openai", "skey");
    const r = await t.fetch("/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "openai/gpt-4o", stream: true, messages: [] }),
    });
    expect(r.status).toBe(200);
    expect(await r.text()).toBe(sse);

    // RTK + caveman
    await fetch(`${t.url}/api/settings`, {
      method: "PUT",
      headers: { ...h, "content-type": "application/json" },
      body: JSON.stringify({ rtk_on: 1, caveman_level: "full" }),
    });
    t.upstream.setBehavior("skey2", { status: 200, body: JSON.stringify({ choices: [] }) });
    t.addConnection("openai", "skey2");
    const rows = Array.from({ length: 300 }, (_, i) => `-rw-r--r--  1 u g ${1000 + i} Jan 01 10:00 file${i}.rs`).join(
      "\n",
    );
    expect(
      (
        await t.fetch("/v1/chat/completions", {
          method: "POST",
          body: JSON.stringify({
            model: "openai/gpt-4o",
            messages: [
              { role: "user", content: "hi" },
              { role: "tool", tool_call_id: "1", content: rows },
            ],
          }),
        })
      ).status,
    ).toBe(200);
    const payload = t.upstream.getLastPayload() as { messages: { role: string; content: string }[] };
    expect(payload.messages.find((m) => m.role === "tool")!.content.length).toBeLessThan(rows.length);
  });
});
