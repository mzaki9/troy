import { beforeEach, describe, expect, test } from "bun:test";
import {
  __setCatalogForTests,
  __setProviderCatalogForTests,
  enrich,
  enrichCombo,
  lookup,
  refreshOnce,
} from "../src/modelsdev";
import seed from "../src/modelsdev-seed.json";

function m(id: string, reasoning: boolean, opts: Partial<{ tool_call: boolean; input: string[]; name: string }> = {}) {
  return {
    id,
    name: opts.name ?? id,
    reasoning,
    tool_call: opts.tool_call ?? true,
    ...(opts.input ? { modalities: { input: opts.input } } : {}),
  };
}
beforeEach(() => {
  __setCatalogForTests({
    "deepseek/deepseek-v4-flash": m("deepseek/deepseek-v4-flash", true, { name: "DeepSeek V4 Flash" }),
    "meta/muse-spark-1.2": m("meta/muse-spark-1.2", true, { input: ["text", "image"], name: "Muse Spark 1.2" }),
    "openai/gpt-4o": m("openai/gpt-4o", false, { input: ["text", "image"] }),
  });
  __setProviderCatalogForTests({});
  delete process.env.TROY_ENRICH;
});

describe("lookup + enrich (integrated via seed)", () => {
  test("exact, suffix-stripped, cross-lab, and ambiguous", () => {
    expect(lookup("deepseek/deepseek-v4-flash")?.name).toBe("DeepSeek V4 Flash");
    expect(lookup("meta/muse-spark-1.2-contributor")?.id).toBe("meta/muse-spark-1.2");
    expect(lookup("opencode/deepseek-v4-flash")?.id).toBe("deepseek/deepseek-v4-flash");
    __setCatalogForTests({
      "a/m1": m("a/m1", true),
      "b/m1": m("b/m1", true),
      "x/m2": m("x/m2", true),
      "y/m2": m("y/m2", false),
    });
    expect(lookup("m1")?.id).toBe("a/m1");
    expect(lookup("m2")).toBeUndefined();
    expect(lookup("totally-made-up-model")).toBeUndefined();
  });
  test("provider wins, canonical fallback, regex floor, and TROY_ENRICH layers", () => {
    const prov1 = {
      opencode: {
        models: {
          "muse-spark-1.2-contributor-free": {
            reasoning: true,
            modalities: { input: ["text", "image", "video", "pdf"] },
            limit: { context: 1048576, output: 131072 },
          },
        },
      },
    };
    __setProviderCatalogForTests(prov1 as never);
    const e = enrich("opencode/muse-spark-1.2-contributor-free");
    expect(e.source).toBe("provider");
    expect(e.reasoning).toBe(true);
    expect(e.limit).toEqual({ context: 1048576, output: 131072 });
    const prov2 = {
      meta: { models: { "muse-spark-1.2-contributor": { reasoning: true, limit: { context: 1000, output: 500 } } } },
    };
    __setProviderCatalogForTests(prov2 as never);
    expect(enrich("command-code/meta/muse-spark-1.2-contributor").limit).toEqual({ context: 1000, output: 500 });
    __setProviderCatalogForTests({});
    expect(enrich("command-code/meta/muse-spark-1.2-contributor").source).toBe("canonical");
    __setCatalogForTests({});
    expect(enrich("command-code/deepseek/deepseek-v4-flash").source).toBe("regex");
    expect(enrich("openai/gpt-4o-mini").reasoning).toBe(false);
    process.env.TROY_ENRICH = "";
    __setProviderCatalogForTests(prov2 as never);
    expect(enrich("p/meta/muse-spark-1.2-contributor").limit).toBeUndefined();
    process.env.TROY_ENRICH = "limits";
    expect(enrich("p/meta/muse-spark-1.2-contributor").limit).toEqual({ context: 1000, output: 500 });
  });
  test("enrichCombo lowest-common and empty", () => {
    __setProviderCatalogForTests({
      a: {
        models: {
          big: {
            reasoning: true,
            modalities: { input: ["text", "image"] },
            limit: { context: 1000000, output: 100000 },
          },
        },
      },
      b: {
        models: {
          small: { reasoning: false, modalities: { input: ["text"] }, limit: { context: 128000, output: 8000 } },
        },
      },
    });
    expect(enrichCombo(["a/big", "b/small"])?.reasoning).toBe(false);
    expect(enrichCombo(["a/big", "b/small"])?.limit).toEqual({ context: 128000, output: 8000 });
    expect(enrichCombo([])).toBeUndefined();
  });
});

describe("refreshOnce + seed (integrated)", () => {
  test("success swaps, fail-open keeps snapshot, malformed rejected, seed covers", async () => {
    const okFetch = async (input: string) =>
      new Response(
        input.includes("api.json")
          ? JSON.stringify({ prov: { models: { "some-model": { reasoning: true } } } })
          : JSON.stringify({ "lab/fresh": m("lab/fresh", true, { name: "Fresh" }) }),
      );
    expect(await refreshOnce(() => {}, okFetch)).toEqual({ canonical: true, provider: true });
    expect(lookup("lab/fresh")?.name).toBe("Fresh");
    const before = lookup("lab/fresh");
    expect(
      await refreshOnce(
        () => {},
        async () => new Response("boom", { status: 500 }),
      ),
    ).toEqual({ canonical: false, provider: false });
    expect(lookup("lab/fresh")).toEqual(before);
    const badFetch = async (input: string) =>
      new Response(
        input.includes("api.json") ? JSON.stringify({ prov: { nope: 1 } }) : JSON.stringify({ broken: { id: 5 } }),
      );
    expect(await refreshOnce(() => {}, badFetch)).toEqual({ canonical: false, provider: false });
    __setCatalogForTests({ ...(seed as Record<string, unknown>) } as never);
    expect(typeof enrich("opencode/deepseek-v4-flash-free").reasoning).toBe("boolean");
    expect(enrich("opencode/deepseek-v4-flash-free").name).toBe("DeepSeek V4 Flash");
  });
});
