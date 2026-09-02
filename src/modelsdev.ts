/**
 * models.dev enrichment — canonical model metadata (reasoning, tool calling,
 * modalities, limits, display name) for chosen specs.
 *
 * Provider discovery is NEVER taken from here: which models exist comes from
 * each provider's own models endpoint (registry.ts modelsUrl). models.dev only
 * enriches specs the user already picked.
 *
 * Two payloads, two layers of truth:
 *   https://models.dev/models.json  → canonical "lab/model-id" entries (~290 KB)
 *   https://models.dev/api.json     → per-provider entries with real limit+cost (~4 MB)
 *
 * The canonical snapshot ships as src/modelsdev-seed.json so a fresh install
 * works offline; the per-provider catalog has no seed (too big for git) and
 * simply stays absent until the first successful sync. Both refresh daily in
 * the background and fail open to the previous snapshot.
 */

import { cLog, TAG } from "./logger";
import seed from "./modelsdev-seed.json";
import { isReasoningModel } from "./providers/reasoning";

export interface CanonicalModel {
  id: string;
  name: string;
  reasoning: boolean;
  tool_call: boolean;
  modalities?: { input?: string[]; output?: string[] };
}

export type ModelsDevCatalog = Record<string, CanonicalModel>;

/** entry shape we consume from api.json (everything optional, validated on ingest) */
export interface ProviderModel {
  name?: string;
  reasoning?: boolean;
  tool_call?: boolean;
  modalities?: { input?: string[]; output?: string[] };
  limit?: { context?: number; output?: number };
}

export type ProviderCatalog = Record<string, { models?: Record<string, ProviderModel> }>;

export interface Enriched {
  /** thinking-capable (provider-exact > canonical > name-pattern floor) */
  reasoning: boolean;
  toolCall: boolean;
  /** accepts image input */
  attachment: boolean;
  /** full input modalities when known ("text", "image", "video", "pdf") */
  modalities?: string[];
  /** real context/output window when known */
  limit?: { context: number; output: number };
  /** human display name ("DeepSeek V4 Flash"), when known */
  name?: string;
  /** which layer resolved it */
  source: "provider" | "canonical" | "regex";
}

// ---- state ------------------------------------------------------------------

let canonical: ModelsDevCatalog = seed as ModelsDevCatalog;
let providers: ProviderCatalog = {};

/** model-part (after last "/") → canonical entries sharing it, for cross-lab lookup */
let byModelPart = new Map<string, CanonicalModel[]>();

function rebuildIndex(): void {
  byModelPart = new Map();
  for (const entry of Object.values(canonical)) {
    const part = entry.id.slice(entry.id.lastIndexOf("/") + 1).toLowerCase();
    const list = byModelPart.get(part);
    if (list) list.push(entry);
    else byModelPart.set(part, [entry]);
  }
}
rebuildIndex();

// ---- ingest validation (upstream is untrusted input) ------------------------

const MAX_PAYLOAD_BYTES = 16_000_000;

function asObject(data: unknown): Record<string, unknown> {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("payload is not an object");
  return data as Record<string, unknown>;
}

/** keep only well-formed canonical entries; require at least one */
function validateCanonical(data: unknown): ModelsDevCatalog {
  const raw = asObject(data);
  const out: ModelsDevCatalog = {};
  for (const [key, value] of Object.entries(raw)) {
    const e = value as Partial<CanonicalModel>;
    if (e && typeof e === "object" && typeof e.id === "string" && typeof e.reasoning === "boolean") {
      out[key] = e as CanonicalModel;
    }
  }
  if (!Object.keys(out).length) throw new Error("no valid canonical entries");
  return out;
}

/** keep only well-formed provider→models maps; require at least one model overall */
function validateProviderCatalog(data: unknown): ProviderCatalog {
  const raw = asObject(data);
  const out: ProviderCatalog = {};
  let count = 0;
  for (const [provider, info] of Object.entries(raw)) {
    const models = (info as Partial<ProviderCatalog[string]>)?.models;
    if (!models || typeof models !== "object") continue;
    const clean: Record<string, ProviderModel> = {};
    for (const [mid, entry] of Object.entries(models as Record<string, unknown>)) {
      if (entry && typeof entry === "object") {
        clean[mid] = entry as ProviderModel;
        count++;
      }
    }
    if (Object.keys(clean).length) out[provider] = { models: clean };
  }
  if (!count) throw new Error("no valid provider models");
  return out;
}

async function syncOne<T>(
  url: string,
  validate: (data: unknown) => T,
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response>,
): Promise<T> {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > MAX_PAYLOAD_BYTES) throw new Error(`payload too large (${text.length} bytes)`);
  return validate(JSON.parse(text));
}

