import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Store } from "../src/db";
import { getProvider, inferProvider, PROVIDERS } from "../src/registry";
import { CooldownStore, handleChat, type ChatDeps } from "../src/route";

let stubUrl = "";
let lastReq: { url: string; headers: Record<string, string> } | null = null;

const stub = Bun.serve({
  port: 0,
  async fetch(req) {
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => {
      headers[k] = v;
    });
    lastReq = { url: req.url, headers };
    await req.text();
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  },
});

beforeAll(() => {
  stubUrl = stub.url.toString();
});

afterAll(() => {
  stub.stop(true);
});

function makeDeps(): ChatDeps {
  const store = new Store(":memory:");
  return {
    store,
    cooldowns: new CooldownStore(),
    strategy: "fill-first",
    rtkOn: false,
    cavemanLevel: "off",
    ponytailLevel: "off",
    onLog: () => {},
  };
}

/** Header lookup on the captured request — names arrive lowercased. */
function header(name: string): string | undefined {
  if (!lastReq) return undefined;
  const lk = name.toLowerCase();
  return lastReq.headers[lk] ?? lastReq.headers[name];
}

describe("registry invariants — every provider", () => {
  test("ids unique and resolvable", () => {
    const seen = new Set<string>();
    for (const p of PROVIDERS) {
      expect(seen.has(p.id), `duplicate id ${p.id}`).toBe(false);
      seen.add(p.id);
      expect(getProvider(p.id), `getProvider(${p.id})`).toBe(p);
    }
  });

  test("aliases unique and resolvable", () => {
    const seen = new Map<string, string>();
    for (const p of PROVIDERS) {
      for (const a of p.aliases) {
        const prev = seen.get(a);
        expect(prev, `alias '${a}' claimed by both ${prev} and ${p.id}`).toBeUndefined();
        seen.set(a, p.id);
        expect(getProvider(a), `getProvider(${a})`).toBe(p);
      }
    }
  });

  test("valid chat-completions endpoint + auth + placeholders", () => {
    /* providers whose endpoint is OpenAI-compatible but not at /chat/completions */
    const NON_STANDARD = new Set(["command-code" /* /alpha/generate — works on every tier */]);
    for (const p of PROVIDERS) {
      expect(() => new URL(p.baseUrl), `${p.id} baseUrl parses`).not.toThrow();
      expect(p.baseUrl.startsWith("http"), `${p.id} baseUrl scheme`).toBe(true);
      if (!NON_STANDARD.has(p.id)) {
        expect(p.baseUrl.endsWith("/chat/completions"), `${p.id} must end /chat/completions`).toBe(true);
      }
      expect(["bearer", "raw", "none"]).toContain(p.auth);
      for (const ph of p.placeholders ?? []) {
        expect(p.baseUrl.includes(`{${ph}}`), `${p.id} baseUrl missing {${ph}}`).toBe(true);
      }
      if (p.modelsUrl) expect(() => new URL(p.modelsUrl!), `${p.id} modelsUrl parses`).not.toThrow();
      if (!p.modelsUrl) {
        const derived = p.baseUrl.replace(/\/chat\/completions$/, "/models");
        expect(derived.endsWith("/models"), `${p.id} derives models url`).toBe(true);
      }
    }
  });
});

describe("inferProvider prefix rules", () => {
  test("bare model names map to expected provider", () => {
    expect(inferProvider("gpt-4o").id).toBe("openai");
    expect(inferProvider("claude-sonnet-4").id).toBe("openrouter");
    expect(inferProvider("gemini-2.5-pro").id).toBe("openrouter");
    expect(inferProvider("deepseek-chat").id).toBe("deepseek");
    expect(inferProvider("glm-4.7").id).toBe("zai-cn");
    expect(inferProvider("grok-4").id).toBe("xai");
    expect(inferProvider("unknown-thing").id).toBe("openai");
  });
});

describe("routing — every provider through the stub", () => {
  for (const p of PROVIDERS) {
    test(`${p.id} routes with correct auth + endpoint`, async () => {
      const deps = makeDeps();
      const model = p.id === "opencode" ? "mimo-v2.5-free" : "test-model";
      const extra = p.placeholders?.length
        ? JSON.stringify(Object.fromEntries(p.placeholders.map((k) => [k, `test-${k}`])))
        : undefined;
      deps.store.addConnection({ provider: p.id, api_key: "echo", base_url: stubUrl, extra });

      const res = await handleChat({ model: `${p.id}/${model}`, message: "hi" }, deps);
      expect(res.status, `${p.id} status`).toBe(200);
      expect(lastReq!.url, `${p.id} hits the connection base_url`).toBe(stubUrl);

      const auth = header("authorization") ?? "";
      if (p.auth === "bearer") expect(auth, `${p.id} bearer`).toBe("Bearer echo");
      else if (p.auth === "raw") expect(header("x-api-key"), `${p.id} raw`).toBe("echo");
      else expect(auth, `${p.id} keyless sends no auth`).toBe("");

      for (const [k, v] of Object.entries(p.headers ?? {})) {
        expect(header(k), `${p.id} static header ${k}`).toBe(v);
      }
    });
  }
});
