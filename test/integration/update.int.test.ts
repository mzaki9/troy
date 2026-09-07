import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  __resetUpdateStateForTests,
  __setUpdateStatusForTests,
  CURRENT_VERSION,
  getUpdateStatus,
  startUpdateChecks,
} from "../../src/update";
import { createTestTroy, type TestTroy } from "../helpers/troy";

let t: TestTroy;
beforeEach(() => {
  t = createTestTroy();
});
afterEach(() => {
  t.stop();
  __resetUpdateStateForTests();
  delete process.env.TROY_NO_UPDATE_CHECK;
});

describe("GET /api/update/status", () => {
  test("unauthenticated → 401", async () => {
    const res = await t.fetch("/api/update/status", { noAuth: true });
    expect(res.status).toBe(401);
  });

  test("troy-key → 200 with exact field set", async () => {
    __setUpdateStatusForTests({
      latest: "9.9.9",
      updateAvailable: true,
      checkedAt: "2026-01-01T00:00:00.000Z",
    });
    const res = await t.fetch("/api/update/status");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["checkedAt", "current", "disabled", "latest", "updateAvailable"].sort());
    expect(body).toEqual({
      current: CURRENT_VERSION,
      latest: "9.9.9",
      updateAvailable: true,
      checkedAt: "2026-01-01T00:00:00.000Z",
      disabled: false,
    });
  });

  test("TROY_NO_UPDATE_CHECK=1 → disabled, no network", async () => {
    process.env.TROY_NO_UPDATE_CHECK = "1";
    let calls = 0;
    const stub = async (): Promise<Response> => {
      calls++;
      return new Response(JSON.stringify({ version: "9.9.9" }), { status: 200 });
    };
    const stop = startUpdateChecks(() => {}, stub);
    try {
      const s = getUpdateStatus();
      expect(s.disabled).toBe(true);
      expect(calls).toBe(0);
      const res = await t.fetch("/api/update/status");
      expect(res.status).toBe(200);
      expect(((await res.json()) as { disabled: boolean }).disabled).toBe(true);
    } finally {
      stop();
    }
  });
});
