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

describe("auth (integrated)", () => {
  test("api key extraction, generation, and constant-time compare", () => {
    expect(
      extractApiKey(new Request("http://troy/v1/models", { headers: { authorization: "Bearer sk-troy-abc" } })),
    ).toBe("sk-troy-abc");
    expect(extractApiKey(new Request("http://troy/v1/models", { headers: { "x-api-key": "sk-troy-abc" } }))).toBe(
      "sk-troy-abc",
    );
    expect(
      extractApiKey(
        new Request("http://troy/v1/models", {
          headers: { authorization: "Bearer sk-troy-a", "x-api-key": "sk-troy-b" },
        }),
      ),
    ).toBe("sk-troy-a");
    expect(extractApiKey(new Request("http://troy/v1/models"))).toBeNull();
    const k1 = generateApiKey();
    expect(k1).toMatch(/^sk-troy-[0-9a-f]{48}$/);
    expect(safeEqual("a", "a")).toBe(true);
    expect(safeEqual("a", "b")).toBe(false);
  });
  test("dashboard password hashing, legacy compat, and session", async () => {
    expect(DEFAULT_DASHBOARD_PASS).toBe("troy123");
    const hash = await hashPassword("troy123");
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(await verifyPassword("troy123", "", hash)).toBe(true);
    expect(await verifyPassword("wrong", "", hash)).toBe(false);
    const legacy = createHash("sha256").update("fixed-salt:troy123").digest("hex");
    expect(await verifyPassword("troy123", "fixed-salt", legacy)).toBe(true);
    expect(newSessionToken()).toMatch(/^[0-9a-f]{64}$/);
    const store = new Store(":memory:");
    store.putDashPass({ salt: "s", hash: "h" });
    expect(store.getDashPass()).toEqual({ salt: "s", hash: "h" });
  });
});
