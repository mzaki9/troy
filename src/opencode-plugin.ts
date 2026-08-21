import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * OpenCode V2 plugin — registers troy as a live OpenCode provider.
 *
 * The plugin source ships as a template here and is written verbatim into
 * `~/.config/opencode/plugins/troy.ts` by POST /api/install-opencode-plugin.
 * It must stay dependency-free (plain-object default export, zero imports):
 * OpenCode auto-discovers that directory and does NOT install dependencies
 * for local plugin files.
 */

const TEMPLATE = `/**
 * troy — live OpenCode provider plugin (installed by troy's dashboard).
 *
 * Registers every chosen model + combo as troy/<model> in OpenCode and
 * refreshes the catalog every 60s, so picking a model in troy's dashboard
 * shows up here without touching any config. Re-install from the dashboard
 * (Tools page) if your troy URL or api key changes, or edit the two lines
 * below.
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

export default {
  id: "troy.catalog",
  async setup(ctx) {
    const opt = ctx.options ?? {};
    const base = normalizeBase(typeof opt.baseURL === "string" && opt.baseURL ? opt.baseURL : BASE_URL);
    const apiKey = typeof opt.apiKey === "string" && opt.apiKey ? opt.apiKey : API_KEY;

    async function refresh() {
      const res = await fetch(base + "/models", {
        headers: apiKey ? { authorization: "Bearer " + apiKey } : {},
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error("troy /models returned " + res.status);
      const data = await res.json();
      const models = usableModels(data.data);
      if (!models.length) return;
      await ctx.catalog.transform((catalog) => {
        // provider info: package drives the AI-SDK adapter, activation makes
        // it visible without a config entry, settings carry baseURL/apiKey
        catalog.provider.update("troy", (info) => {
          info.name = "Troy";
          info.package = "aisdk:@ai-sdk/openai-compatible";
          info.activation = "enabled";
          info.settings = { ...(info.settings ?? {}), baseURL: base, ...(apiKey ? { apiKey } : {}) };
        });
        // models live in their own map — registered one by one
        for (const m of models) {
          catalog.model.update("troy", m.id, (draft) => {
            draft.name = m.name || m.id;
            // display-only fallback — troy is a passthrough, upstream enforces real limits
            draft.limit = { context: 200000, output: 32768 };
            // real capability flags when troy serves them (models.dev enrichment)
            if (m.tool_call === false || m.attachment === false) {
              draft.capabilities = {
                tools: m.tool_call !== false,
                input: m.attachment === false ? ["text"] : ["text", "image"],
                output: ["text"],
              };
            }
            // thinking models get effort variants (sent upstream as reasoning_effort)
            if (m.reasoning === true) {
              draft.variants = [
                { id: "low", settings: { reasoningEffort: "low" } },
                { id: "medium", settings: { reasoningEffort: "medium" } },
                { id: "high", settings: { reasoningEffort: "high" } },
              ];
            }
          });
        }
      });
    }

    const tick = () => refresh().catch((err) => console.error("[troy] " + (err?.message ?? err)));
    await tick();
    const timer = setInterval(tick, 60_000);
    return () => clearInterval(timer);
  },
};
`;

/** Fill the template with a troy origin + api key (values are JS-literal-escaped). */
export function renderOpenCodePlugin(baseUrl: string, apiKey: string): string {
  return TEMPLATE.replace("__TROY_BASE_URL__", () => JSON.stringify(baseUrl).slice(1, -1)).replace(
    "__TROY_API_KEY__",
    () => JSON.stringify(apiKey),
  );
}

/** XDG-aware location of OpenCode's auto-discovered plugin directory. */
export function openCodePluginDir(env: Record<string, string | undefined> = process.env): string {
  const configHome = env.XDG_CONFIG_HOME || (env.HOME ? join(env.HOME, ".config") : "");
  if (!configHome) throw new Error("cannot locate config home (set XDG_CONFIG_HOME or HOME)");
  return join(configHome, "opencode", "plugins");
}

/** Write the plugin into OpenCode's plugin dir. Idempotent — overwrites ours. */
export function installOpenCodePlugin(opts: { baseUrl: string; apiKey: string; dir?: string }): {
  path: string;
  bytes: number;
} {
  const dir = opts.dir ?? openCodePluginDir();
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "troy.ts");
  const contents = renderOpenCodePlugin(opts.baseUrl, opts.apiKey);
  writeFileSync(path, contents);
  return { path, bytes: Buffer.byteLength(contents) };
}
