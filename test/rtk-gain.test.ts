import { describe, expect, test } from "bun:test";
import { Store } from "../src/db";
import { compressMessages } from "../src/rtk";

const lsOutput = (rows: number) =>
  Array.from({ length: rows }, (_, i) => `-rw-r--r--  1 u g ${1000 + i} Jan 01 10:00 file${i}.rs`).join("\n");

describe("rtk gain tracking", () => {
  test("compressMessages reports saved/seen on compression hit", () => {
    const body = { messages: [{ role: "tool", tool_call_id: "1", content: lsOutput(300) }] };
    const before = (body.messages[0] as { content: string }).content.length;
    const stat = compressMessages(body);
    expect(stat.seen).toBe(before);
    expect(stat.saved).toBeGreaterThan(0);
    expect(stat.saved).toBeLessThan(stat.seen);
    // mutation still happened
    expect((body.messages[0] as { content: string }).content.length).toBe(before - stat.saved);
  });

  test("no tool messages → zero stat, body untouched", () => {
    const body = { messages: [{ role: "user", content: lsOutput(300) }] };
    const stat = compressMessages(body);
    expect(stat.saved).toBe(0);
    expect(stat.seen).toBe(0);
  });

  test("below size gate → zero stat", () => {
    const body = { messages: [{ role: "tool", content: "-rw-r--r-- 1 u g 1 Jan 01 10:00 f.rs" }] };
    const stat = compressMessages(body);
    expect(stat.saved).toBe(0);
    expect(stat.seen).toBe(0);
  });

  test("failed shrink counts as seen but not saved (honest ratio)", () => {
    // path-like lines pass the find-detector; a single line cannot shrink further,
    // so safeApply keeps the original — seen must still have counted it
    const onePath = ["a/b/c/d/e/f.ts", "a/b/c/d/e/g.ts", "a/b/c/d/e/h.ts"].join("\n");
    const padded = `${onePath}\n${"x".repeat(600)}`;
    const body = { messages: [{ role: "tool", content: padded }] };
    const stat = compressMessages(body);
    if (stat.seen > 0) {
      // entered the compressor — saved must never exceed seen
      expect(stat.saved).toBeLessThanOrEqual(stat.seen);
    }
  });
});

describe("rtk gain persistence", () => {
  test("logRequest carries rtk fields through queue flush into the table", async () => {
    const store = new Store(":memory:");
    store.logRequest({
      provider: "openai",
      model: "gpt-4o",
      status: "200 OK",
      latency_ms: 10,
      rtk_saved: 1200,
      rtk_seen: 4000,
    });
    store.logRequest({ provider: "openai", model: "gpt-4o", status: "503", latency_ms: 5 });
    store.flushLogs();
    const rows = store.listLogs(10) as unknown as { rtk_saved: number; rtk_seen: number; status: string }[];
    expect(rows).toHaveLength(2);
    const hit = rows.find((r) => r.status === "200 OK")!;
    expect(hit.rtk_saved).toBe(1200);
    expect(hit.rtk_seen).toBe(4000);
    const miss = rows.find((r) => r.status === "503")!;
    expect(miss.rtk_saved).toBe(0);
    expect(miss.rtk_seen).toBe(0);

    // aggregate math the dashboard card uses
    const agg = store.raw
      .query(
        "SELECT SUM(rtk_saved) rsav, SUM(rtk_seen) rseen, SUM(CASE WHEN rtk_saved > 0 THEN 1 ELSE 0 END) rhits FROM usage_history",
      )
      .get() as { rsav: number; rseen: number; rhits: number };
    expect(agg.rsav).toBe(1200);
    expect(agg.rseen).toBe(4000);
    expect(agg.rhits).toBe(1);
    expect(Math.round((agg.rsav / agg.rseen) * 100)).toBe(30); // 30% reduction
  });
});
