import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { clearDshPlugin, dshHome, installDshPlugin, renderDshPlugin } from "../src/dsh-plugin";

// these tests swap globalThis.fetch — restore it after each one, or the mock
// poisons every test file that runs later in the same process (nondeterministic
// file order made CI fail while local passed)
const realFetch = globalThis.fetch;
afterEach(() => {
  (globalThis as { fetch: unknown }).fetch = realFetch;
});

function scratch(name: string): string {
  return join("/tmp/opencode/troy-plugin-test", `${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

describe("renderDshPlugin", () => {
  test("fills both placeholders with escaped values", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: deliberately exercises ${ } escaping in the generated file
    const key = 'sk-"troy"\\${x}';
    const out = renderDshPlugin("http://localhost:31337", key);
    expect(out).not.toContain("__TROY_");
    expect(out).toContain('const BASE_URL = "http://localhost:31337";');
    // JSON-literal escaping survives nasty keys
    expect(out).toContain(`const API_KEY = ${JSON.stringify(key)};`);
  });
});

describe("dshHome", () => {
  test("DSH_HOME wins over HOME, falls back to ~/.dsh, throws with neither", () => {
    expect(dshHome({ DSH_HOME: "/dsh", HOME: "/home/u" })).toBe("/dsh");
    expect(dshHome({ HOME: "/home/u" })).toBe("/home/u/.dsh");
    expect(() => dshHome({})).toThrow("DSH_HOME");
  });
});

describe("installDshPlugin", () => {
  test("writes plugin + patch + credentials, idempotently", () => {
    const home = scratch("install");
    const first = installDshPlugin({ baseUrl: "http://localhost:31337/", apiKey: "sk-troy-1", home });
    expect(first.pluginPath).toBe(join(home, "plugins", "troy-dsh.ts"));
    expect(readFileSync(first.pluginPath, "utf8")).toBe(renderDshPlugin("http://localhost:31337/", "sk-troy-1"));
    expect(first.patchPath).toBe(join(home, "cordis.patch.yml"));
    const patch = readFileSync(first.patchPath, "utf8");
    expect(patch).toContain("- insert:");
    expect(patch).toContain(`name: '${first.pluginPath}'`);
    expect(statSync(first.credentialsPath as string).mode & 0o777).toBe(0o600);
    const creds = readFileSync(first.credentialsPath as string, "utf8");
    expect(creds).toContain("TROY_API_KEY: sk-troy-1");
    // npm dsh parses strictly: keys must live under refs: behind version: 1
    expect(creds.indexOf("refs:")).toBeLessThan(creds.indexOf("TROY_API_KEY"));
    expect(creds).toContain("version: 1");
    // re-install overwrites cleanly
    installDshPlugin({ baseUrl: "http://localhost:31337", apiKey: "sk-troy-2", home });
    expect(readFileSync(first.pluginPath, "utf8")).toBe(renderDshPlugin("http://localhost:31337", "sk-troy-2"));
    expect(readFileSync(first.patchPath, "utf8").match(/id: troy/g)?.length).toBe(1);
    expect(readFileSync(first.credentialsPath as string, "utf8").match(/TROY_API_KEY:/g)?.length).toBe(1);
  });

  test("preserves foreign content around the marker blocks", () => {
    const home = scratch("foreign");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "cordis.patch.yml"), "- insert:\n    - id: other\n      name: '/x/y.ts'\n");
    writeFileSync(join(home, ".credentials.yaml"), "OTHER_KEY: v\n");
    installDshPlugin({ baseUrl: "http://localhost:31337", apiKey: "sk-troy-1", home });
    const patch = readFileSync(join(home, "cordis.patch.yml"), "utf8");
    expect(patch).toContain("id: other");
    expect(patch).toContain("id: troy");
    const creds = readFileSync(join(home, ".credentials.yaml"), "utf8");
    expect(creds).toContain("OTHER_KEY: v");
    expect(creds).toContain("TROY_API_KEY: sk-troy-1");
    // tightening an over-permissive credentials file is part of the install
    writeFileSync(join(home, ".credentials.yaml"), "OTHER_KEY: v\n");
    installDshPlugin({ baseUrl: "http://localhost:31337", apiKey: "sk-troy-1", home });
    expect(statSync(join(home, ".credentials.yaml")).mode & 0o777).toBe(0o600);
  });

  test("empty api key leaves the credentials file alone", () => {
    const home = scratch("nokey");
    const res = installDshPlugin({ baseUrl: "http://localhost:31337", apiKey: "", home });
    expect(res.credentialsPath).toBeNull();
    expect(statSync(join(home, ".credentials.yaml"), { throwIfNoEntry: false })).toBeUndefined();
  });

  test("keys nest under refs: in an already-versioned document", () => {
    const home = scratch("versioned");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, ".credentials.yaml"), "version: 1\nrefs:\n  OTHER_KEY: v\n");
    installDshPlugin({ baseUrl: "http://localhost:31337", apiKey: "sk-troy-1", home });
    const creds = readFileSync(join(home, ".credentials.yaml"), "utf8");
    expect(creds).toContain("  OTHER_KEY: v");
    expect(creds.indexOf("refs:")).toBeLessThan(creds.indexOf("TROY_API_KEY"));
    // re-install keeps exactly one entry
    installDshPlugin({ baseUrl: "http://localhost:31337", apiKey: "sk-troy-2", home });
    expect(readFileSync(join(home, ".credentials.yaml"), "utf8").match(/TROY_API_KEY:/g)?.length).toBe(1);
  });

  test("clear removes our writes and keeps foreign content", () => {
    const home = scratch("clear");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, ".credentials.yaml"), "version: 1\nrefs:\n  OTHER_KEY: v\n");
    writeFileSync(join(home, "cordis.patch.yml"), "- insert:\n    - id: other\n      name: '/x/y.ts'\n");
    installDshPlugin({ baseUrl: "http://localhost:31337", apiKey: "sk-troy-1", home });
    const res = clearDshPlugin({ home });
    expect(res.credentialsPath).not.toBeNull();
    expect(statSync(res.pluginPath, { throwIfNoEntry: false })).toBeUndefined();
    const patch = readFileSync(res.patchPath, "utf8");
    expect(patch).toContain("id: other");
    expect(patch).not.toContain("id: troy");
    const creds = readFileSync(res.credentialsPath as string, "utf8");
    expect(creds).toContain("OTHER_KEY: v");
    expect(creds).not.toContain("TROY_API_KEY");
    // clearing again with nothing of ours left leaves files untouched
    const before = readFileSync(res.patchPath, "utf8");
    clearDshPlugin({ home });
    expect(readFileSync(res.patchPath, "utf8")).toBe(before);
  });
});

describe("rendered plugin behavior", () => {
  /** import the actual shipped file and hand back its apply */
  async function loadApply(baseUrl: string, apiKey: string) {
    const dir = scratch("load");
    const { pluginPath } = installDshPlugin({ baseUrl, apiKey, home: dir });
    const mod = await import(pluginPath);
    return mod.apply as (ctx: unknown) => Promise<void>;
  }

  test("writes the troy provider route into the llm-pi-ai namespace", async () => {
    (globalThis as { fetch: unknown }).fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            data: [
              {
                id: "m/custom",
                name: "Custom",
                custom: true,
                limit: { context: 128000, output: 8192 },
                reasoning: true,
              },
              { id: "combo/x", owned_by: "troy", modalities: ["text", "image"] },
              { id: "catalog/skip", custom: false },
            ],
          }),
          { status: 200 },
        ),
      )) as typeof fetch;

    const updates: Array<{ ns: string; section: unknown }> = [];
    const disposers: Array<() => void> = [];
    const apply = await loadApply("http://localhost:31337/v1///", "sk-live");
    await apply({
      effect: (fn: () => () => void) => disposers.push(fn()),
      settings: { update: async (ns: string, section: unknown) => void updates.push({ ns, section }) },
    });
    for (const dispose of disposers) dispose();

    expect(updates.length).toBe(1);
    expect(updates[0].ns).toBe("llm-pi-ai");
    const route = (updates[0].section as { providers: { troy: Record<string, unknown> } }).providers.troy;
    expect(route.api).toBe("openai-completions");
    expect(route.baseURL).toBe("http://localhost:31337/v1");
    expect(route.apiKeyEnv).toBe("TROY_API_KEY");
    expect(route.displayName).toBe("Troy");
    const models = route.models as Array<Record<string, unknown>>;
    expect(models.map((m) => m.id)).toEqual(["m/custom", "combo/x"]);
    expect(models[0].contextWindow).toBe(128000);
    expect(models[0].maxTokens).toBe(8192);
    expect(models[0].reasoningEfforts).toEqual({ off: null, low: "low", medium: "medium", high: "high" });
    expect(models[1].input).toEqual(["text", "image"]);
    expect(models[1].reasoningEfforts).toBeUndefined();
  });

  test("omits apiKeyEnv when no key and skips the write when nothing is usable", async () => {
    (globalThis as { fetch: unknown }).fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ data: [{ id: "x", custom: false }] }), { status: 200 }),
      )) as typeof fetch;

    const updates: unknown[] = [];
    const apply = await loadApply("http://localhost:31337", "");
    await apply({
      effect: () => () => {},
      settings: { update: async (_ns: string, section: unknown) => void updates.push(section) },
    });
    expect(updates.length).toBe(0);

    (globalThis as { fetch: unknown }).fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ data: [{ id: "y", custom: true }] }), { status: 200 }),
      )) as typeof fetch;
    await apply({
      effect: () => () => {},
      settings: { update: async (_ns: string, section: unknown) => void updates.push(section) },
    });
    const route = (updates[0] as { providers: { troy: Record<string, unknown> } }).providers.troy;
    expect("apiKeyEnv" in route).toBe(false);
  });
});