// ---- refresh ----------------------------------------------------------------

const CANONICAL_URL = "https://models.dev/models.json";
const PROVIDER_URL = "https://models.dev/api.json";
const REFRESH_MS = 24 * 60 * 60 * 1000;

export interface SyncResult {
  canonical: boolean;
  provider: boolean;
}

/** One sync attempt per payload. Each swaps atomically on success, keeps the old on failure. */
export async function refreshOnce(
  log: (msg: string) => void = (msg) => cLog(TAG.MODELSDEV, { msg }),
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response> = fetch,
): Promise<SyncResult> {
  const logs: string[] = [];
  const run = async <T>(label: string, url: string, validate: (d: unknown) => T, swap: (t: T) => void) => {
    try {
      const data = await syncOne(url, validate, fetchImpl);
      swap(data);
      logs.push(
        label === "canonical"
          ? `[models.dev] canonical refreshed — ${Object.keys(data as ModelsDevCatalog).length} models`
          : `[models.dev] provider catalog refreshed — ${Object.keys(data as ProviderCatalog).length} providers`,
      );
      return true;
    } catch (err) {
      logs.push(`[models.dev] ${label} refresh failed, keeping previous (${err instanceof Error ? err.message : err})`);
      return false;
    }
  };

  const [c, p] = await Promise.all([
    run("canonical", CANONICAL_URL, validateCanonical, (d) => {
      canonical = d as ModelsDevCatalog;
      rebuildIndex();
    }),
    run("provider", PROVIDER_URL, validateProviderCatalog, (d) => {
      providers = d as ProviderCatalog;
    }),
  ]);
  for (const line of logs) log(line);

  if (c || p) {
    lastSyncAt = new Date().toISOString();
    lastSyncCounts = {
      canonicalEntries: Object.keys(canonical).length,
      providerEntries: Object.values(providers).reduce((n, p) => n + Object.keys(p.models ?? {}).length, 0),
    };
  }
  return { canonical: c, provider: p };
}

// biome-ignore lint/correctness/noUnusedVariables: guard prevents double startModelsDevRefresh
let started = false;
let lastSyncAt: string | undefined;
let lastSyncCounts = { canonicalEntries: Object.keys(seed as ModelsDevCatalog).length, providerEntries: 0 };

/** Refresh shortly after boot, then daily. Failures keep the previous snapshots. */
export function startModelsDevRefresh(log: (msg: string) => void = (msg) => cLog(TAG.MODELSDEV, { msg })): void {
  started = true;
  const timer = setInterval(() => void refreshOnce(log), REFRESH_MS);
  timer.unref?.();
  setTimeout(() => void refreshOnce(log), 5_000).unref?.(); // first sync after boot, without blocking startup
}

// ---- lookup -----------------------------------------------------------------

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

/** split "provider/rest" → ["provider", "rest"]; bare ids pass through as ["", id] */
function splitSpec(spec: string): [string, string] {
  const i = spec.indexOf("/");
  return i === -1 ? ["", spec] : [spec.slice(0, i), spec.slice(i + 1)];
}

/**
 * Canonical entry for a spec remainder — "lab/model", "model",
 * "meta/muse-spark-1.2-contributor", "deepseek-v4-flash-free"…
 * Exact key first, then suffix-stripped, then cross-lab match on the bare
 * model part (unique hit wins; ambiguous only when every candidate agrees).
 */
