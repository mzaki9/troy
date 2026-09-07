import { describe, expect, test } from "bun:test";
import { compressText } from "../../src/rtk";

const pad = (s: string) => `${s}\n${"x".repeat(600)}`;

describe("rtk overflow honesty (real-RTK rule: never +N without recovery)", () => {
  test("grep keeps lineno, shows shown/total + recovery hint", () => {
    const g = pad(Array.from({ length: 15 }, (_, i) => `src/a.ts:${10 + i}: m${i}`).join("\n"));
    const out = compressText(g);
    expect(out).toContain("10: m0");
    expect(out).toContain("10/15 shown");
    expect(out).toContain("narrow pattern or path");
  });
  test("find header counts all, per-dir hint", () => {
    const f = Array.from({ length: 60 }, (_, i) => `./bigdir/file${i}.ts`).join("\n");
    const out = compressText(f);
    expect(out.split("\n")[0]).toBe("60 files in 1 dirs:");
    expect(out).toContain("10/60 shown");
  });
});

describe("rtk detection gaps", () => {
  test("git log --oneline compresses", () => {
    const l = pad(Array.from({ length: 40 }, (_, i) => `abc123${i} fix bug ${i} msg`).join("\n"));
    expect(compressText(l).length).toBeLessThan(l.length);
  });
  test("ls -l with @/+/ACL markers compresses", () => {
    const ls = `total 8\n${Array.from({ length: 30 }, (_, i) => `-rw-r--r--@  1 u g 1000 Jan 01 10:00 f${i}.rs`).join("\n")}`;
    expect(compressText(ls).length).toBeLessThan(ls.length);
  });
  test("long git status compresses", () => {
    const st = pad(
      "On branch main\nChanges not staged for commit:\n\tmodified:   src/a.ts\nUntracked files:\n\tnew.ts\n",
    );
    expect(compressText(st).length).toBeLessThan(st.length);
  });
  test("hex-prose garbage: neutral hint, no git words", () => {
    const h = Array.from({ length: 300 }, (_, i) => `deadbeef line ${i} filler text xxxxxxxxxx`).join("\n");
    const out = compressText(h);
    expect(out.startsWith("deadbeef line 0")).toBe(true);
    expect(out).not.toContain("--since");
  });
  test("diff marker has no rtk-cli name collision", () => {
    const d = pad(
      `diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1 +1,100 @@\n${Array.from({ length: 120 }, (_, i) => `+line ${i} xxxxx`).join("\n")}`,
    );
    expect(compressText(d)).not.toContain("rtk git diff");
  });
});
