import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Oh My Pi (omp) extension — registers troy as a live omp provider.
 *
 * The extension source ships as a template here and is written verbatim into
 * `~/.omp/agent/extensions/troy.ts` by POST /api/install-omp-plugin.
 * omp auto-discovers `~/.omp/agent/extensions/*.ts` and does NOT install
 * dependencies for local extension files.
 *
 * Pattern mirrors src/opencode-plugin.ts / src/dsh-plugin.ts so all three
 * one-click installs stay consistent: TEMPLATE + render + home + install/clear.
 * Use `omp --model troy/<spec>` after install; the model list refreshes
 * through omp's live catalog (fetchDynamicModels), so new chosen specs
 * appear without re-installing.
 */

const TEMPLATE = `/**
 * troy — live Oh My Pi provider extension (installed by troy's dashboard).
 *
 * Registers every chosen model + combo as troy/<model> in omp and refreshes
 * the catalog via troy's /v1/models, so picking a model in troy's dashboard
 * shows up here without touching any config. Re-install from the dashboard
 * (Tools page) if your troy URL or api key changes, or edit the two lines
 * below.
 */
const BASE_URL = "__TROY_BASE_URL__";
const API_KEY = __TROY_API_KEY__;

/** strip trailing slashes, keep exactly one /v1 suffix */
function normalizeBase(url) {
  const trimmed = String(url || "").replace(/\\/+$/, "");
  if (!trimmed) throw new Error("troy extension: empty baseURL");
  return trimmed.endsWith("/v1") ? trimmed : trimmed + "/v1";
}

/** only chosen specs (custom) and combos (owned_by "troy") are usable */
function usableModels(rows) {
  return (Array.isArray(rows) ? rows : []).filter(
    (m) => m && typeof m.id === "string" && (m.custom === true || m.owned_by === "troy"),
  );
}

/** map a troy /models row to omp's ProviderModelConfig shape */
function toProviderModel(m) {
  let input = ["text"];
  if (Array.isArray(m.modalities)) {
    const filtered = m.modalities.filter((x) => x === "text" || x === "image");
    if (filtered.length) input = filtered;
  }
  return {
    id: m.id,
    name: m.name || m.id,
    reasoning: m.reasoning === true,
    input,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: (m.limit && m.limit.context) || 200000,
    maxTokens: (m.limit && m.limit.output) || 32768,
  };
}

export default function (pi) {
  const base = normalizeBase(BASE_URL);

  async function fetchDynamicModels(apiKey) {
    const res = await fetch(base + "/models", {
      headers: apiKey ? { authorization: "Bearer " + apiKey } : {},
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error("troy /models returned " + res.status);
    const data = await res.json();
    return usableModels(data.data).map(toProviderModel);
  }

  pi.registerProvider("troy", {
    baseUrl: base,
    apiKey: API_KEY || undefined,
    api: "openai-completions",
    authHeader: true,
    fetchDynamicModels,
  });
}
`;

/** Fill the template with a troy origin + api key (values are JS-literal-escaped). */
export function renderOmpPlugin(baseUrl: string, apiKey: string): string {
  return TEMPLATE.replace("__TROY_BASE_URL__", () => JSON.stringify(baseUrl).slice(1, -1)).replace(
    "__TROY_API_KEY__",
    () => JSON.stringify(apiKey),
  );
}

/** `PI_CODING_AGENT_DIR` if set, else `~/.omp/agent`; throws when neither is knowable. */
export function ompAgentDir(env: Record<string, string | undefined> = process.env): string {
  const fromEnv = env.PI_CODING_AGENT_DIR?.trim();
  if (fromEnv) return fromEnv;
  if (env.HOME) return join(env.HOME, ".omp", "agent");
  throw new Error("cannot locate omp agent dir (set PI_CODING_AGENT_DIR or HOME)");
}

export interface OmpInstallResult {
  extensionPath: string;
  agentDir: string;
  bytes: number;
}

export interface OmpClearResult {
  extensionPath: string;
  agentDir: string;
  removed: boolean;
}

/** Write the extension into omp's agent dir. Idempotent — overwrites ours. */
export function installOmpPlugin(opts: { baseUrl: string; apiKey: string; agentDir?: string }): OmpInstallResult {
  const agentDir = opts.agentDir ?? ompAgentDir();
  const dir = join(agentDir, "extensions");
  mkdirSync(dir, { recursive: true });
  const extensionPath = join(dir, "troy.ts");
  const contents = renderOmpPlugin(opts.baseUrl, opts.apiKey);
  writeFileSync(extensionPath, contents);
  return { extensionPath, agentDir, bytes: Buffer.byteLength(contents) };
}

/** Remove the troy extension file. Leaves foreign extensions untouched. */
export function clearOmpPlugin(opts: { agentDir?: string } = {}): OmpClearResult {
  const agentDir = opts.agentDir ?? ompAgentDir();
  const extensionPath = join(join(agentDir, "extensions"), "troy.ts");
  let removed = false;
  try {
    const existing = readFileSync(extensionPath, "utf8");
    if (
      existing.includes("troy \u2014 live Oh My Pi provider extension") ||
      existing.includes('pi.registerProvider("troy"')
    ) {
      rmSync(extensionPath);
      removed = true;
    }
  } catch {
    // missing or unreadable — treat as already cleared
  }
  return { extensionPath, agentDir, removed };
}
