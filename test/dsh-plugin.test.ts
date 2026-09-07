import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { clearDshPlugin, dshHome, installDshPlugin, renderDshInstaller, renderDshPlugin } from "../src/dsh-plugin";

const realFetch = globalThis.fetch;
afterEach(() => {
  (globalThis as { fetch: unknown }).fetch = realFetch;
});
function scratch(name: string) {
  return join("/tmp/opencode/troy-plugin-test", `${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

describe("dsh plugin (integrated via FS)", () => {
  test("render, home, install idempotent and preserves foreign content", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional fixture with literal ${x}
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

  test("baked-empty template honors TROY_BASE_URL / TROY_API_KEY env", async () => {
    const prevBase = process.env.TROY_BASE_URL;
    const prevKey = process.env.TROY_API_KEY;
    process.env.TROY_BASE_URL = "https://env.example.com";
    process.env.TROY_API_KEY = "sk-env";
    try {
      const dir = scratch("env");
      const { pluginPath } = installDshPlugin({ baseUrl: "", apiKey: "", home: dir });
      const apply = (await import(pluginPath)).apply as (ctx: unknown) => Promise<void>;
      let sawAuth: string | undefined;
      let sawUrl = "";
      (globalThis as { fetch: unknown }).fetch = async (url: unknown, init?: RequestInit) => {
        sawUrl = String(url);
        sawAuth = new Headers(init?.headers).get("authorization") ?? undefined;
        return new Response(JSON.stringify({ data: [{ id: "m/custom", custom: true }] }), { status: 200 });
      };
      const updates: unknown[] = [];
      await apply({
        effect: (fn: () => () => void) => {
          const d = fn();
          return () => d;
        },
        settings: { update: async (_ns: string, section: unknown) => void updates.push(section) },
      } as unknown as never);
      expect(sawUrl).toBe("https://env.example.com/v1/models");
      expect(sawAuth).toBe("Bearer sk-env");
      expect((updates[0] as { providers: { troy: { baseURL: string } } }).providers.troy.baseURL).toBe(
        "https://env.example.com/v1",
      );
    } finally {
      if (prevBase === undefined) delete process.env.TROY_BASE_URL;
      else process.env.TROY_BASE_URL = prevBase;
      if (prevKey === undefined) delete process.env.TROY_API_KEY;
      else process.env.TROY_API_KEY = prevKey;
    }
  });

  test("renderDshInstaller embeds values safely and never leaks the delimiter", () => {
    const key = `sk-a'b$c\`d\\e"f`;
    const script = renderDshInstaller("https://troy.example.com/", key);
    expect(script.split("TROY_DSH_PLUGIN_EOF").length - 1).toBe(2);
    expect(renderDshPlugin("https://troy.example.com/", key)).not.toContain("TROY_DSH_PLUGIN_EOF");
    expect(script).toContain("BASE='https://troy.example.com/'");
  });

  test("installer reproduces installDshPlugin across pre-states and is idempotent", () => {
    const base = "https://troy.example.com";
    const key = `sk-live'b$c\`d`;
    const scriptPath = join(scratch("installer"), "install.sh");
    mkdirSync(dirname(scriptPath), { recursive: true });
    writeFileSync(scriptPath, renderDshInstaller(base, key));
    const run = (home: string) =>
      execFileSync("sh", [scriptPath], { env: { ...process.env, DSH_HOME: home }, stdio: "pipe" });
    // blank-line runs collapse so shell/TS newline style differences don't matter
    const norm = (s: string) => s.replace(/\n{3,}/g, "\n\n").replace(/\n+$/, "\n");
    const atHome = (text: string, home: string) => text.split(home).join("HOME");
    const seed = (home: string, patch: string | null, creds: string | null) => {
      mkdirSync(home, { recursive: true });
      if (patch !== null) writeFileSync(join(home, "cordis.patch.yml"), patch);
      if (creds !== null) writeFileSync(join(home, ".credentials.yaml"), creds);
    };
    for (const [name, patch, creds] of [
      ["missing", null, null],
      ["foreign", "- insert:\n    - id: other\n", "version: 1\nrefs:\n  OTHER_KEY: v\n"],
      ["legacy", "- insert:\n    - id: other\n", "OTHER_KEY: v\n"],
    ] as [string, string | null, string | null][]) {
      const viaSh = scratch(`sh-${name}`);
      seed(viaSh, patch, creds);
      run(viaSh);
      const viaTs = scratch(`ts-${name}`);
      seed(viaTs, patch, creds);
      installDshPlugin({ baseUrl: base, apiKey: key, home: viaTs });
      expect(readFileSync(join(viaSh, "plugins", "troy-dsh.ts"), "utf8")).toBe(renderDshPlugin(base, key));
      expect(norm(atHome(readFileSync(join(viaSh, "cordis.patch.yml"), "utf8"), viaSh))).toBe(
        norm(atHome(readFileSync(join(viaTs, "cordis.patch.yml"), "utf8"), viaTs)),
      );
      expect(norm(atHome(readFileSync(join(viaSh, ".credentials.yaml"), "utf8"), viaSh))).toBe(
        norm(atHome(readFileSync(join(viaTs, ".credentials.yaml"), "utf8"), viaTs)),
      );
      // exactly one marker block, foreign lines retained
      const patchText = readFileSync(join(viaSh, "cordis.patch.yml"), "utf8");
      expect(patchText.match(/# troy-install:start/g)?.length).toBe(1);
      expect(patchText).toContain(`name: '${join(viaSh, "plugins", "troy-dsh.ts")}'`);
      if (patch) expect(patchText).toContain("id: other");
      // second run is a byte-for-byte no-op
      const before = [
        readFileSync(join(viaSh, "plugins", "troy-dsh.ts")),
        readFileSync(join(viaSh, "cordis.patch.yml")),
        readFileSync(join(viaSh, ".credentials.yaml")),
      ];
      run(viaSh);
      expect(readFileSync(join(viaSh, "plugins", "troy-dsh.ts"))).toEqual(before[0]);
      expect(readFileSync(join(viaSh, "cordis.patch.yml"))).toEqual(before[1]);
      expect(readFileSync(join(viaSh, ".credentials.yaml"))).toEqual(before[2]);
    }
    // empty key leaves credentials alone
    const noKey = scratch("sh-nokey");
    seed(noKey, null, "version: 1\nrefs:\n  OTHER_KEY: v\n");
    const emptyPath = join(scratch("installer-empty"), "install.sh");
    mkdirSync(dirname(emptyPath), { recursive: true });
    writeFileSync(emptyPath, renderDshInstaller(base, ""));
    execFileSync("sh", [emptyPath], { env: { ...process.env, DSH_HOME: noKey }, stdio: "pipe" });
    expect(readFileSync(join(noKey, ".credentials.yaml"), "utf8")).toBe("version: 1\nrefs:\n  OTHER_KEY: v\n");
    expect(readFileSync(join(noKey, "plugins", "troy-dsh.ts"), "utf8")).toBe(renderDshPlugin(base, ""));
  });
});
