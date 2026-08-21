import { enrich, enrichCombo } from "../modelsdev";
import { customProviderIds, getProvider, providerIds } from "../proxy/registry";
import type { Store } from "../store/db";

/** The /v1/models listing: combos as pseudo-models, saved specs, then every
 *  provider that has at least one active key. */
export function modelsList(store: Store): unknown[] {
  const out: unknown[] = [];
  for (const combo of store.listCombos()) {
    // a chain is only as capable as its weakest member
    const e = enrichCombo(combo.models);
    out.push({
      id: combo.name,
      object: "model",
      owned_by: "troy",
      reasoning: e?.reasoning ?? false,
      tool_call: e?.toolCall ?? true,
      attachment: e?.attachment ?? true,
      ...(e?.modalities ? { modalities: e.modalities } : {}),
      ...(e?.limit ? { limit: e.limit } : {}),
    });
  }
  for (const m of store.listModels()) {
    const e = enrich(m.spec);
    out.push({
      id: m.spec,
      object: "model",
      owned_by: m.provider,
      custom: true,
      reasoning: e.reasoning,
      tool_call: e.toolCall,
      attachment: e.attachment,
      ...(e.modalities ? { modalities: e.modalities } : {}),
      ...(e.limit ? { limit: e.limit } : {}),
      ...(e.name ? { name: e.name } : {}),
    });
  }
  const active = new Set(store.activeProviderIds());
  for (const pid of providerIds()) {
    if (active.has(pid)) out.push({ id: pid, object: "model", owned_by: pid });
  }
  return out;
}

interface StatRow {
  provider: string;
  model: string;
  n: number;
  ok: number;
  av: number;
  last: string;
  tin: number | null;
  tout: number | null;
  rsav: number | null;
  rseen: number | null;
  rhits: number | null;
}

const STATUS_OK = "200 OK";

export function stats(store: Store): unknown {
  const byModel = store.raw
    .query(
      "SELECT provider, model, COUNT(*) n, SUM(CASE WHEN status = ? THEN 1 ELSE 0 END) ok, AVG(latency_ms) av, MAX(ts) last, SUM(json_extract(tokens, '$.prompt_tokens')) tin, SUM(json_extract(tokens, '$.completion_tokens')) tout, SUM(rtk_saved) rsav, SUM(rtk_seen) rseen, SUM(CASE WHEN rtk_saved > 0 THEN 1 ELSE 0 END) rhits FROM usage_history GROUP BY model, provider ORDER BY n DESC LIMIT 500",
    )
    .all(STATUS_OK) as unknown as StatRow[];
  const lats = (
    store.raw
      .query("SELECT latency_ms FROM usage_history WHERE latency_ms IS NOT NULL ORDER BY latency_ms ASC LIMIT 1000")
      .all() as { latency_ms: number }[]
  ).map((r) => r.latency_ms);
  const p95 = lats.length ? lats[Math.min(lats.length - 1, Math.floor(lats.length * 0.95))] : 0;
  // derive totals + byProvider from byModel — 2 queries instead of 4
  let n = 0;
  let ok = 0;
  let w = 0;
  let tin = 0;
  let tout = 0;
  let rsav = 0;
  let rseen = 0;
  let rhits = 0;
  const prov = new Map<string, { n: number; ok: number; w: number; tin: number; tout: number }>();
  for (const r of byModel) {
    n += r.n;
    ok += r.ok;
    w += r.n * r.av;
    tin += r.tin ?? 0;
    tout += r.tout ?? 0;
    rsav += r.rsav ?? 0;
    rseen += r.rseen ?? 0;
    rhits += r.rhits ?? 0;
    const p = prov.get(r.provider) ?? { n: 0, ok: 0, w: 0, tin: 0, tout: 0 };
    p.n += r.n;
    p.ok += r.ok;
    p.w += r.n * r.av;
    p.tin += r.tin ?? 0;
    p.tout += r.tout ?? 0;
    prov.set(r.provider, p);
  }
  const byProvider = [...prov.entries()]
    .map(([provider, p]) => ({
      provider,
      n: p.n,
      ok: p.ok,
      av: p.w / p.n,
      tokens_in: p.tin,
      tokens_out: p.tout,
    }))
    .sort((a, b) => b.n - a.n);
  return {
    totals: {
      requests: n,
      ok,
      fail: n - ok,
      avg_ms: n ? Math.round(w / n) : 0,
      p95_ms: Math.round(p95),
      tokens_in: tin,
      tokens_out: tout,
      rtk_saved: rsav,
      rtk_seen: rseen,
      rtk_hits: rhits,
    },
    byProvider,
    byModel: byModel.map((r) => ({
      provider: r.provider,
      model: r.model,
      requests: r.n,
      ok: r.ok,
      avg_ms: Math.round(r.av),
      last: r.last,
      tokens_in: r.tin ?? 0,
      tokens_out: r.tout ?? 0,
    })),
  };
}

export function providerCatalog(store: Store): unknown[] {
  const counts = new Map<string, number>();
  for (const c of store.listConnections()) {
    counts.set(c.provider, (counts.get(c.provider) ?? 0) + (c.is_active === 1 ? 1 : 0));
  }
  const chosen = new Map<string, number>();
  for (const m of store.listModels()) {
    chosen.set(m.provider, (chosen.get(m.provider) ?? 0) + 1);
  }
  const customs = new Set(customProviderIds());
  return providerIds().map((id) => {
    const p = getProvider(id)!;
    return {
      id,
      name: p.name,
      custom: customs.has(id),
      connected: counts.get(id) ?? 0,
      chosen: chosen.get(id) ?? 0,
      baseUrl: p.baseUrl,
      auth: p.auth,
      aliases: p.aliases,
      placeholders: p.placeholders ?? [],
    };
  });
}
