import { describe, expect, test } from "bun:test";
import { Store } from "../src/db";
import { EFFORT_ALIASES, isReasoningModel, resolveEffortAlias } from "../src/reasoning";

describe("isReasoningModel", () => {
  test("known reasoning families", () => {
    for (const m of [
      "o1",
      "o1-mini",
      "o3-mini",
      "o4-mini",
      "gpt-5",
      "gpt-5.2",
      "gpt-5-mini",
      "deepseek-reasoner",
      "deepseek-r1",
      "deepseek-r1-0528",
      "deepseek-v3",
      "deepseek-v4-flash",
      "gemini-2.5-pro",
      "gemini-3-pro-preview",
      "claude-sonnet-4.5",
      "claude-opus-4-6",
      "glm-4.6",
      "glm-5.1",
      "kimi-k2-thinking",
      "kimi-k2-0905-preview",
      "minimax-m2",
      "ernie-4.5-8k",
      "nemotron-3-ultra",
      "qwen3-thinking",
      "qwen3-reasoner",
      "grok-4-fast-reasoning",
    ]) {
      expect(isReasoningModel(m), m).toBe(true);
    }
  });

  test("non-reasoning models", () => {
    for (const m of [
      "gpt-4o",
      "gpt-4o-mini",
      "gpt-4",
      "claude-haiku-3.5",
      "claude-sonnet-3.5",
      "claude-3.5-sonnet",
      "deepseek-chat",
      "gemini-1.5-pro",
      "gemini-2.0-flash",
      "llama-3.3-70b",
      "qwen3-coder-plus",
      "mistral-large",
    ]) {
      expect(isReasoningModel(m), m).toBe(false);
    }
  });
});

describe("resolveEffortAlias", () => {
  test("strips effort alias from reasoning bases", () => {
    expect(resolveEffortAlias("o3-mini-high")).toEqual({ model: "o3-mini", effort: "high" });
    expect(resolveEffortAlias("deepseek/deepseek-reasoner-low")).toEqual({
      model: "deepseek/deepseek-reasoner",
      effort: "low",
    });
    expect(resolveEffortAlias("gpt-5-medium")).toEqual({ model: "gpt-5", effort: "medium" });
  });

  test("leaves non-reasoning bases untouched", () => {
    expect(resolveEffortAlias("gpt-4o-high")).toEqual({ model: "gpt-4o-high", effort: undefined });
    expect(resolveEffortAlias("llama-3.3-70b")).toEqual({ model: "llama-3.3-70b", effort: undefined });
  });

  test("unknown trailing words untouched even on reasoning bases", () => {
    expect(resolveEffortAlias("o3-mini-pro")).toEqual({ model: "o3-mini-pro", effort: undefined });
  });

  test("every effort alias resolves", () => {
    for (const e of EFFORT_ALIASES) {
      const r = resolveEffortAlias(`o1-${e}`);
      expect(r).toEqual({ model: "o1", effort: e });
    }
  });
});

describe("desired models store", () => {
  test("put/list/delete round-trips spec with provider/model split", () => {
    const store = new Store(":memory:");
    store.putModel("openai/gpt-5");
    store.putModel("deepseek/deepseek-chat");
    const rows = store.listModels();
    expect(rows.map((r) => r.spec).sort()).toEqual(["deepseek/deepseek-chat", "openai/gpt-5"]);
    expect(rows.find((r) => r.provider === "deepseek")).toMatchObject({ provider: "deepseek", model: "deepseek-chat" });
    store.deleteModel("openai/gpt-5");
    expect(store.listModels().map((r) => r.spec)).toEqual(["deepseek/deepseek-chat"]);
  });

  test("duplicate put is idempotent and keeps original created_at", () => {
    const store = new Store(":memory:");
    const first = store.putModel("openai/o3-mini");
    const again = store.putModel("openai/o3-mini");
    expect(first.created_at).toBe(again.created_at);
    expect(store.listModels()).toHaveLength(1);
  });

  test("model ids may contain slashes", () => {
    const store = new Store(":memory:");
    store.putModel("together/meta-llama/llama-3.1-70b-instruct");
    const row = store.listModels()[0];
    expect(row.provider).toBe("together");
    expect(row.model).toBe("meta-llama/llama-3.1-70b-instruct");
  });
});
