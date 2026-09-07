import { afterEach, describe, expect, test } from "bun:test";
import {
  __resetUpdateStateForTests,
  CURRENT_VERSION,
  checkOnce,
  compareVersions,
  getUpdateStatus,
  isNewer,
} from "../../src/update";

afterEach(() => {
  __resetUpdateStateForTests();
  delete process.env.TROY_NO_UPDATE_CHECK;
});

function stubFetch(version: unknown, ok = true, status = 200) {
  return async (_input: string, _init?: RequestInit): Promise<Response> =>
    new Response(JSON.stringify({ version }), { status: ok ? 200 : status });
}

describe("compareVersions", () => {
  test("patch bump is newer", () => {
    expect(compareVersions("0.1.3", "0.1.2")).toBeGreaterThan(0);
    expect(isNewer("0.1.3", "0.1.2")).toBe(true);
  });
  test("equal is not newer", () => {
    expect(compareVersions("0.1.2", "0.1.2")).toBe(0);
    expect(isNewer("0.1.2", "0.1.2")).toBe(false);
  });
  test("older is not newer", () => {
    expect(compareVersions("0.1.1", "0.1.2")).toBeLessThan(0);
    expect(isNewer("0.1.1", "0.1.2")).toBe(false);
  });
  test("numeric not lexical: 0.1.10 > 0.1.2", () => {
    expect(compareVersions("0.1.10", "0.1.2")).toBeGreaterThan(0);
  });
  test("v-prefix and whitespace tolerated", () => {
    expect(isNewer(" v0.1.3 ", "0.1.2")).toBe(true);
  });
  test("release beats prerelease", () => {
    expect(compareVersions("1.0.0", "1.0.0-rc.1")).toBeGreaterThan(0);
  });
  test("malformed latest never newer than real version", () => {
    expect(isNewer("garbage!!", CURRENT_VERSION)).toBe(false);
  });
});

describe("checkOnce with stub fetch", () => {
  test("newer payload flips status", async () => {
    await checkOnce(undefined, stubFetch("9.9.9"));
    const s = getUpdateStatus();
    expect(s.latest).toBe("9.9.9");
    expect(s.updateAvailable).toBe(true);
    expect(s.checkedAt).not.toBeNull();
  });
  test("same-version payload leaves updateAvailable false", async () => {
    await checkOnce(undefined, stubFetch(CURRENT_VERSION));
    const s = getUpdateStatus();
    expect(s.latest).toBe(CURRENT_VERSION);
    expect(s.updateAvailable).toBe(false);
  });
  test("HTTP-500 resolves without throwing, keeps latest null", async () => {
    await checkOnce(undefined, stubFetch(null, false, 500));
    expect(getUpdateStatus().latest).toBeNull();
  });
  test("throwing fetch resolves without throwing", async () => {
    const boom = async (): Promise<Response> => {
      throw new Error("offline");
    };
    await checkOnce(undefined, boom);
    expect(getUpdateStatus().latest).toBeNull();
  });
  test("non-string version keeps latest null", async () => {
    await checkOnce(undefined, stubFetch({ nope: 1 }));
    expect(getUpdateStatus().latest).toBeNull();
  });
});
