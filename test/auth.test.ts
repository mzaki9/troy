import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
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

  test("hashPassword produces an argon2id hash; verifyPassword accepts only the original", async () => {
    const hash = await hashPassword("troy123");
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(await verifyPassword("troy123", "", hash)).toBe(true);
    expect(await verifyPassword("troy124", "", hash)).toBe(false);
    expect(await verifyPassword("troy12", "", hash)).toBe(false);
  });

  test("verifyPassword still accepts legacy salted SHA-256 rows and upgrades are one-way", async () => {
    const salt = "fixed-salt";
    const legacy = createHash("sha256").update(`${salt}:troy123`).digest("hex");
    expect(legacy).toMatch(/^[0-9a-f]{64}$/);
    expect(await verifyPassword("troy123", salt, legacy)).toBe(true);
    expect(await verifyPassword("troy124", salt, legacy)).toBe(false);
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
