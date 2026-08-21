/**
 * models.dev enrichment — canonical model metadata (reasoning, tool calling,
 * modalities, display name) for chosen specs.
 *
 * Provider discovery is NEVER taken from here: which models exist comes from
 * each provider's own models endpoint (registry.ts modelsUrl). models.dev only
 * enriches specs the user already picked.
 *
 * Data source: https://models.dev/models.json — provider-agnostic canonical
 * models keyed "lab/model-id" (~350 entries, ~290 KB). A snapshot ships as
 * src/modelsdev-seed.json so a fresh install works offline; a background loop
 * refreshes it daily and fails open to the previous snapshot.
 */

import seed from "./modelsdev-seed.json";
import { isReasoningModel } from "./reasoning";

export interface CanonicalModel {
  id: string;
  name: string;
  reasoning: boolean;
  tool_call: boolean;
  modalities?: { input?: string[]; output?: string[] };
}

export type ModelsDevCatalog = Record<string, CanonicalModel>;

export interface Enriched {
  /** thinking-capable (manual override > models.dev > name-pattern floor) */
  reasoning: boolean;
  toolCall: boolean;
  /** accepts image input */
  attachment: boolean;
  /** human display name ("DeepSeek V4 Flash"), when known */
  name?: string;
  /** which layer resolved it */
  source: "modelsdev" | "regex";
}

let catalog: ModelsDevCatalog = seed as ModelsDevCatalog;

/** model-part (after last "/") → canonical entries sharing it, for cross-lab lookup */
let byModelPart = new Map<string, CanonicalModel[]>();

function rebuildIndex(): void {
  byModelPart = new Map();
  for (const entry of Object.values(catalog)) {
    const part = entry.id.slice(entry.id.lastIndexOf("/") + 1).toLowerCase();
    const list = byModelPart.get(part);
    if (list) list.push(entry);
    else byModelPart.set(part, [entry]);
  }
}
rebuildIndex();

/** reseller/variant suffixes that hide the canonical id ("-free", "-contributor", …) */
const SUFFIXES = ["-free", ":free", "-contributor", "-latest", "-highspeed", "-thinking", "-max"];

function stripSuffixes(s: string): string {
  let out = s.toLowerCase();
  let changed = true;
  while (changed) {
    changed = false;
    for (const suf of SUFFIXES) {
      if (out.endsWith(suf) && out.length > suf.length) {
        out = out.slice(0, -suf.length);
        changed = true;
      }
    }
  }
  return out;
}

/**
 * Canonical entry for a spec remainder — "lab/model", "model",
 * "meta/muse-spark-1.2-contributor", "deepseek-v4-flash-free"…
 * Exact key first, then suffix-stripped, then cross-lab match on the bare
 * model part (unique hit wins; ambiguous only when every candidate agrees).
 */
export function lookup(rest: string): CanonicalModel | undefined {
  if (!rest) return undefined;
  const exact = catalog[rest] ?? catalog[rest.toLowerCase()];
  if (exact) return exact;

  const stripped = stripSuffixes(rest);
  const viaStrip = catalog[stripped];
  if (viaStrip) return viaStrip;

  const bare = stripped.slice(stripped.lastIndexOf("/") + 1);
  for (const q of new Set([bare, rest.slice(rest.lastIndexOf("/") + 1).toLowerCase()])) {
    const candidates = byModelPart.get(q);
    if (!candidates?.length) continue;
    if (candidates.length === 1) return candidates[0];
    const flags = candidates.map((c) => c.reasoning === true);
    if (flags.every(Boolean) || flags.every((f) => !f)) return { ...candidates[0], reasoning: flags[0] };
  }
  return undefined;
}

/**
 * Resolve metadata for a saved spec ("provider/rest"). Resolution order:
 * manual override (future) > models.dev canonical > name-pattern floor.
 * The regex floor runs on the bare model id — anchored patterns like
 * /^deepseek-(v3|v4)/ never match vendor-prefixed remainders.
 */
export function enrich(spec: string): Enriched {
  const rest = spec.includes("/") ? spec.slice(spec.indexOf("/") + 1) : spec;
  const hit = lookup(rest);
  if (hit) {
    return {
      reasoning: hit.reasoning === true,
      toolCall: hit.tool_call !== false,
      attachment: (hit.modalities?.input ?? []).includes("image"),
      name: typeof hit.name === "string" && hit.name ? hit.name : undefined,
      source: "modelsdev",
    };
  }
  const bare = rest.slice(rest.lastIndexOf("/") + 1);
  return { reasoning: isReasoningModel(bare), toolCall: true, attachment: true, source: "regex" };
}

/** One sync attempt. Swaps the catalog on success; returns false and keeps the old one on any failure. */
export async function refreshOnce(
  log: (msg: string) => void = console.log,
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response> = fetch,
): Promise<boolean> {
  try {
    const res = await fetchImpl("https://models.dev/models.json", { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as ModelsDevCatalog;
    if (!data || typeof data !== "object" || !Object.keys(data).length) throw new Error("malformed payload");
    catalog = data;
    rebuildIndex();
    log(`[models.dev] catalog refreshed — ${Object.keys(data).length} canonical models`);
    return true;
  } catch (err) {
    log(`[models.dev] refresh failed, keeping previous snapshot (${err instanceof Error ? err.message : err})`);
    return false;
  }
}

const REFRESH_MS = 24 * 60 * 60 * 1000;
let started = false;

/** Refresh shortly after boot, then daily. Failures keep the previous snapshot. */
export function startModelsDevRefresh(log: (msg: string) => void = console.log): void {
  if (started) return;
  started = true;
  const timer = setInterval(() => void refreshOnce(log), REFRESH_MS);
  timer.unref?.();
  setTimeout(() => void refreshOnce(log), 5_000).unref?.(); // first sync after boot, without blocking startup
}

/** test hook — swap the in-memory catalog */
export function __setCatalogForTests(c: ModelsDevCatalog): void {
  catalog = c;
  rebuildIndex();
}
