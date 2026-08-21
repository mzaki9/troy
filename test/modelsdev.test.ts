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

/** minimal canonical entry */
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
  // deterministic catalogs per test — the real seed is exercised separately below
  __setCatalogForTests({
    "deepseek/deepseek-v4-flash": m("deepseek/deepseek-v4-flash", true, { name: "DeepSeek V4 Flash" }),
    "meta/muse-spark-1.2": m("meta/muse-spark-1.2", true, { input: ["text", "image"], name: "Muse Spark 1.2" }),
    "openai/gpt-4o": m("openai/gpt-4o", false, { input: ["text", "image"] }),
  });
  __setProviderCatalogForTests({});
  delete process.env.TROY_ENRICH;
});

describe("lookup()", () => {
  test("exact lab/model key", () => {
    expect(lookup("deepseek/deepseek-v4-flash")?.name).toBe("DeepSeek V4 Flash");
  });

  test("suffix-stripped remainder (reseller variants)", () => {
    expect(lookup("meta/muse-spark-1.2-contributor")?.id).toBe("meta/muse-spark-1.2");
    expect(lookup("deepseek-v4-flash-free")?.id).toBe("deepseek/deepseek-v4-flash");
  });

  test("cross-lab match on bare model part", () => {
    expect(lookup("opencode/deepseek-v4-flash")?.id).toBe("deepseek/deepseek-v4-flash");
  });

  test("ambiguous candidates resolve only when they agree", () => {
    __setCatalogForTests({
      "a/m1": m("a/m1", true),
      "b/m1": m("b/m1", true),
      "x/m2": m("x/m2", true),
      "y/m2": m("y/m2", false),
    });
    expect(lookup("m1")?.id).toBe("a/m1"); // unanimous → resolved
    expect(lookup("m2")).toBeUndefined(); // disagreeing → no guess
  });

  test("unknown id → undefined", () => {
    expect(lookup("totally-made-up-model")).toBeUndefined();
  });
});

describe("enrich()", () => {
  test("provider-exact wins over canonical (limits + modalities served)", () => {
    __setProviderCatalogForTests({
      opencode: {
        models: {
          "muse-spark-1.2-contributor-free": {
            reasoning: true,
            tool_call: true,
            modalities: { input: ["text", "image", "video", "pdf"] },
            limit: { context: 1048576, output: 131072 },
          },
        },
      },
    });
    const e = enrich("opencode/muse-spark-1.2-contributor-free");
    expect(e.source).toBe("provider");
    expect(e.reasoning).toBe(true);
    expect(e.limit).toEqual({ context: 1048576, output: 131072 });
    expect(e.modalities).toEqual(["text", "image", "video", "pdf"]);
    expect(e.attachment).toBe(true);
  });

  test("vendor-prefix split finds provider entry (command-code/meta/…)", () => {
    __setProviderCatalogForTests({
      meta: { models: { "muse-spark-1.2-contributor": { reasoning: true, limit: { context: 1000, output: 500 } } } },
    });
    const e = enrich("command-code/meta/muse-spark-1.2-contributor");
    expect(e.source).toBe("provider");
    expect(e.limit).toEqual({ context: 1000, output: 500 });
  });

  test("canonical fallback carries flags + display name, no limits", () => {
    const e = enrich("command-code/meta/muse-spark-1.2-contributor");
    expect(e.source).toBe("canonical");
    expect(e.reasoning).toBe(true);
    expect(e.name).toBe("Muse Spark 1.2");
    expect(e.attachment).toBe(true); // modalities.input includes image
    expect(e.limit).toBeUndefined();
  });

  test("text-only canonical disables attachment", () => {
    const e = enrich("command-code/deepseek/deepseek-v4-flash");
    expect(e.reasoning).toBe(true);
    expect(e.attachment).toBe(false);
    expect(e.modalities).toEqual(["text"]);
    expect(e.name).toBe("DeepSeek V4 Flash");
  });

  test("regex floor when nothing matches — anchored patterns run on the BARE id", () => {
    __setCatalogForTests({});
    // vendor-prefixed remainder would never match /^deepseek-(v3|v4)/ — the floor
    // tests the last segment, so this is still flagged as a thinker
    const e = enrich("command-code/deepseek/deepseek-v4-flash");
    expect(e.source).toBe("regex");
    expect(e.reasoning).toBe(true);
    expect(e.attachment).toBe(true); // unknown → permissive defaults
    expect(enrich("openai/gpt-4o-mini").reasoning).toBe(false);
  });

  test("TROY_ENRICH='' strips extras; layers re-enable selectively", () => {
    process.env.TROY_ENRICH = "";
    __setProviderCatalogForTests({
      meta: { models: { "muse-spark-1.2-contributor": { reasoning: true, limit: { context: 1000, output: 500 } } } },
    });
    const off = enrich("p/meta/muse-spark-1.2-contributor");
    expect(off.limit).toBeUndefined();
    expect(off.modalities).toBeUndefined();

    process.env.TROY_ENRICH = "limits";
    const limitsOnly = enrich("p/meta/muse-spark-1.2-contributor");
    expect(limitsOnly.limit).toEqual({ context: 1000, output: 500 });
    expect(limitsOnly.modalities).toBeUndefined();
  });
});

