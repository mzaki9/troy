import { describe, expect, test } from "bun:test";
import { CooldownStore } from "../src/proxy/cooldown";
import { getProvider } from "../src/proxy/registry";
import {
  extractOpencodeSession,
  handleChat,
  OPENCODE_DEFAULT_CLIENT,
  OPENCODE_DEFAULT_UA,
  opencodeHeaders,
} from "../src/proxy/route";
import type { ChatDeps } from "../src/proxy/types";
import { Store } from "../src/store/db";

function req(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/v1/chat/completions", { method: "POST", headers });
}

describe("opencode2 V2 headers", () => {
  test("forwards incoming six-header set verbatim", () => {
    const ctx = extractOpencodeSession(
      req({
        "x-opencode-session": "ses_abc",
        "x-opencode-project": "proj1",
        "x-opencode-client": "cli",
        "x-parent-session-id": "ses_parent",
        "user-agent": "opencode/beta/1.2.3/cli",
      }),
    );
    expect(ctx.session).toBe("ses_abc");
    expect(ctx.project).toBe("proj1");
    expect(ctx.client).toBe("cli");
    expect(ctx.parent).toBe("ses_parent");
    expect(ctx.userAgent).toBe("opencode/beta/1.2.3/cli");
    const h = opencodeHeaders(ctx);
    expect(h["x-opencode-session"]).toBe("ses_abc");
    expect(h["x-session-affinity"]).toBe("ses_abc");
    expect(h["X-Session-Id"]).toBe("ses_abc");
    expect(h["x-opencode-project"]).toBe("proj1");
    expect(h["x-opencode-client"]).toBe("cli");
    expect(h["x-parent-session-id"]).toBe("ses_parent");
    expect(h["User-Agent"]).toBe("opencode/beta/1.2.3/cli");
    expect("x-opencode-request" in h).toBe(false);
  });

  test("falls back to generic affinity headers, synthesizes the rest", () => {
    const ctx = extractOpencodeSession(req({ "x-session-affinity": "ses_xyz", "X-Session-Id": "ses_xyz" }));
    expect(ctx.session).toBe("ses_xyz");
    expect(ctx.client).toBe(OPENCODE_DEFAULT_CLIENT);
    expect(ctx.userAgent).toBe(OPENCODE_DEFAULT_UA);
    expect(ctx.project).toBeUndefined();
    expect(ctx.parent).toBeUndefined();
    const h = opencodeHeaders(ctx);
    expect(h["x-opencode-session"]).toBe("ses_xyz");
    expect("x-opencode-project" in h).toBe(false);
    expect("x-parent-session-id" in h).toBe(false);
  });

  test("synthesizes ses_64hex session when caller sends none", () => {
    const ctx = extractOpencodeSession(req());
    expect(ctx.session).toMatch(/^ses_[0-9a-f]{64}$/);
  });

  test("sanitizes header injection + clamps", () => {
    // real Request rejects CRLF at construction — use a stub to prove
    // the extractor strips it (defense in depth for proxied values)
    const raw: Record<string, string> = {
      "x-opencode-session": "abc\r\nInjected: 1",
      "x-opencode-project": `x${"y".repeat(200)}`,
    };
    const fake = { headers: { get: (k: string) => raw[k.toLowerCase()] ?? null } } as unknown as Request;
    const ctx = extractOpencodeSession(fake);
    expect(ctx.session).toBe("abcInjected: 1");
    expect(ctx.project!.length).toBe(128);
  });

  test("opencode upstream gets full V2 set; other providers get nothing", async () => {
    process.env.TROY_ALLOW_LOOPBACK = "1";
    const seen: { id: string; headers: Record<string, string> }[] = [];
    const stub = Bun.serve({
      port: 0,
      async fetch(r) {
        const headers: Record<string, string> = {};
        r.headers.forEach((v, k) => {
          headers[k] = v;
        });
        const body = await r.json().catch(() => ({}));
        seen.push({ id: String((body as { model?: string }).model ?? ""), headers });
        return Response.json({});
      },
    });
    try {
      const base = stub.url.toString().replace(/\/$/, "");
      const mkDeps = (): ChatDeps => ({
        store: new Store(":memory:"),
        cooldowns: new CooldownStore(),
        strategy: "fill-first",
        rtkOn: false,
        cavemanLevel: "off",
        ponytailLevel: "off",
        opencode: extractOpencodeSession(req({ "x-opencode-session": "ses_live" })),
        onLog: () => {},
      });
      const d1 = mkDeps();
      d1.store.addConnection({ provider: "opencode", api_key: "", base_url: base });
      expect((await handleChat({ model: "opencode/m", messages: [] }, d1)).status).toBe(200);
      const oc = seen[seen.length - 1].headers;
      expect(oc["x-opencode-session"]).toBe("ses_live");
      expect(oc["x-session-affinity"]).toBe("ses_live");
      expect(oc["x-session-id"]).toBe("ses_live");
      expect(oc["user-agent"]).toBe(OPENCODE_DEFAULT_UA);
      expect(oc["x-opencode-client"]).toBe("cli");
      expect(getProvider("opencode")).toBeTruthy();

      const d2 = mkDeps();
      d2.store.addConnection({ provider: "openai", api_key: "echo", base_url: base });
      expect((await handleChat({ model: "openai/m", messages: [] }, d2)).status).toBe(200);
      const oa = seen[seen.length - 1].headers;
      expect(oa["x-opencode-session"] ?? "").toBe("");
      expect(oa["x-session-affinity"] ?? "").toBe("");
      expect(oa["x-opencode-client"] ?? "").toBe("");
    } finally {
      stub.stop(true);
      delete process.env.TROY_ALLOW_LOOPBACK;
    }
  });
});
