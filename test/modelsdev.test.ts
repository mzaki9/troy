import { beforeEach, describe, expect, test } from "bun:test";
import { __setCatalogForTests, enrich, lookup, type ModelsDevCatalog, refreshOnce } from "../src/modelsdev";
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
  // deterministic catalog per test — the real seed is exercised via enrich() below
  __setCatalogForTests({
    "deepseek/deepseek-v4-flash": m("deepseek/deepseek-v4-flash", true, { name: "DeepSeek V4 Flash" }),
    "meta/muse-spark-1.2": m("meta/muse-spark-1.2", true, { input: ["text", "image"], name: "Muse Spark 1.2" }),
    "openai/gpt-4o": m("openai/gpt-4o", false, { input: ["text", "image"] }),
  });
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
  test("models.dev hit carries flags + display name + attachment from modalities", () => {
    const e = enrich("command-code/meta/muse-spark-1.2-contributor");
    expect(e.source).toBe("modelsdev");
    expect(e.reasoning).toBe(true);
    expect(e.name).toBe("Muse Spark 1.2");
    expect(e.attachment).toBe(true); // modalities.input includes image
    expect(e.toolCall).toBe(true);
  });

  test("text-only canonical disables attachment", () => {
    const e = enrich("command-code/deepseek/deepseek-v4-flash");
    expect(e.reasoning).toBe(true);
    expect(e.attachment).toBe(false);
    expect(e.name).toBe("DeepSeek V4 Flash");
  });

  test("regex floor when models.dev has nothing — anchored patterns run on the BARE id", () => {
    __setCatalogForTests({});
    // vendor-prefixed remainder would never match /^deepseek-(v3|v4)/ — the floor
    // tests the last segment, so this is still flagged as a thinker
    const e = enrich("command-code/deepseek/deepseek-v4-flash");
    expect(e.source).toBe("regex");
    expect(e.reasoning).toBe(true);
    expect(e.attachment).toBe(true); // unknown → permissive defaults
    expect(enrich("openai/gpt-4o-mini").reasoning).toBe(false);
  });
});

describe("refreshOnce()", () => {
  test("success swaps the catalog", async () => {
    const payload: ModelsDevCatalog = { "lab/fresh": m("lab/fresh", true, { name: "Fresh" }) };
    const logs: string[] = [];
    const ok = await refreshOnce(
      (s) => logs.push(s),
      async () => new Response(JSON.stringify(payload)),
    );
    expect(ok).toBe(true);
    expect(logs[0]).toContain("1 canonical");
  });

  test("failure keeps the previous snapshot (fail-open)", async () => {
    const before = lookup("deepseek/deepseek-v4-flash");
    const logs: string[] = [];
    const ok = await refreshOnce(
      (s) => logs.push(s),
      async () => new Response("boom", { status: 500 }),
    );
    expect(ok).toBe(false);
    expect(logs[0]).toContain("keeping previous");
    expect(lookup("deepseek/deepseek-v4-flash")).toEqual(before);
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
