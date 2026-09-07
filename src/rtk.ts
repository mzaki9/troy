const MIN_COMPRESS_SIZE = 500;
const RAW_CAP = 10 * 1024 * 1024;
const DETECT_WINDOW = 1024;

const SMART_TRUNCATE_HEAD = 120;
const SMART_TRUNCATE_TAIL = 60;
const SMART_TRUNCATE_MIN_LINES = 250;

const GREP_PER_FILE_MAX = 10;
const GIT_DIFF_HUNK_MAX_LINES = 100;
const GIT_DIFF_MAX_LINES = 500;
const GIT_LOG_MAX_LINES = 200;
const GIT_LOG_SUBJECT_MAX = 120;
const TREE_MAX_LINES = 200;
const FIND_PER_DIR_MAX = 10;
const FIND_TOTAL_DIR_MAX = 20;

function headWindow(text: string) {
  return text.slice(0, DETECT_WINDOW);
}

function gitDiff(diff: string): string {
  const lines = diff.split("\n");
  const result: string[] = [];
  let currentFile = "unknown";
  let added = 0;
  let removed = 0;
  let inHunk = false;
  let hunkShown = 0;
  let hunkSkipped = 0;

  for (const line of lines) {
    if (line.startsWith("diff --git")) {
      if (hunkSkipped > 0) {
        result.push(`  ... (${hunkSkipped} lines truncated)`);
        hunkSkipped = 0;
      }
      if (currentFile !== "unknown" && (added > 0 || removed > 0)) result.push(`  +${added} -${removed}`);
      const parts = line.split(" b/");
      currentFile = parts.length > 1 ? parts.slice(1).join(" b/") : "unknown";
      result.push(`\n${currentFile}`);
      added = removed = 0;
      inHunk = false;
      hunkShown = 0;
    } else if (line.startsWith("@@")) {
      if (hunkSkipped > 0) {
        result.push(`  ... (${hunkSkipped} lines truncated)`);
        hunkSkipped = 0;
      }
      result.push(`  ${line}`);
      inHunk = true;
      hunkShown = 0;
    } else if (inHunk) {
      if (line.startsWith("+") && !line.startsWith("+++")) {
        added += 1;
        if (hunkShown < GIT_DIFF_HUNK_MAX_LINES) {
          result.push(`  ${line}`);
          hunkShown += 1;
        } else hunkSkipped += 1;
      } else if (line.startsWith("-") && !line.startsWith("---")) {
        removed += 1;
        if (hunkShown < GIT_DIFF_HUNK_MAX_LINES) {
          result.push(`  ${line}`);
          hunkShown += 1;
        } else hunkSkipped += 1;
      } else if (hunkShown < GIT_DIFF_HUNK_MAX_LINES && !line.startsWith("\\")) {
        if (hunkShown > 0) {
          result.push(`  ${line}`);
          hunkShown += 1;
        }
      }
    }
    if (result.length >= GIT_DIFF_MAX_LINES) {
      result.push("\n... (more changes truncated)");
      break;
    }
  }
  if (hunkSkipped > 0) result.push(`  ... (${hunkSkipped} lines truncated)`);
  if (currentFile !== "unknown" && (added > 0 || removed > 0)) result.push(`  +${added} -${removed}`);
  result.push("[full output available: re-run with a narrower command or path]");
  return result.join("\n");
}

function isGrepLine(line: string) {
  // strip Windows drive prefix ("C:\..." / "C:/...") so drive colon can't misparse as file:line sep
  const s = /^[A-Za-z]:[\\/]/.test(line) ? line.slice(2) : line;
  const first = s.indexOf(":");
  if (first <= 0) return false;
  const second = s.indexOf(":", first + 1);
  if (second <= first) return false;
  const lineno = s.slice(first + 1, second);
  return /^\d+$/.test(lineno);
}

function grep(text: string): string {
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  let totalMatches = 0;
  const fileMap = new Map<string, { shown: string[]; total: number }>();
  for (const raw of lines) {
    // same drive-letter guard as isGrepLine — bare "a:10:x" is a filename, not a drive
    const drive = /^[A-Za-z]:[\\/]/.test(raw) ? raw.slice(0, 2) : "";
    const line = drive ? raw.slice(2) : raw;
    if (!isGrepLine(line)) continue;
    const first = line.indexOf(":");
    const file = drive + line.slice(0, first);
    const m = line.slice(first + 1).match(/^(\d+):(.*)$/);
    if (!m) continue;
    const entry = `${m[1]}: ${m[2].trim()}`;
    let e = fileMap.get(file);
    if (!e) {
      e = { shown: [], total: 0 };
      fileMap.set(file, e);
    }
    e.total += 1;
    if (e.shown.length < GREP_PER_FILE_MAX) e.shown.push(entry);
    totalMatches += 1;
  }
  if (totalMatches === 0) return text;
  const out: string[] = [`${totalMatches} matches in ${fileMap.size} files:`];
  for (const [file, e] of fileMap) {
    out.push(
      e.total > e.shown.length
        ? `[file] ${file} (${e.shown.length}/${e.total} shown):`
        : `[file] ${file} (${e.total}):`,
    );
    for (const c of e.shown) out.push(`  ${c}`);
    if (e.total > e.shown.length)
      out.push(`  ... +${e.total - e.shown.length} more in ${file} (narrow pattern or path)`);
  }
  return out.join("\n");
}

