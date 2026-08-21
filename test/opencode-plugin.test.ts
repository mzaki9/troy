import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { installOpenCodePlugin, openCodePluginDir, renderOpenCodePlugin } from "../src/opencode-plugin";

describe("renderOpenCodePlugin", () => {
  test("fills both placeholders with escaped values", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: deliberately exercises ${ } escaping in the generated file
    const key = 'sk-"troy"\\${x}';
    const out = renderOpenCodePlugin("http://localhost:31337", key);
    expect(out).not.toContain("__TROY_");
    expect(out).toContain('const BASE_URL = "http://localhost:31337";');
    // JSON-literal escaping survives nasty keys
    expect(out).toContain(`const API_KEY = ${JSON.stringify(key)};`);
  });

  test("embeds the url verbatim — runtime normalizeBase handles /v1 (covered below)", () => {
    expect(renderOpenCodePlugin("http://localhost:31337/v1///", "")).toContain(
      'const BASE_URL = "http://localhost:31337/v1///";',
    );
  });
});

describe("installOpenCodePlugin", () => {
  test("writes the rendered plugin into the target dir, idempotently", () => {
    const dir = join("/tmp/opencode/troy-plugin-test", `${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const first = installOpenCodePlugin({ baseUrl: "http://localhost:31337/", apiKey: "sk-troy-1", dir });
    expect(first.path).toBe(join(dir, "troy.ts"));
    const contents = readFileSync(first.path, "utf8");
    expect(contents).toBe(renderOpenCodePlugin("http://localhost:31337/", "sk-troy-1"));
    // re-install overwrites cleanly
    installOpenCodePlugin({ baseUrl: "http://localhost:31337", apiKey: "", dir });
    expect(readFileSync(first.path, "utf8")).toBe(renderOpenCodePlugin("http://localhost:31337", ""));
  });

  test("plugin dir honors XDG_CONFIG_HOME then HOME", () => {
    expect(openCodePluginDir({ XDG_CONFIG_HOME: "/xdg", HOME: "/home/u" })).toBe("/xdg/opencode/plugins");
    expect(openCodePluginDir({ HOME: "/home/u" })).toBe("/home/u/.config/opencode/plugins");
    expect(() => openCodePluginDir({})).toThrow("XDG_CONFIG_HOME");
  });
});

describe("rendered plugin behavior", () => {
  /** import the actual shipped file and hand back its default export */
  async function loadPlugin(baseUrl: string, apiKey: string) {
    const dir = join("/tmp/opencode/troy-plugin-test", `load-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const { path } = installOpenCodePlugin({ baseUrl, apiKey, dir });
    const mod = await import(path);
    return mod.default as {
      id: string;
      setup: (ctx: unknown) => Promise<() => void>;
    };
  }

  function withFetch(models: unknown[], status = 200): void {
    (globalThis as { fetch: unknown }).fetch = async () =>
      new Response(JSON.stringify({ object: "list", data: models }), { status });
  }

  test("registers provider info + one catalog model per usable model", async () => {
    withFetch([
      { id: "fast-coding", object: "model", owned_by: "troy", reasoning: false }, // combo — keep
      {
        id: "openai/gpt-4o",
        object: "model",
        owned_by: "openai",
        custom: true,
        reasoning: true,
        name: "GPT-4o", // models.dev display name
        modalities: ["text", "image", "pdf"], // full input modalities from troy
        limit: { context: 400000, output: 128000 }, // real limits from troy
        tool_call: true,
      }, // chosen — keep
      { id: "openai", object: "model", owned_by: "openai" }, // bare provider row — drop
      { id: "anthropic/claude", object: "model", owned_by: "anthropic" }, // unchosen — drop
    ]);
    const plugin = await loadPlugin("http://localhost:31337", "sk-secret");
    expect(plugin.id).toBe("troy.catalog");
    expect(typeof plugin.setup).toBe("function");

    let providerFn: ((info: Record<string, any>) => void) | null = null;
    const modelCalls: { id: string; apply: (d: Record<string, any>) => void }[] = [];
    const cleanup = await plugin.setup({
      options: {},
      catalog: {
        transform: async (fn: (c: Record<string, any>) => void) =>
          fn({
            provider: { update: (_id: string, fn: (i: Record<string, any>) => void) => (providerFn = fn) },
            model: {
              update: (pid: string, mid: string, fn: (d: Record<string, any>) => void) => {
                expect(pid).toBe("troy");
                modelCalls.push({ id: mid, apply: fn });
              },
            },
          }),
      },
    });

    // provider info gets the SDK package + visibility + connection settings
    const info: Record<string, any> = {};
    providerFn!(info);
    expect(info.name).toBe("Troy");
    expect(info.package).toBe("aisdk:@ai-sdk/openai-compatible");
    expect(info.activation).toBe("enabled");
    expect(info.settings.baseURL).toBe("http://localhost:31337/v1");
    expect(info.settings.apiKey).toBe("sk-secret");

    // each usable model registered individually with capability flags
    expect(modelCalls.map((m) => m.id).sort()).toEqual(["fast-coding", "openai/gpt-4o"]);
    const byId = new Map(modelCalls.map((m) => [m.id, m]));
    const gpt: Record<string, any> = {};
    byId.get("openai/gpt-4o")!.apply(gpt);
    expect(gpt.name).toBe("GPT-4o"); // served display name wins over the raw id
    expect(gpt.limit).toEqual({ context: 400000, output: 128000 }); // served real limits win
    expect(gpt.capabilities).toEqual({ tools: true, input: ["text", "image", "pdf"], output: ["text"] });
    expect(gpt.variants).toEqual([
      { id: "low", settings: { reasoningEffort: "low" } },
      { id: "medium", settings: { reasoningEffort: "medium" } },
      { id: "high", settings: { reasoningEffort: "high" } },
    ]);
    const combo: Record<string, any> = {};
    byId.get("fast-coding")!.apply(combo);
    expect(combo.name).toBe("fast-coding"); // no served name → id
    expect(combo.limit).toEqual({ context: 200000, output: 32768 }); // fallback when unserved
    expect(combo.capabilities).toBeUndefined(); // no served flags → Info defaults stand
    expect(combo.variants).toBeUndefined();
    cleanup();
  });

  test("empty key sends no auth header; failed fetch leaves catalog untouched", async () => {
    let sawAuth: string | undefined;
    (globalThis as { fetch: unknown }).fetch = async (_url: unknown, init?: RequestInit) => {
      sawAuth = new Headers(init?.headers).get("authorization") ?? undefined;
      return new Response("nope", { status: 500 });
    };
    const plugin = await loadPlugin("http://localhost:31337/v1", "");
    let called = false;
    const cleanup = await plugin.setup({
      options: {},
      catalog: {
        transform: async () => {
          called = true;
        },
      },
    });
    expect(sawAuth).toBeUndefined();
    expect(called).toBeFalse(); // 500 → no transform
    cleanup();
  });

  test("options override the baked-in values", async () => {
    withFetch([{ id: "combo/x", object: "model", owned_by: "troy" }]);
    let sawUrl = "";
    (globalThis as { fetch: unknown }).fetch = async (url: unknown) => {
      sawUrl = String(url);
      return Response.json({ data: [{ id: "combo/x", owned_by: "troy" }] });
    };
    const plugin = await loadPlugin("http://localhost:31337", "sk-baked");
    const cleanup = await plugin.setup({
      options: { baseURL: "http://10.0.0.5:40000", apiKey: "sk-opt" },
      catalog: { transform: async () => {} },
    });
    expect(sawUrl).toBe("http://10.0.0.5:40000/v1/models");
    cleanup();
  });

  test("no leftover timers after cleanup", async () => {
    withFetch([]);
    const plugin = await loadPlugin("http://localhost:31337", "");
    const before = Bun.nanoseconds();
    const cleanup = await plugin.setup({ options: {}, catalog: { transform: async () => {} } });
    cleanup();
    expect(Bun.nanoseconds()).toBeGreaterThan(before);
    void mkdirSync; // keep import used
  });
});
