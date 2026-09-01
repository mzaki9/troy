import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { clearOmpPlugin, installOmpPlugin, ompAgentDir, renderOmpPlugin } from "../src/omp-plugin";

const realFetch = globalThis.fetch;
afterEach(() => {
  (globalThis as { fetch: unknown }).fetch = realFetch;
});

function scratch(name: string) {
  return join("/tmp/omp/troy-plugin-test", `${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

describe("omp extension (integrated via FS)", () => {
  test("render, dir resolution, install idempotent and preserves foreign extensions", () => {
    const key = 'sk-"troy"\\${x}';
    const out = renderOmpPlugin("http://localhost:31337", key);
    expect(out).toContain(`const API_KEY = ${JSON.stringify(key)};`);
    expect(ompAgentDir({ PI_CODING_AGENT_DIR: "/pi", HOME: "/home/u" })).toBe("/pi");
    expect(ompAgentDir({ HOME: "/home/u" })).toBe("/home/u/.omp/agent");
    expect(() => ompAgentDir({})).toThrow("PI_CODING_AGENT_DIR");

    const agentDir = scratch("install");
    const first = installOmpPlugin({ baseUrl: "http://localhost:31337/", apiKey: "sk-troy-1", agentDir });
    expect(readFileSync(first.extensionPath, "utf8")).toBe(renderOmpPlugin("http://localhost:31337/", "sk-troy-1"));
    expect(first.agentDir).toBe(agentDir);
    installOmpPlugin({ baseUrl: "http://localhost:31337", apiKey: "sk-troy-2", agentDir });
    // still exactly one file, overwritten
    expect(readFileSync(first.extensionPath, "utf8")).toContain(JSON.stringify("sk-troy-2"));

    // foreign extension survives alongside ours
    const agentDir2 = scratch("foreign");
    mkdirSync(join(agentDir2, "extensions"), { recursive: true });
    writeFileSync(join(agentDir2, "extensions", "other.ts"), "export default () => {}");
    installOmpPlugin({ baseUrl: "http://localhost:31337", apiKey: "sk-troy-1", agentDir: agentDir2 });
    expect(readFileSync(join(agentDir2, "extensions", "other.ts"), "utf8")).toBe("export default () => {}");
  });

  test("clear removes only ours and runtime fetches models", async () => {
    const agentDir = scratch("clear");
    mkdirSync(join(agentDir, "extensions"), { recursive: true });
    // foreign file named differently stays
    writeFileSync(join(agentDir, "extensions", "other.ts"), "other");
    installOmpPlugin({ baseUrl: "http://localhost:31337", apiKey: "sk-troy-1", agentDir });
    const res = clearOmpPlugin({ agentDir });
    expect(res.removed).toBe(true);
    expect(statSync(res.extensionPath, { throwIfNoEntry: false })).toBeUndefined();
    expect(readFileSync(join(agentDir, "extensions", "other.ts"), "utf8")).toBe("other");
    // second clear is no-op
    expect(clearOmpPlugin({ agentDir }).removed).toBe(false);

    // foreign troy.ts not ours is not deleted
    const agentDir3 = scratch("foreign-troy");
    mkdirSync(join(agentDir3, "extensions"), { recursive: true });
    writeFileSync(join(agentDir3, "extensions", "troy.ts"), "user custom troy file");
    expect(clearOmpPlugin({ agentDir: agentDir3 }).removed).toBe(false);
    expect(readFileSync(join(agentDir3, "extensions", "troy.ts"), "utf8")).toBe("user custom troy file");

    async function loadExtension(baseUrl: string, apiKey: string) {
      const dir = scratch("load");
      const { extensionPath } = installOmpPlugin({ baseUrl, apiKey, agentDir: dir });
      return (await import(extensionPath)).default as (pi: unknown) => void;
    }

    (globalThis as unknown as { fetch: unknown }).fetch = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            data: [
              {
                id: "m/custom",
                custom: true,
                limit: { context: 128000 },
                reasoning: true,
                modalities: ["text", "image"],
              },
              { id: "catalog/skip", custom: false },
              { id: "combo/name", owned_by: "troy", limit: { context: 50000 } },
            ],
          }),
          { status: 200 },
        ),
      );

    let registered: {
      id: string;
      opts: { baseUrl: string; fetchDynamicModels: (k: string) => Promise<unknown[]> };
    } | null = null;
    const factory = await loadExtension("http://localhost:31337/v1///", "sk-live");
    factory({
      registerProvider: (id: string, opts: unknown) => {
        registered = { id, opts: opts as never };
      },
    });
    expect(registered!.id).toBe("troy");
    expect(registered!.opts.baseUrl).toBe("http://localhost:31337/v1");
    const models = (await registered!.opts.fetchDynamicModels("sk-live")) as { id: string; reasoning: boolean }[];
    expect(models.map((m) => m.id).sort()).toEqual(["combo/name", "m/custom"]);
    expect(models.find((m) => m.id === "m/custom")!.reasoning).toBe(true);
  });
});