describe("enrichCombo()", () => {
  test("lowest-common capability across members", () => {
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
    const e = enrichCombo(["a/big", "b/small"]);
    expect(e?.reasoning).toBe(false); // one member can't think → chain can't
    expect(e?.attachment).toBe(false); // one text-only → chain is text-only
    expect(e?.limit).toEqual({ context: 128000, output: 8000 }); // min of members
  });

  test("all-thinking chain keeps thinking and min limits", () => {
    const e = enrichCombo(["command-code/deepseek/deepseek-v4-flash", "command-code/meta/muse-spark-1.2-contributor"]);
    expect(e?.reasoning).toBe(true);
    expect(e?.limit).toBeUndefined(); // no provider data in this fixture → no limits to min
  });

  test("empty combo → undefined", () => {
    expect(enrichCombo([])).toBeUndefined();
  });
});

describe("refreshOnce()", () => {
  test("success swaps both catalogs", async () => {
    const logs: string[] = [];
    const fetchImpl = async (input: string) =>
      new Response(
        input.includes("api.json")
          ? JSON.stringify({ prov: { models: { "some-model": { reasoning: true } } } })
          : JSON.stringify({ "lab/fresh": m("lab/fresh", true, { name: "Fresh" }) }),
      );
    const r = await refreshOnce((s) => logs.push(s), fetchImpl);
    expect(r).toEqual({ canonical: true, provider: true });
    expect(logs.some((l) => l.includes("canonical refreshed — 1 models"))).toBe(true);
    expect(logs.some((l) => l.includes("provider catalog refreshed — 1 providers"))).toBe(true);
    expect(lookup("lab/fresh")?.name).toBe("Fresh"); // swapped in
  });

  test("failure keeps the previous snapshot (fail-open)", async () => {
    const before = lookup("deepseek/deepseek-v4-flash");
    const logs: string[] = [];
    const r = await refreshOnce(
      (s) => logs.push(s),
      async () => new Response("boom", { status: 500 }),
    );
    expect(r).toEqual({ canonical: false, provider: false });
    expect(logs.filter((l) => l.includes("keeping previous")).length).toBe(2);
    expect(lookup("deepseek/deepseek-v4-flash")).toEqual(before);
  });

  test("malformed payloads are rejected by validation", async () => {
    const logs: string[] = [];
    const fetchImpl = async (input: string) =>
      new Response(
        input.includes("api.json") ? JSON.stringify({ prov: { nope: 1 } }) : JSON.stringify({ broken: { id: 5 } }),
      );
    const r = await refreshOnce((s) => logs.push(s), fetchImpl);
    expect(r).toEqual({ canonical: false, provider: false });
    expect(lookup("deepseek/deepseek-v4-flash")).toBeDefined(); // previous snapshot intact
  });
});

describe("shipped seed", () => {
  test("covers the models this dashboard actually chose", () => {
    __setCatalogForTests({ ...seed });
    for (const [spec, wantReasoning] of [
      ["opencode/deepseek-v4-flash-free", true],
      ["command-code/deepseek/deepseek-v4-flash", true],
      ["command-code/meta/muse-spark-1.2-contributor", true],
      ["opencode/x-preview-f-free", null], // no canonical entry — floor decides, just don't crash
    ] as const) {
      const e = enrich(spec);
      expect(typeof e.reasoning).toBe("boolean");
      if (wantReasoning !== null) expect(e.reasoning).toBe(wantReasoning);
    }
    // suffix-stripped match resolves to the canonical display name
    expect(enrich("opencode/deepseek-v4-flash-free").name).toBe("DeepSeek V4 Flash");
  });
});
