import { describe, expect, test } from "bun:test";
import { isReasoningModel, resolveEffortAlias } from "../../src/providers/reasoning";

describe("reasoning (pure combinatorics — kept as unit)", () => {
  test("isReasoningModel and resolveEffortAlias", () => {
    expect(isReasoningModel("o3-mini")).toBe(true);
    expect(isReasoningModel("deepseek-r1")).toBe(true);
    expect(isReasoningModel("claude-opus-4.5-thinking")).toBe(true);
    expect(isReasoningModel("gpt-4o")).toBe(false);
    expect(isReasoningModel("deepseek-chat")).toBe(false);
    expect(isReasoningModel("muse-spark-1.3")).toBe(true);
    expect(isReasoningModel("muse-glimmer-30b")).toBe(true);
    expect(resolveEffortAlias("muse-spark-1.3-max")).toEqual({ model: "muse-spark-1.3", effort: "max" });
    expect(resolveEffortAlias("o3-mini-high")).toEqual({ model: "o3-mini", effort: "high" });
    expect(resolveEffortAlias("gpt-4o-high").effort).toBeUndefined();
    // "minimal" is not server-valid — the alias must not resolve it.
    expect(resolveEffortAlias("o3-mini-minimal").effort).toBeUndefined();
    for (const a of ["low", "medium", "high", "xhigh", "max"]) expect(resolveEffortAlias(`o3-mini-${a}`).effort).toBe(a);
  });
});
