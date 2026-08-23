export interface StubBehavior {
  status: number;
  headers?: Record<string, string>;
  body: string;
}

export interface MockUpstream {
  url: string;
  stub: ReturnType<typeof Bun.serve>;
  behaviors: Map<string, StubBehavior>;
  getLastPayload: () => unknown;
  getLastReq: () => { headers: Record<string, string>; url: string } | null;
  stop: () => void;
  setBehavior: (key: string, b: StubBehavior) => void;
  clear: () => void;
}

/**
 * Mirrors the proven stub from test/route.test.ts:15 — shared mutable
 * behavior map + echo/dead/empty/midstream specials + lastPayload capture.
 * Each test file should create its own instance to stay parallel-safe.
 */
export function createMockUpstream(): MockUpstream {
  const behaviors = new Map<string, StubBehavior>();
  let lastPayload: unknown = null;
  let lastReq: { headers: Record<string, string>; url: string } | null = null;

  const stub = Bun.serve({
    port: 0,
    async fetch(req) {
      const auth = req.headers.get("authorization") ?? "";
      const key = auth.replace(/^Bearer /, "");
      // capture headers/url for provider auth tests
      const hdrs: Record<string, string> = {};
      req.headers.forEach((v, k) => {
        hdrs[k] = v;
      });
      lastReq = { headers: hdrs, url: req.url };
      const text = await req.text().catch(() => "");
      try {
        lastPayload = text ? JSON.parse(text) : null;
      } catch {
        lastPayload = text;
      }
      // freebuff bridges: session + run (leave freebuff untouched per request)
      const path = new URL(req.url).pathname;
      if (path === "/api/v1/freebuff/session") {
        return new Response(JSON.stringify({ status: "active", instanceId: "stub", expiresAt: Date.now() + 60_000 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (path === "/api/v1/agent-runs") {
        try {
          const b = JSON.parse(text || "{}") as { action?: string };
          if (b.action === "FINISH")
            return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
        } catch {}
        return new Response(JSON.stringify({ runId: "test-run-id" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (key === "echo") {
        // echo back the parsed body so route tests can inspect forwarding
        let body: unknown = null;
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
        return Response.json({ echo: body, key }, { status: 200 });
      }
      if (key === "dead") {
        return new Response(
          new ReadableStream({
            start(c) {
              c.error(new Error("connection reset by peer"));
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      if (key === "empty") {
        return new Response(
          new ReadableStream({
            start(c) {
              c.close();
            },
          }),
          { status: 200 },
        );
      }
      if (key === "midstream") {
        const enc = (s: string) => new TextEncoder().encode(s);
        return new Response(
          new ReadableStream({
            async start(c) {
              c.enqueue(enc('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n'));
              await new Promise((r) => setTimeout(r, 10));
              c.enqueue(enc('data: {"choices":[{"delta":{"content":"lo"}}]}\n\n'));
              c.error(new Error("connection reset by peer"));
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      const b = behaviors.get(key);
      if (b?.headers?.["content-type"] === "text/event-stream") {
        return new Response(b.body, { status: b.status, headers: { "content-type": "text/event-stream" } });
      }
      // special case: empty key for keyless providers that send "" api_key
      const fallback = b ?? behaviors.get("");
      const target = b ?? fallback;
      return new Response(target?.body ?? "{}", {
        status: target?.status ?? 200,
        headers: { "content-type": "application/json", ...(target?.headers ?? {}) },
      });
    },
  });

  return {
    url: stub.url.toString().replace(/\/$/, ""),
    stub,
    behaviors,
    getLastPayload: () => lastPayload,
    getLastReq: () => lastReq,
    stop: () => stub.stop(true),
    setBehavior: (k, b) => behaviors.set(k, b),
    clear: () => {
      behaviors.clear();
      lastPayload = null;
      lastReq = null;
    },
  };
}
