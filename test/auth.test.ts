import { describe, expect, test } from "bun:test";
import { extractApiKey, generateApiKey, safeEqual } from "../src/auth";

describe("troy api key auth", () => {
  test("extracts a Bearer token", () => {
    const req = new Request("http://troy/v1/models", { headers: { authorization: "Bearer sk-troy-abc" } });
    expect(extractApiKey(req)).toBe("sk-troy-abc");
  });

  test("extracts x-api-key as an alternative", () => {
    const req = new Request("http://troy/v1/models", { headers: { "x-api-key": "sk-troy-abc" } });
    expect(extractApiKey(req)).toBe("sk-troy-abc");
  });

  test("returns the bearer header when x-api-key is also present (bearer wins)", () => {
    const req = new Request("http://troy/v1/models", {
      headers: { authorization: "Bearer sk-troy-a", "x-api-key": "sk-troy-b" },
    });
    expect(extractApiKey(req)).toBe("sk-troy-a");
  });

  test("returns null when no key is sent", () => {
    expect(extractApiKey(new Request("http://troy/v1/models"))).toBeNull();
    const empty = new Request("http://troy/v1/models", { headers: { authorization: "Bearer" } });
    expect(extractApiKey(empty)).toBeNull();
  });

  test("generates prefixed hex keys of the expected shape", () => {
    const key = generateApiKey();
    expect(key).toMatch(/^sk-troy-[0-9a-f]{48}$/);
    expect(generateApiKey()).not.toBe(key);
  });

  test("safeEqual compares in constant time and matches only exact values", () => {
    expect(safeEqual("sk-troy-abc", "sk-troy-abc")).toBe(true);
    expect(safeEqual("sk-troy-abc", "sk-troy-abd")).toBe(false);
    expect(safeEqual("sk-troy-abc", "sk-troy-ab")).toBe(false);
    expect(safeEqual("", "")).toBe(true);
  });
});
