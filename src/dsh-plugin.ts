import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * DeepSeek Harness (dsh) plugin — registers troy as a live dsh provider.
 *
 * The plugin source ships as a template here and is written verbatim into
 * `<dsh home>/plugins/troy-dsh.ts` by POST /api/install-dsh-plugin, referenced
 * from `<dsh home>/cordis.patch.yml` (a user patch layer every dsh surface
 * hot-watches) with the api key stored in `<dsh home>/.credentials.yaml`.
 * It must stay dependency-free (plain `apply` export, zero imports):
 * dsh does NOT install dependencies for local plugin files.
 */

const TEMPLATE = `/**
 * troy — live DeepSeek Harness provider plugin (installed by troy's dashboard).
 *
 * Writes every chosen model + combo as the "troy" route under dsh's llm-pi-ai
 * settings namespace, refreshing every 60s, so picking a model in troy's
 * dashboard shows up in dsh without touching any config. Re-install from the
 * dashboard (Tools page), or override without editing via TROY_BASE_URL /
 * TROY_API_KEY env vars, or edit the two lines below.
 */
const BASE_URL = "__TROY_BASE_URL__";
const API_KEY = __TROY_API_KEY__;

/** strip trailing slashes, keep exactly one /v1 suffix */
function normalizeBase(url) {
  const trimmed = String(url || "").replace(/\\/+$/, "");
  if (!trimmed) throw new Error("troy plugin: empty baseURL");
  return trimmed.endsWith("/v1") ? trimmed : trimmed + "/v1";
}

/** only chosen specs (custom) and combos (owned_by "troy") are usable */
function usableModels(rows) {
  return (Array.isArray(rows) ? rows : []).filter(
    (m) => m && typeof m.id === "string" && (m.custom === true || m.owned_by === "troy"),
  );
}

/** one troy /models row → one llm-pi-ai model entry */
function modelEntry(m) {
  const entry = { id: m.id, name: m.name || m.id };
  if (m.limit && m.limit.context) entry.contextWindow = m.limit.context;
  if (m.limit && m.limit.output) entry.maxTokens = m.limit.output;
  if (Array.isArray(m.modalities)) {
    // only meaningful beyond dsh's [text] default; dsh allows text/image here
    const input = m.modalities.filter((x) => x === "text" || x === "image");
    if (input.length > 1) entry.input = input;
  }
  // thinking models get selectable levels ("off" sends nothing on the wire;
  // dsh's schema wants null there, an empty string is rejected)
  if (m.reasoning === true) {
    entry.reasoningEfforts = { off: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" };
  }
  return entry;
}

export const name = "troy-catalog";
export const inject = ["settings"];

export async function apply(ctx) {
  const base = normalizeBase(
    typeof process !== "undefined" && process.env && process.env.TROY_BASE_URL ? process.env.TROY_BASE_URL : BASE_URL,
  );
  const KEY = (typeof process !== "undefined" && process.env && process.env.TROY_API_KEY) || API_KEY;

  async function refresh() {
    const res = await fetch(base + "/models", {
      headers: KEY ? { authorization: "Bearer " + KEY } : {},
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error("troy /models returned " + res.status);
    const data = await res.json();
    const models = usableModels(data.data).map(modelEntry);
    if (!models.length) return;
    const profile = {
      displayName: "Troy",
      api: "openai-completions",
      baseURL: base,
      ...(KEY ? { apiKeyEnv: "TROY_API_KEY" } : {}),
      models,
    };
    // merge-patch into the llm-pi-ai namespace — schema-validated there and
    // effective on the next request, so a stale list self-heals next poll
    await ctx.settings.update("llm-pi-ai", { providers: { troy: profile } });
  }

  const tick = () => refresh().catch((err) => console.error("[troy] " + (err?.message ?? err)));
  let timer;
  ctx.effect(() => () => clearInterval(timer));
  await tick();
  timer = setInterval(tick, 60_000);
}
`;

/** Fill the template with a troy origin + api key (values are JS-literal-escaped). */
export function renderDshPlugin(baseUrl: string, apiKey: string): string {
  return TEMPLATE.replace("__TROY_BASE_URL__", () => JSON.stringify(baseUrl).slice(1, -1)).replace(
    "__TROY_API_KEY__",
    () => JSON.stringify(apiKey),
  );
}

/** Delimiter for the plugin heredoc in the remote installer (the rendered plugin must never contain it). */
const DSH_INSTALL_DELIMITER = "TROY_DSH_PLUGIN_EOF";

/** Single-quote a baked value for POSIX sh (`'` → `'\''`). */
function shSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Render a POSIX `sh` installer reproducing installDshPlugin on any machine:
 * plugin file, patch entry, credentials. Pure string builder — served by
 * GET /api/plugin/dsh.sh for one-copy-paste remote installs. The plugin
 * source rides in a quoted heredoc; KEY with `'`, `$`, backtick stays intact.
 */
