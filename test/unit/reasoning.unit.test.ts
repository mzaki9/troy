import { describe, expect, test } from "bun:test";
import { isReasoningModel, resolveEffortAlias } from "../../src/providers/reasoning";

describe("reasoning (pure combinatorics — kept as unit)", () => {
  test("isReasoningModel and resolveEffortAlias", () => {
    expect(isReasoningModel("o3-mini")).toBe(true);
    expect(isReasoningModel("deepseek-r1")).toBe(true);
    expect(isReasoningModel("claude-opus-4.5-thinking")).toBe(true);
    expect(isReasoningModel("gpt-4o")).toBe(false);
    expect(isReasoningModel("deepseek-chat")).toBe(false);
    expect(resolveEffortAlias("o3-mini-high")).toEqual({ model: "o3-mini", effort: "high" });
    expect(resolveEffortAlias("gpt-4o-high").effort).toBeUndefined();
    for (const a of ["low", "medium", "high"]) expect(resolveEffortAlias(`o3-mini-${a}`).effort).toBe(a);
  });
});