export function lookup(rest: string): CanonicalModel | undefined {
  if (!rest) return undefined;
  const exact = canonical[rest] ?? canonical[rest.toLowerCase()];
  if (exact) return exact;

  const stripped = stripSuffixes(rest);
  const viaStrip = canonical[stripped];
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

/** per-provider entry: exact model id under the spec's provider, then suffix-stripped,
 *  then vendor-prefix split ("command-code/meta/muse-…" → provider "meta", id "muse-…") */
function lookupProvider(provider: string, rest: string): ProviderModel | undefined {
  const models = providers[provider]?.models;
  if (models) {
    const hit = models[rest] ?? models[stripSuffixes(rest)];
    if (hit) return hit;
  }
  const slash = rest.indexOf("/");
  if (slash === -1) return undefined;
  const tail = rest.slice(slash + 1);
  const alt = providers[rest.slice(0, slash)]?.models;
  if (!alt) return undefined;
  return alt[tail] ?? alt[stripSuffixes(tail)];
}

// ---- resolution -------------------------------------------------------------

/** capability layers that may be served; TROY_ENRICH="" disables all extras.
 *  Cached per env value — no Set rebuild on the enrich() hot path, but a
 *  runtime env change (tests) still takes effect. */
let layersCache: { env: string | undefined; set: Set<string> } | null = null;
function enabledLayers(): Set<string> {
  const env = process.env.TROY_ENRICH;
  if (!layersCache || layersCache.env !== env) {
    layersCache = {
      env,
      set: new Set(
        (env ?? "limits,modalities")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      ),
    };
  }
  return layersCache.set;
}

const KNOWN_INPUTS = new Set(["text", "image", "video", "pdf", "audio"]);

function inputModalities(input: string[] | undefined): string[] | undefined {
  if (!enabledLayers().has("modalities")) return undefined;
  const clean = (input ?? []).filter((k) => KNOWN_INPUTS.has(k));
  if (!clean.includes("text")) clean.unshift("text");
  return clean;
}

function sizeLimit(limit: ProviderModel["limit"]): Enriched["limit"] | undefined {
  if (!enabledLayers().has("limits")) return undefined;
  const context = Math.max(0, Math.floor(limit?.context ?? 0));
  const output = Math.max(0, Math.floor(limit?.output ?? 0));
  if (!context && !output) return undefined;
  return { context, output };
}

function fromProvider(pm: ProviderModel): Enriched {
  const inputs = pm.modalities?.input;
  return {
    reasoning: pm.reasoning === true,
    toolCall: pm.tool_call !== false,
    attachment: (inputs ?? []).includes("image"),
    modalities: inputModalities(inputs),
    limit: sizeLimit(pm.limit),
    name: typeof pm.name === "string" && pm.name ? pm.name : undefined,
    source: "provider",
  };
}

function fromCanonical(c: CanonicalModel): Enriched {
  const inputs = c.modalities?.input;
  return {
    reasoning: c.reasoning === true,
    toolCall: c.tool_call !== false,
    attachment: (inputs ?? []).includes("image"),
    modalities: inputModalities(inputs),
    limit: undefined, // canonical entries carry no limits — provider layer does
    name: typeof c.name === "string" && c.name ? c.name : undefined,
    source: "canonical",
  };
}

// lookup hit-rate counters (see /api/modelsdev/status)
const hits = { provider: 0, canonical: 0, regex: 0 };

/**
 * Resolve metadata for a saved spec ("provider/rest"). Precedence:
 * provider-exact (api.json) > canonical (models.json) > name-pattern floor.
 * The regex floor runs on the bare model id — anchored patterns like
 * /^deepseek-(v3|v4)/ never match vendor-prefixed remainders.
 */
export function enrich(spec: string): Enriched {
  const [provider, rest] = splitSpec(spec);
  const pm = lookupProvider(provider, rest);
  if (pm) {
    hits.provider++;
    return fromProvider(pm);
  }
  const c = lookup(rest);
  if (c) {
    hits.canonical++;
    return fromCanonical(c);
  }
  hits.regex++;
  const bare = rest.slice(rest.lastIndexOf("/") + 1);
  return { reasoning: isReasoningModel(bare), toolCall: true, attachment: true, source: "regex" };
}

/**
 * Lowest-common metadata for a combo: a chain thinks/reads images/calls tools
 * only when EVERY member does, and its context window is the smallest member's.
 */
export function enrichCombo(specs: string[]): Enriched | undefined {
  if (!specs.length) return undefined;
  const parts = specs.map(enrich);
  const every = (f: (e: Enriched) => boolean) => parts.every(f);
  const limits = parts.map((p) => p.limit);
  const known = limits.every(Boolean);
  return {
    reasoning: every((p) => p.reasoning),
    toolCall: every((p) => p.toolCall),
    attachment: every((p) => p.attachment),
    ...(known && limits.length
      ? {
          limit: {
            context: Math.min(...limits.map((l) => l!.context)),
            output: Math.min(...limits.map((l) => l!.output)),
          },
        }
      : {}),
    source: parts.some((p) => p.source === "regex") ? "regex" : parts[0]!.source,
  };
}

// ---- observability ----------------------------------------------------------

/** sync state + per-layer hit rates, served at GET /api/modelsdev/status */
export function enrichmentStatus() {
  return {
    lastSyncAt,
    ...lastSyncCounts,
    flag: process.env.TROY_ENRICH ?? "limits,modalities",
    lookups: { ...hits },
  };
}

// ---- test hooks -------------------------------------------------------------

export function __setCatalogForTests(c: ModelsDevCatalog): void {
  canonical = c;
  rebuildIndex();
}

export function __setProviderCatalogForTests(p: ProviderCatalog): void {
  providers = p;
}