export function renderDshInstaller(baseUrl: string, apiKey: string): string {
  const lines = [
    "#!/bin/sh",
    "# troy dsh remote installer (rendered by the dashboard Tools page).",
    "# Idempotent — a second run changes nothing.",
    "set -eu",
    `BASE=${shSingleQuote(baseUrl)}`,
    `KEY=${shSingleQuote(apiKey)}`,
    // biome-ignore lint/suspicious/noTemplateCurlyInString: POSIX parameter expansion in generated installer, not a JS template
    'DSH_HOME="${DSH_HOME:-$HOME/.dsh}"',
    'PLUGIN="$DSH_HOME/plugins/troy-dsh.ts"',
    'PATCH="$DSH_HOME/cordis.patch.yml"',
    'CREDS="$DSH_HOME/.credentials.yaml"',
    'mkdir -p "$DSH_HOME/plugins"',
    `cat > "$PLUGIN" <<'${DSH_INSTALL_DELIMITER}'`,
  ];
  const out = [...lines, renderDshPlugin(baseUrl, apiKey).replace(/\n+$/, ""), DSH_INSTALL_DELIMITER];
  out.push(
    "strip_markers() {",
    "  # drop our block (trimmed-marker match) and trailing blank lines, so a re-run rebuilds the same bytes",
    '  awk \'{ line=$0; sub(/^[[:space:]]+/, "", line); sub(/[[:space:]]+$/, "", line); if (line == "# troy-install:start") { skip=1; next } if (line == "# troy-install:end") { skip=0; next } if (!skip) { n++; buf[n]=$0 } } END { while (n > 0 && buf[n] ~ /^[[:space:]]*$/) n--; for (i=1; i<=n; i++) print buf[i] }\' "$1"',
    "}",
    'tmp_patch="$PATCH.tmp.$$"',
    'if [ -f "$PATCH" ]; then',
    '  strip_markers "$PATCH" > "$tmp_patch" || : > "$tmp_patch"',
    "else",
    '  : > "$tmp_patch"',
    "fi",
    'if [ -s "$tmp_patch" ]; then',
    "  printf '\\n' >> \"$tmp_patch\"",
    "fi",
    "printf '%s\\n' '# troy-install:start' '- insert:' '    - id: troy' \"      name: '$PLUGIN'\" '# troy-install:end' >> \"$tmp_patch\"",
    'mv "$tmp_patch" "$PATCH"',
    'if [ -n "$KEY" ]; then',
    '  tmp_stripped="$CREDS.strip.$$"',
    '  tmp_creds="$CREDS.tmp.$$"',
    '  if [ -f "$CREDS" ]; then',
    '    strip_markers "$CREDS" > "$tmp_stripped" || : > "$tmp_stripped"',
    "  else",
    '    : > "$tmp_stripped"',
    "  fi",
    "  if ! grep -q '[^[:space:]]' \"$tmp_stripped\" 2>/dev/null; then",
    '    printf \'version: 1\\nrefs:\\n  # troy-install:start\\n  TROY_API_KEY: %s\\n  # troy-install:end\\n\' "$KEY" > "$tmp_creds"',
    "  elif grep -q '^version:' \"$tmp_stripped\" && grep -q '^refs:[[:space:]]*$' \"$tmp_stripped\"; then",
    '    KEY="$KEY" awk \'{ print; if (!done && $0 ~ /^refs:[[:space:]]*$/) { print "  # troy-install:start"; print "  TROY_API_KEY: " ENVIRON["KEY"]; print "  # troy-install:end"; done=1 } }\' "$tmp_stripped" > "$tmp_creds"',
    "  else",
    "    {",
    "      printf 'version: 1\\nrefs:\\n  # troy-install:start\\n  TROY_API_KEY: %s\\n  # troy-install:end\\n' \"$KEY\"",
    '      awk \'{ if (length) print "  " $0; else print "" }\' "$tmp_stripped"',
    '    } > "$tmp_creds"',
    "  fi",
    '  rm -f "$tmp_stripped"',
    '  mv "$tmp_creds" "$CREDS"',
    '  chmod 600 "$CREDS"',
    "fi",
  );
  return `${out.join("\n")}\n`;
}

/** `$DSH_HOME` if set, else `~/.dsh`; throws when neither is knowable. */
export function dshHome(env: Record<string, string | undefined> = process.env): string {
  const home = env.DSH_HOME || (env.HOME ? join(env.HOME, ".dsh") : "");
  if (!home) throw new Error("cannot locate dsh home (set DSH_HOME or HOME)");
  return home;
}

const MARKER_START = "# troy-install:start";
const MARKER_END = "# troy-install:end";

/**
 * Replace the block between our markers (inclusive), or append it. Everything
 * outside the markers survives byte-for-byte, so entries dsh or other tools
 * wrote are never touched.
 * ponytail: marker-block text merge avoids a yaml dependency; swap to
 * structural merging only if per-entry edits inside our block are ever needed.
 */
function upsertBlock(text: string, block: string): string {
  const start = text.indexOf(MARKER_START);
  const end = text.indexOf(MARKER_END);
  if (start !== -1 && end !== -1 && end > start) {
    return text.slice(0, start) + block + text.slice(end + MARKER_END.length);
  }
  if (!text.trim()) return `${block}\n`;
  return `${text.replace(/\n*$/, "\n")}\n${block}\n`;
}

