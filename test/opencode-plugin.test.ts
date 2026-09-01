import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { installOpenCodePlugin, openCodePluginDir, renderOpenCodePlugin } from "../src/opencode-plugin";

const realFetch = globalThis.fetch;
afterEach(() => {
  (globalThis as { fetch: unknown }).fetch = realFetch;
});

describe("opencode plugin (integrated via FS + fetch mock)", () => {
  test("render, install, and dir resolution", () => {
    const key = 'sk-"troy"\\${x}';
    expect(renderOpenCodePlugin("http://localhost:31337", key)).toContain(`const API_KEY = ${JSON.stringify(key)};`);
    const dir = join("/tmp/opencode/troy-plugin-test", `${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const first = installOpenCodePlugin({ baseUrl: "http://localhost:31337/", apiKey: "sk-troy-1", dir });
    expect(readFileSync(first.path, "utf8")).toBe(renderOpenCodePlugin("http://localhost:31337/", "sk-troy-1"));
    expect(openCodePluginDir({ XDG_CONFIG_HOME: "/xdg" })).toBe("/xdg/opencode/plugins");
    expect(() => openCodePluginDir({})).toThrow("XDG_CONFIG_HOME");
  });

  test("plugin runtime registers provider + models, handles empty key, 500, and options override", async () => {
    async function loadPlugin(baseUrl: string, apiKey: string) {
      const dir = join("/tmp/opencode/troy-plugin-test", `load-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      const { path } = installOpenCodePlugin({ baseUrl, apiKey, dir });
      return (await import(path)).default as { id: string; setup: (ctx: unknown) => Promise<() => void> };
    }
    (globalThis as unknown as { fetch: unknown }).fetch = async () =>
      new Response(
        JSON.stringify({
          object: "list",
          data: [
            { id: "fast-coding", owned_by: "troy" },
            {
              id: "openai/gpt-4o",
              owned_by: "openai",
              custom: true,
              reasoning: true,
              name: "GPT-4o",
              modalities: ["text", "image"],
              limit: { context: 400000, output: 128000 },
            },
          ],
        }),
        { status: 200 },
      );
    const plugin = await loadPlugin("http://localhost:31337", "sk-secret");
    let providerFn: ((i: Record<string, unknown>) => void) | null = null;
    const modelCalls: { id: string; apply: (d: Record<string, unknown>) => void }[] = [];
    const cleanup = await plugin.setup({
      options: {},
      catalog: {
        transform: async (fn: (c: Record<string, unknown>) => void) =>
          fn({
            provider: { update: (_id: string, fn: (i: Record<string, unknown>) => void) => (providerFn = fn) },
            model: {
              update: (_pid: string, mid: string, fn: (d: Record<string, unknown>) => void) =>
                modelCalls.push({ id: mid, apply: fn }),
            },
          }),
      },
    } as unknown as never);
    const info: Record<string, unknown> = {};
    providerFn!(info);
    expect((info as { name: string }).name).toBe("Troy");
    expect(modelCalls.map((m) => m.id).sort()).toEqual(["fast-coding", "openai/gpt-4o"]);
    cleanup();

    // empty key → no auth, 500 → no transform
    let sawAuth: string | undefined;
    (globalThis as { fetch: unknown }).fetch = async (_url: unknown, init?: RequestInit) => {
      sawAuth = new Headers(init?.headers).get("authorization") ?? undefined;
      return new Response("nope", { status: 500 });
    };
    const p2 = await loadPlugin("http://localhost:31337/v1", "");
    let called = false;
    const c2 = await p2.setup({
      options: {},
      catalog: {
        transform: async () => {
          called = true;
        },
      },
    } as unknown as never);
    expect(sawAuth).toBeUndefined();
    expect(called).toBe(false);
    c2();

    // options override
    let sawUrl = "";
    (globalThis as { fetch: unknown }).fetch = async (url: unknown) => {
      sawUrl = String(url);
      return Response.json({ data: [{ id: "combo/x", owned_by: "troy" }] });
    };
    const p3 = await loadPlugin("http://localhost:31337", "sk-baked");
    const c3 = await p3.setup({
      options: { baseURL: "http://10.0.0.5:40000", apiKey: "sk-opt" },
      catalog: { transform: async () => {} },
    } as unknown as never);
    expect(sawUrl).toBe("http://10.0.0.5:40000/v1/models");
    c3();
    void mkdirSync;
  });
});