function ls(text: string): string {
  const dirs: string[] = [];
  const files: string[] = [];
  const months = /Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec/;
  for (const line of text.split("\n")) {
    // [@+.] = macOS xattr / ACL / SELinux markers real ls -l emits (ls -l@, ls -l+)
    if (!/^([-dlbcps])([rwx-]{9})[@+.]?[ r]/.test(line)) continue;
    const toks = line.trim().split(/\s+/);
    const dm = toks.findIndex((t) => months.test(t));
    if (dm < 0) continue;
    const name = toks[toks.length - 1];
    if (line[0] === "d") dirs.push(name.replace(/\/$/, ""));
    else files.push(`${name}  ${toks[dm - 1]}B`);
  }
  const extensionCount = new Map<string, number>();
  for (const f of files) {
    const dot = f.lastIndexOf(".");
    if (dot > 0) {
      const ext = f.slice(dot + 1).split(/[\s/]/)[0];
      extensionCount.set(ext, (extensionCount.get(ext) ?? 0) + 1);
    }
  }
  const out: string[] = [];
  for (const d of dirs) out.push(`${d}/`);
  for (const f of files) out.push(f);
  const topExt = [...extensionCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (topExt.length > 0) out.push("", `ext: ${topExt.map(([e, n]) => `${e} ${n}`).join("  ")}`);
  return out.join("\n");
}

function tree(text: string): string {
  const lines = text.split("\n");
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (/\d+ directories, \d+ files/.test(lines[i])) {
      end = i;
      break;
    }
  }
  const body = lines.slice(0, end).filter((l) => l.trim() !== "");
  if (body.length > TREE_MAX_LINES) {
    return [
      ...body.slice(0, TREE_MAX_LINES),
      `... +${body.length - TREE_MAX_LINES} more lines (use narrower path or depth)`,
    ].join("\n");
  }
  return body.join("\n");
}

function find(text: string): string {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
  const dirMap = new Map<string, { shown: string[]; total: number }>();
  for (const line of lines) {
    const i = line.lastIndexOf("/");
    const dir = i >= 0 ? line.slice(0, i + 1) : "./";
    const name = i >= 0 ? line.slice(i + 1) : line;
    let e = dirMap.get(dir);
    if (!e) {
      e = { shown: [], total: 0 };
      dirMap.set(dir, e);
    }
    e.total += 1;
    if (e.shown.length < FIND_PER_DIR_MAX) e.shown.push(name);
  }
  if (dirMap.size === 0) return text;
  const shown = [...dirMap.entries()].slice(0, FIND_TOTAL_DIR_MAX);
  const out: string[] = [];
  let total = 0;
  for (const [, e] of dirMap) total += e.total;
  out.push(`${total} files in ${dirMap.size} dirs:`);
  for (const [dir, e] of shown)
    out.push(
      e.total > e.shown.length ? `${dir}  (${e.shown.length}/${e.total} shown):` : `${dir}  (${e.total}):`,
      ...e.shown.map((n) => `  ${n}`),
      ...(e.total > e.shown.length
        ? [`  ... +${e.total - e.shown.length} more in ${dir} (narrow pattern or path)`]
        : []),
    );
  if (dirMap.size > FIND_TOTAL_DIR_MAX) out.push(`... +${dirMap.size - FIND_TOTAL_DIR_MAX} more dirs`);
  return out.join("\n");
}