/** File contents, or null when absent; other read errors surface as null too (best-effort merge). */
function readOptional(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

export interface DshInstallResult {
  pluginPath: string;
  patchPath: string;
  credentialsPath: string | null;
}

/**
 * Write the plugin, reference it from cordis.patch.yml, and store the key in
 * .credentials.yaml. Idempotent — overwrites ours. With no api key, the
 * credentials file is left alone entirely.
 */
export function installDshPlugin(opts: { baseUrl: string; apiKey: string; home?: string }): DshInstallResult {
  const home = opts.home ?? dshHome();
  mkdirSync(join(home, "plugins"), { recursive: true });

  const pluginPath = join(home, "plugins", "troy-dsh.ts");
  writeFileSync(pluginPath, renderDshPlugin(opts.baseUrl, opts.apiKey));

  // hot-watched user patch layer — dsh loads/updates the plugin without a restart
  const patchPath = join(home, "cordis.patch.yml");
  const patchBlock = [MARKER_START, "- insert:", "    - id: troy", `      name: '${pluginPath}'`, MARKER_END].join(
    "\n",
  );
  writeFileSync(patchPath, upsertBlock(readOptional(patchPath) ?? "", patchBlock));

  let credentialsPath: string | null = null;
  if (opts.apiKey) {
    credentialsPath = join(home, ".credentials.yaml");
    writeFileSync(credentialsPath, upsertCredentialKey(readOptional(credentialsPath), opts.apiKey));
    // dsh refuses a credentials file readable beyond its owner — always tighten
    chmodSync(credentialsPath, 0o600);
  }

  return { pluginPath, patchPath, credentialsPath };
}

export interface DshClearResult {
  pluginPath: string;
  patchPath: string;
  credentialsPath: string | null;
}

/**
 * Remove everything the installer wrote — plugin file, patch entry, stored
 * key — leaving foreign content untouched. A file left blank by the removal
 * is deleted outright.
 */
export function clearDshPlugin(opts: { home?: string } = {}): DshClearResult {
  const home = opts.home ?? dshHome();
  const pluginPath = join(home, "plugins", "troy-dsh.ts");
  rmSync(pluginPath, { force: true });

  const patchPath = join(home, "cordis.patch.yml");
  const patchText = readOptional(patchPath);
  if (patchText?.includes(MARKER_START)) {
    writeOrUnlinkIfBlank(patchPath, removeMarkedLines(patchText));
  }

  let credentialsPath: string | null = null;
  const credentialsFile = join(home, ".credentials.yaml");
  const credText = readOptional(credentialsFile);
  if (credText?.includes(MARKER_START)) {
    credentialsPath = credentialsFile;
    writeOrUnlinkIfBlank(credentialsFile, removeMarkedLines(credText));
    chmodSync(credentialsFile, 0o600);
  }

  return { pluginPath, patchPath, credentialsPath };
}

/** Rewrite with the given lines, or delete the file when nothing remains. */
function writeOrUnlinkIfBlank(path: string, lines: string[]): void {
  const text = lines
    .join("\n")
    .replace(/^\n+/, "")
    .replace(/\n{3,}/g, "\n\n");
  if (text.trim()) writeFileSync(path, text.endsWith("\n") || !text ? text : `${text}\n`);
  else rmSync(path, { force: true });
}

/**
 * Drop the lines between our markers (any indentation) so both top-level
 * blocks and keys nested under `refs:` come out cleanly.
 */
function removeMarkedLines(text: string): string[] {
  const out: string[] = [];
  let inside = false;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === MARKER_START) inside = true;
    else if (trimmed === MARKER_END) inside = false;
    else if (!inside) out.push(line);
  }
  return out;
}

/**
 * Store `TROY_API_KEY` in the document layout the npm release parses
 * strictly: every key nested under `refs:` behind a `version: 1` header (the
 * legacy flat layout is only auto-migrated by development builds, and a flat
 * top-level key hard-fails boot). Handles all three states we can find:
 * absent, already versioned, or legacy flat.
 */
function upsertCredentialKey(text: string | null, value: string): string {
  const ours = [`  ${MARKER_START}`, `  TROY_API_KEY: ${value}`, `  ${MARKER_END}`];
  const lines = text ? removeMarkedLines(text) : [];
  if (lines.length === 0 || !lines.some((l) => l.trim())) {
    return ["version: 1", "refs:", ...ours, ""].join("\n");
  }
  const refsAt = lines.findIndex((l) => /^refs:\s*$/.test(l));
  if (/^version:/m.test(lines.join("\n")) && refsAt !== -1) {
    lines.splice(refsAt + 1, 0, ...ours);
    return `${lines.join("\n")}\n`;
  }
  // legacy flat document — nest its entries under refs:, mirroring dsh's own migration
  const migrated = ["version: 1", "refs:", ...ours, ...lines.map((l) => (l.length ? `  ${l}` : l))];
  return `${migrated.join("\n")}\n`;
}
