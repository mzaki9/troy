const MIN_COMPRESS_SIZE = 500;
const RAW_CAP = 10 * 1024 * 1024;
const DETECT_WINDOW = 1024;

const SMART_TRUNCATE_HEAD = 120;
const SMART_TRUNCATE_TAIL = 60;
const SMART_TRUNCATE_MIN_LINES = 250;

const GREP_PER_FILE_MAX = 10;
const GIT_DIFF_HUNK_MAX_LINES = 100;
const GIT_DIFF_MAX_LINES = 500;
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
  result.push("[full diff: rtk git diff --no-compact]");
  return result.join("\n");
}

function isGrepLine(line: string) {
  const first = line.indexOf(":");
  if (first <= 0) return false;
  const second = line.indexOf(":", first + 1);
  if (second <= first) return false;
  const lineno = line.slice(first + 1, second);
  return /^\d+$/.test(lineno);
}

function grep(text: string): string {
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  let totalMatches = 0;
  const fileMap = new Map<string, string[]>();
  for (const line of lines) {
    if (!isGrepLine(line)) continue;
    const first = line.indexOf(":");
    const file = line.slice(0, first);
    const content = line
      .slice(first + 1)
      .replace(/^\d+:/, "")
      .trim();
    if (!fileMap.has(file)) fileMap.set(file, []);
    const list = fileMap.get(file)!;
    if (list.length < GREP_PER_FILE_MAX) list.push(content);
    totalMatches += 1;
  }
  if (totalMatches === 0) return text;
  const out: string[] = [`${totalMatches} matches in ${fileMap.size} files:`];
  for (const [file, contents] of fileMap) {
    out.push(`[file] ${file} (${contents.length}):`);
    for (const c of contents) out.push(`  ${c}`);
  }
  return out.join("\n");
}

function ls(text: string): string {
  const dirs: string[] = [];
  const files: string[] = [];
  const months = /Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec/;
  for (const line of text.split("\n")) {
    if (!/^([-dlbcps])([rwx-]{9})[ r]/.test(line)) continue;
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
    return [...body.slice(0, TREE_MAX_LINES), `... +${body.length - TREE_MAX_LINES} more lines`].join("\n");
  }
  return body.join("\n");
}

function find(text: string): string {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
  const dirMap = new Map<string, string[]>();
  for (const line of lines) {
    const i = line.lastIndexOf("/");
    const dir = i >= 0 ? line.slice(0, i + 1) : "./";
    const name = i >= 0 ? line.slice(i + 1) : line;
    if (!dirMap.has(dir)) dirMap.set(dir, []);
    const list = dirMap.get(dir)!;
    if (list.length < FIND_PER_DIR_MAX) list.push(name);
  }
  if (dirMap.size === 0) return text;
  const shown = [...dirMap.entries()].slice(0, FIND_TOTAL_DIR_MAX);
  const out: string[] = [];
  let total = 0;
  for (const [, names] of dirMap) total += names.length;
  out.push(`${total} files in ${dirMap.size} dirs:`);
  for (const [dir, names] of shown) out.push(`${dir}  (${names.length})`, ...names.map((n) => `  ${n}`));
  if (dirMap.size > FIND_TOTAL_DIR_MAX) out.push(`... +${dirMap.size - FIND_TOTAL_DIR_MAX} more dirs`);
  return out.join("\n");
}

function gitStatus(text: string): string {
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
  for (const line of text.split("\n")) {
    const m = line.match(/^[*|/\\ ]*commit ([0-9a-f]{7,40})$/);
    if (m) out.push(`${m[1]}`);
  }
  return out.length > 0 ? out.join("\n") : text;
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
const RE_GIT_LOG = /^[*|/\\ ]*commit [0-9a-f]{7,40}$/m;
const RE_PORCELAIN = /^[ MADRCU?!][ MADRCU?!] \S/m;
const RE_LS_TOTAL = /^total \d+$/m;
const RE_LS_ROW = /^[-dlbcps][rwx-]{9}/m;
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

function autoDetectFilter(text: string): ((t: string) => string) | null {
  const head = headWindow(text);
  if (RE_GIT_LOG.test(head)) return gitLog;
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
  if (text.split("\n").length >= SMART_TRUNCATE_MIN_LINES) return smartTruncate;
  return null;
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
  if (!fn) return text;
  // counted as seen even when the filter fails to shrink — the ratio stays honest
  if (stat) stat.seen += bytesIn;
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