function gitStatus(text: string): string {
  // human long form ("On branch…", "modified:  path") carries no machine shape —
  // regroup the indented file lines by section instead of parsing porcelain tokens.
  if (/^On branch /m.test(text) && !porcelainHitRatio(text)) {
    const sections = new Map<string, string[]>();
    let cur: string | null = null;
    for (const line of text.split("\n")) {
      const h = line.match(/^\s*(Changes [^:]+|Untracked files):/);
      if (h) {
        cur = h[1].toLowerCase().includes("not staged")
          ? "modified"
          : h[1].toLowerCase().includes("to be")
            ? "staged"
            : "untracked";
        continue;
      }
      const f = cur && line.match(/^\s+(?:modified|new file|deleted|renamed|copied|typechange):\s+(.+)$/);
      if (f) {
        let e = sections.get(cur!);
        if (!e) {
          e = [];
          sections.set(cur!, e);
        }
        e.push(f[1].trim());
        continue;
      }
      const u = cur === "untracked" && line.match(/^\s+(\S.+)$/);
      if (u && !/^(Untracked|nothing|no changes| {2}\(|\(use |It |$)|\ton /.test(u[1])) {
        let e = sections.get(cur!);
        if (!e) {
          e = [];
          sections.set(cur!, e);
        }
        e.push(u[1].trim());
      }
    }
    const out: string[] = [];
    for (const [k, v] of sections) {
      const uniq = [...new Set(v)];
      out.push(`${k}: ${uniq.length}`, ...uniq.map((x) => `  ${x}`));
    }
    if (out.length > 0) return out.join("\n");
    if (countLines(text) >= SMART_TRUNCATE_MIN_LINES) return smartTruncate(text);
    return text;
  }
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  const groups: Record<string, string[]> = {};
  for (const line of lines) {
    const m = line.match(/^\s*(\?\?|M|A|D|R|C|U|MM| M|AM|\sM|!!)\s+(.+)$/);
    if (!m) continue;
    const key =
      m[1] === "??"
        ? "untracked"
        : m[1].includes("M")
          ? "modified"
          : m[1] === "A"
            ? "added"
            : m[1] === "D"
              ? "deleted"
              : "changed";
    let group = groups[key];
    if (!group) {
      group = [];
      groups[key] = group;
    }
    group.push(m[2]);
  }
  const out: string[] = [];
  for (const [k, v] of Object.entries(groups)) out.push(`${k}: ${v.length}`, ...v.map((f) => `  ${f}`));
  return out.length > 0 ? out.join("\n") : text;
}

function gitLog(text: string): string {
  const out: string[] = [];
  let scanned = 0;
  let fullForm = false;
  for (const line of text.split("\n")) {
    // full "commit <hash>" form (multi-line log) — unambiguous, git-specific hint OK
    const m = line.match(/^[*|/\\ ]*commit ([0-9a-f]{7,40})$/);
    if (m) {
      fullForm = true;
      out.push(m[1]);
    } else {
      // one-line form: "<hash> <subject>" — hash kept, subject capped.
      // bare-hash line also lands here (empty subject → push hash alone).
      // shape-ambiguous with hex-prefixed prose, so the overflow hint stays neutral.
      const o = line.match(/^([0-9a-f]{7,40})\s*(.*)$/);
      if (o && !/^[0-9a-f]+$/.test(o[2].trim())) {
        const subj = o[2].trim().slice(0, GIT_LOG_SUBJECT_MAX).trimEnd();
        out.push(subj ? `${o[1]} ${subj}` : o[1]);
      }
    }
    scanned += 1;
    if (out.length >= GIT_LOG_MAX_LINES || scanned >= GIT_LOG_MAX_LINES * 5) break;
  }
  if (out.length > 0) {
    const total = text.split("\n").filter((l) => l.trim() !== "").length;
    if (total > out.length)
      out.push(
        fullForm
          ? `... +${total - out.length} more commits (narrow with path, --since, or -n)`
          : `... +${total - out.length} more lines`,
      );
    return out.join("\n");
  }
  return text;
}

function smartTruncate(input: string): string {
  const lines = input.split("\n");
  if (lines.length < SMART_TRUNCATE_MIN_LINES) return input;
  const head = lines.slice(0, SMART_TRUNCATE_HEAD);
  const tail = lines.slice(lines.length - SMART_TRUNCATE_TAIL);
  const cut = lines.length - head.length - tail.length;
  return [...head, `... +${cut} lines truncated`, ...tail].join("\n");
}

const RE_GIT_DIFF = /^diff --git /m;
const RE_GIT_DIFF_HUNK = /^@@ /m;
const RE_GIT_STATUS = /^On branch |^nothing to commit|^Changes (not |to be )|^Untracked files:/m;
// full "commit <hash>" line OR oneline "<hash> <subject>" (subject must not be bare hex — ponytail: counts → upgrade path is matching command name, not byte-shape)
const RE_GIT_LOG = /^[*|/\\ ]*commit [0-9a-f]{7,40}$/m;
const RE_GIT_LOG_ONELINE = /^[0-9a-f]{7,40} +\S/m;
const RE_PORCELAIN = /^[ MADRCU?!][ MADRCU?!] \S/m;
const RE_LS_TOTAL = /^total \d+$/m;
// [@+.] = macOS xattr / ACL / SELinux markers real ls -l emits (ls -l@, ls -l+); keep in sync with ls()
const RE_LS_ROW = /^[-dlbcps][rwx-]{9}[@+.]?/m;
const RE_TREE_GLYPH = /[├└]──|│ {2}/;

function isPathLike(line: string) {
  if (line.includes(":")) return false;
  if (line.startsWith(".") || line.startsWith("/") || line.includes("/")) return true;
  return /^[A-Za-z]:[\\/]/.test(line);
}

function porcelainHitRatio(head: string): boolean {
  const nonEmpty = head.split("\n").filter((l) => l.trim() !== "");
  if (nonEmpty.length < 3) return false;
  const hits = nonEmpty.filter((l) => RE_PORCELAIN.test(l)).length;
  return hits / nonEmpty.length >= 0.6;
}

// oneline "<hash> <subject>" is shape-ambiguous (any hex-prefixed prose matches),
// so demand a dominant ratio, not one line — ponytail: exact fix is command-name
// routing (knowing `git log` ran), not byte-shape; upgrade when proxy tags tool names.
function onelineHitRatio(head: string): boolean {
  const nonEmpty = head.split("\n").filter((l) => l.trim() !== "");
  if (nonEmpty.length < 3) return false;
  const hits = nonEmpty.filter((l) => RE_GIT_LOG_ONELINE.test(l)).length;
  return hits / nonEmpty.length >= 0.6;
}

function autoDetectFilter(text: string): ((t: string) => string) | null {
  const head = headWindow(text);
  if (RE_GIT_LOG.test(head)) return gitLog;
  if (onelineHitRatio(head)) return gitLog;
  if (RE_GIT_DIFF.test(head) || RE_GIT_DIFF_HUNK.test(head)) return gitDiff;
  if (RE_GIT_STATUS.test(head)) return gitStatus;
  if (porcelainHitRatio(head)) return gitStatus;
  const fiveLines = head.split("\n").slice(0, 5);
  if (fiveLines.some(isGrepLine)) return grep;
  if (RE_TREE_GLYPH.test(head)) return tree;
  const nonEmpty = head
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
  if (nonEmpty.length >= 3 && nonEmpty.every(isPathLike)) return find;
  if (RE_LS_TOTAL.test(head)) return ls;
  const lsRows = head.split("\n").filter((l) => RE_LS_ROW.test(l));
  if (lsRows.length >= 3) return ls;
  if (countLines(text) >= SMART_TRUNCATE_MIN_LINES) return smartTruncate;
  return null;
}

/** count '\n' without allocating a line array — multi-MB tool outputs land here */
function countLines(text: string): number {
  let n = 1;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) n++;
  return n;
}

function safeApply(fn: (t: string) => string, text: string): string {
  try {
    const out = fn(text);
    return typeof out === "string" && out.length > 0 && out.length < text.length ? out : text;
  } catch {
    return text;
  }
}

/** chars removed / chars that entered the compressor — the gain ratio's two halves */
export interface RtkStat {
  saved: number;
  seen: number;
}

export function compressText(text: string, stat?: RtkStat): string {
  const bytesIn = text.length;
  if (bytesIn < MIN_COMPRESS_SIZE || bytesIn > RAW_CAP) return text;
  const fn = autoDetectFilter(text);
  // seen = every block entering the compressor (size gates passed), filter or not — ratio stays honest
  if (stat) stat.seen += bytesIn;
  if (!fn) return text;
  const out = safeApply(fn, text);
  if (out.length >= bytesIn) return text;
  if (stat) stat.saved += bytesIn - out.length;
  return out;
}

function compressBlock(
  text: string | { type: string; text: string }[],
  stat?: RtkStat,
): string | { type: string; text: string }[] {
  if (typeof text === "string") return compressText(text, stat);
  if (Array.isArray(text)) {
    return text.map((b) => (b.type === "text" ? { ...b, text: compressText(b.text, stat) } : b));
  }
  return text;
}

/** Compress tool-result content blocks. OpenAI `messages[]` and Claude `tool_result` blocks.
 *  Returns how many chars were saved and how many passed through the compressor. */
export function compressMessages(body: unknown): RtkStat {
  const stat: RtkStat = { saved: 0, seen: 0 };
  const b = body as { messages?: unknown[] };
  if (!Array.isArray(b.messages)) return stat;
  for (const msg of b.messages) {
    const m = msg as Record<string, unknown>;
    if (m.role === "tool") {
      if (typeof m.content === "string") {
        m.content = compressText(m.content, stat);
      } else if (Array.isArray(m.content)) {
        m.content = compressBlock(m.content as { type: string; text: string }[], stat);
      }
    } else if (Array.isArray(m.content)) {
      m.content = (m.content as { type?: string; text?: unknown; is_error?: boolean }[]).map((block) => {
        if (block?.type === "tool_result" && !block.is_error && typeof block.text === "string") {
          return { ...block, text: compressText(block.text, stat) };
        }
        return block;
      });
    }
  }
  return stat;
}
