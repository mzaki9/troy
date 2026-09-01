import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { clearDshPlugin, dshHome, installDshPlugin, renderDshPlugin } from "../src/dsh-plugin";

const realFetch = globalThis.fetch;
afterEach(() => {
  (globalThis as { fetch: unknown }).fetch = realFetch;
});
function scratch(name: string) {
  return join("/tmp/opencode/troy-plugin-test", `${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

describe("dsh plugin (integrated via FS)", () => {
  test("render, home, install idempotent and preserves foreign content", () => {
    const key = 'sk-"troy"\\${x}';
    const out = renderDshPlugin("http://localhost:31337", key);
    expect(out).toContain(`const API_KEY = ${JSON.stringify(key)};`);
    expect(dshHome({ DSH_HOME: "/dsh", HOME: "/home/u" })).toBe("/dsh");
    expect(() => dshHome({})).toThrow("DSH_HOME");
    const home = scratch("install");
    const first = installDshPlugin({ baseUrl: "http://localhost:31337/", apiKey: "sk-troy-1", home });
    expect(readFileSync(first.pluginPath, "utf8")).toBe(renderDshPlugin("http://localhost:31337/", "sk-troy-1"));
    expect(readFileSync(first.patchPath, "utf8")).toContain("id: troy");
    expect(first.credentialsPath).not.toBeNull();
    installDshPlugin({ baseUrl: "http://localhost:31337", apiKey: "sk-troy-2", home });
    expect(readFileSync(first.credentialsPath as string, "utf8").match(/TROY_API_KEY:/g)?.length).toBe(1);

    const home2 = scratch("foreign");
    mkdirSync(home2, { recursive: true });
    writeFileSync(join(home2, "cordis.patch.yml"), "- insert:\n    - id: other\n");
    writeFileSync(join(home2, ".credentials.yaml"), "OTHER_KEY: v\n");
    installDshPlugin({ baseUrl: "http://localhost:31337", apiKey: "sk-troy-1", home: home2 });
    expect(readFileSync(join(home2, "cordis.patch.yml"), "utf8")).toContain("id: other");
    expect(readFileSync(join(home2, ".credentials.yaml"), "utf8")).toContain("TROY_API_KEY");
    expect(
      installDshPlugin({ baseUrl: "http://localhost:31337", apiKey: "", home: scratch("nokey") }).credentialsPath,
    ).toBeNull();
  });

  test("clear and plugin runtime behavior via fetch mock", async () => {
    const home = scratch("clear");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, ".credentials.yaml"), "version: 1\nrefs:\n  OTHER_KEY: v\n");
    installDshPlugin({ baseUrl: "http://localhost:31337", apiKey: "sk-troy-1", home });
    const res = clearDshPlugin({ home });
    expect(statSync(res.pluginPath, { throwIfNoEntry: false })).toBeUndefined();
    expect(readFileSync(res.credentialsPath as string, "utf8")).not.toContain("TROY_API_KEY");

    async function loadApply(baseUrl: string, apiKey: string) {
      const dir = scratch("load");
      const { pluginPath } = installDshPlugin({ baseUrl, apiKey, home: dir });
      return (await import(pluginPath)).apply as (ctx: unknown) => Promise<void>;
    }
    (globalThis as unknown as { fetch: unknown }).fetch = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            data: [
              { id: "m/custom", custom: true, limit: { context: 128000 }, reasoning: true },
              { id: "catalog/skip", custom: false },
            ],
          }),
          { status: 200 },
        ),
      );
    const updates: unknown[] = [];
    const apply = await loadApply("http://localhost:31337/v1///", "sk-live");
    await apply({
      effect: (fn: () => () => void) => {
        const d = fn();
        return () => d;
      },
      settings: { update: async (_ns: string, section: unknown) => void updates.push(section) },
    } as unknown as never);
    expect(updates.length).toBe(1);
    expect((updates[0] as { providers: { troy: { baseURL: string } } }).providers.troy.baseURL).toBe(
      "http://localhost:31337/v1",
    );
  });
});
