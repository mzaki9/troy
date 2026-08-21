import { describe, expect, test } from "bun:test";
import {
  DEFAULT_DASHBOARD_PASS,
  extractApiKey,
  generateApiKey,
  hashPassword,
  newSessionToken,
  safeEqual,
  verifyPassword,
} from "../src/dash/auth";
import { Store } from "../src/store/db";

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

describe("dashboard password", () => {
  test("the default password is troy123", () => {
    expect(DEFAULT_DASHBOARD_PASS).toBe("troy123");
  });

  test("hashPassword salts + hashes; verifyPassword accepts only the original", () => {
    const { salt, hash } = hashPassword("troy123");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyPassword("troy123", salt, hash)).toBe(true);
    expect(verifyPassword("troy124", salt, hash)).toBe(false);
    expect(verifyPassword("troy12", salt, hash)).toBe(false);
  });

  test("the same password hashes differently with different salts", () => {
    const a = hashPassword("troy123");
    const b = hashPassword("troy123");
    expect(a.salt).not.toBe(b.salt);
    expect(a.hash).not.toBe(b.hash);
    expect(verifyPassword("troy123", a.salt, a.hash)).toBe(true);
    expect(verifyPassword("troy123", b.salt, b.hash)).toBe(true);
  });

  test("session tokens are opaque, unique, hex strings", () => {
    expect(newSessionToken()).toMatch(/^[0-9a-f]{64}$/);
    expect(newSessionToken()).not.toBe(newSessionToken());
  });

  test("putDashPass/getDashPass round-trips through kv", () => {
    const store = new Store(":memory:");
    expect(store.getDashPass()).toBeNull();
    store.putDashPass({ salt: "s", hash: "h" });
    expect(store.getDashPass()).toEqual({ salt: "s", hash: "h" });
  });
});
