import { Database } from "bun:sqlite";
import type { Provider } from "../proxy/registry";
import { runMigrations } from "./migrations";

export interface Connection {
  id: string;
  provider: string;
  api_key: string;
  name: string | null;
  base_url: string | null;
  extra: string;
  priority: number;
  is_active: number;
  created_at: string;
}

export interface Combo {
  id: string;
  name: string;
  models: string[];
  /** Chain-level routing: "fallback" (saved order) | "random" | "round-robin". */
  strategy: string;
}

export interface SavedModel {
  spec: string;
  provider: string;
  model: string;
  created_at: string;
}

export interface Settings {
  rtk_on: number;
  caveman_level: string;
  ponytail_level: string;
  strategy: string;
}

/** Troy's own API key — the secret CLI tools present to the /v1 proxy. `on` mirrors
 * the dashboard toggle: 1 = every /v1 request must carry the key, 0 = open proxy. */
export interface ApiAuth {
  key: string;
  on: number;
}

/** Stored dashboard password (salted SHA-256). Absent while the default password
 * `troy123` is in effect. */
export interface DashPass {
  salt: string;
  hash: string;
}

/** One durable cooldown/circuit transition, appended BEFORE the in-memory state
 *  changes so a restart can fold the log back into live breakers (event-sourcing
 *  pattern borrowed from deepseek-harness's schedule package). */
export interface StateEvent {
  ts: number;
  kind: "fail" | "success" | "circuit_open";
  conn_id: string;
  key?: string | null;
  circuit_key?: string | null;
  status?: number | null;
  reason?: string | null;
  until_ms?: number | null;
  backoff_level?: number | null;
}

const DEFAULTS: Settings = {
  rtk_on: 1,
  caveman_level: "off",
  ponytail_level: "off",
  strategy: "fill-first",
};

/** Split "provider/model" — guards specs without "/" so the last character
 *  never leaks into the provider field (slice(0,-1) trap). */
function splitSpec(spec: string): { provider: string; model: string } {
  const i = spec.indexOf("/");
  if (i <= 0) return { provider: "", model: spec };
  return { provider: spec.slice(0, i), model: spec.slice(i + 1) };
}

export class Store {
  private db: Database;
  private logQueue: [string, string, string, string | null, string, number, string, number, number][] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private lastTrim = 0;
  private stateTrim = 0;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.run("PRAGMA journal_mode = WAL;");
    this.db.run("PRAGMA synchronous = NORMAL;");
    // memory budget: this proxy owns no hot dataset — cap the page cache at ~1 MiB
    // and checkpoint WAL often so the -wal file stays tiny
    this.db.run("PRAGMA cache_size = -1024;");
    this.db.run("PRAGMA wal_autocheckpoint = 500;");
    runMigrations(this.db);
  }

  get raw() {
    return this.db;
  }

  // ---- connections ----

  listConnections(provider?: string): Connection[] {
    if (provider) {
      return this.db
        .query("SELECT * FROM connections WHERE provider = ? ORDER BY priority ASC, id ASC")
        .all(provider) as unknown as Connection[];
    }
    return this.db
      .query("SELECT * FROM connections ORDER BY provider ASC, priority ASC")
      .all() as unknown as Connection[];
  }

  /** Providers that have at least one active key — one query, no N+1. */
  activeProviderIds(): string[] {
    return (
      this.db.query("SELECT DISTINCT provider FROM connections WHERE is_active = 1").all() as { provider: string }[]
    ).map((r) => r.provider);
  }

  addConnection(c: {
    provider: string;
    api_key: string;
    name?: string | null;
    base_url?: string | null;
    extra?: string;
    priority?: number;
  }): Connection {
    const id = crypto.randomUUID();
    const extra = c.extra ?? "{}";
    const priority = c.priority ?? 0;
    return this.db
      .query(
        "INSERT INTO connections (id, provider, api_key, name, base_url, extra, priority, is_active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?) RETURNING *",
      )
      .get(
        id,
        c.provider,
        c.api_key,
        c.name ?? null,
        c.base_url ?? null,
        extra,
        priority,
        new Date().toISOString(),
      ) as unknown as Connection;
  }

  updateConnection(id: string, fields: Partial<Connection>): Connection | null {
    // ponytail: COALESCE can't set a column to NULL; the dashboard always PUTs
    // full objects, so that's fine. If null-clearing is ever needed, fall back
    // to a merge-read (2 queries).
    return this.db
      .query(
        "UPDATE connections SET api_key=COALESCE(?,api_key), name=COALESCE(?,name), base_url=COALESCE(?,base_url), extra=COALESCE(?,extra), priority=COALESCE(?,priority), is_active=COALESCE(?,is_active) WHERE id = ? RETURNING *",
      )
      .get(
        fields.api_key ?? null,
        fields.name ?? null,
        fields.base_url ?? null,
        fields.extra ?? null,
        fields.priority ?? null,
        fields.is_active ?? null,
        id,
      ) as unknown as Connection | null;
  }

  deleteConnection(id: string) {
    this.db.query("DELETE FROM connections WHERE id = ?").run(id);
  }

  // ---- combos ----

  listCombos(): Combo[] {
    const rows = this.db.query("SELECT * FROM combos ORDER BY name ASC").all() as unknown as {
      id: string;
      name: string;
      models: string;
      strategy: string;
    }[];
    return rows.map((r) => ({ ...r, models: JSON.parse(r.models) }));
  }

  getCombo(name: string): Combo | undefined {
    const r = this.db.query("SELECT * FROM combos WHERE name = ?").get(name) as unknown as
      | { id: string; name: string; models: string; strategy: string }
      | undefined;
    return r ? { ...r, models: JSON.parse(r.models) } : undefined;
  }

  putCombo(name: string, models: string[], strategy = "fallback"): Combo {
    const row = this.db
      .query(
        "INSERT INTO combos (id, name, models, strategy) VALUES (?, ?, ?, ?) ON CONFLICT (name) DO UPDATE SET models = excluded.models, strategy = excluded.strategy RETURNING id, name, models, strategy",
      )
      .get(crypto.randomUUID(), name, JSON.stringify(models), strategy) as unknown as {
      id: string;
      name: string;
      models: string;
      strategy: string;
    };
    return { ...row, models: JSON.parse(row.models) };
  }

  deleteCombo(name: string) {
    this.db.query("DELETE FROM combos WHERE name = ?").run(name);
  }

  // ---- desired models ----

  /** List desired models ("provider/model" specs), oldest first. */
  listModels(): SavedModel[] {
    const rows = this.db.query("SELECT * FROM models ORDER BY created_at ASC").all() as {
      spec: string;
      created_at: string;
    }[];
    return rows.map((r) => {
      const { provider, model } = splitSpec(r.spec);
      return { spec: r.spec, provider, model, created_at: r.created_at };
    });
  }

  putModel(spec: string): SavedModel {
    const createdAt = new Date().toISOString();
    const row = this.db
      .query(
        "INSERT INTO models (spec, created_at) VALUES (?, ?) ON CONFLICT (spec) DO UPDATE SET spec = excluded.spec RETURNING created_at",
      )
      .get(spec, createdAt) as { created_at: string };
    const { provider, model } = splitSpec(spec);
    return { spec, provider, model, created_at: row.created_at };
  }

  deleteModel(spec: string) {
    this.db.query("DELETE FROM models WHERE spec = ?").run(spec);
  }

  // ---- settings ----

  getSettings(): Settings {
    const row = this.db.query("SELECT value FROM kv WHERE scope = 'settings' AND key = 'main'").get();
    if (!row) return { ...DEFAULTS };
    return { ...DEFAULTS, ...JSON.parse((row as { value: string }).value) };
  }

  putSettings(s: Partial<Settings>) {
    const cur = this.getSettings();
    const next = { ...cur, ...s };
    this.db
      .query(
        "INSERT INTO kv (scope, key, value) VALUES ('settings', 'main', ?) ON CONFLICT (scope, key) DO UPDATE SET value = excluded.value",
      )
      .run(JSON.stringify(next));
  }

  // ---- troy's own api key ----

  getApiAuth(): ApiAuth {
    const row = this.db.query("SELECT value FROM kv WHERE scope = 'api' AND key = 'auth'").get();
    if (!row) return { key: "", on: 1 };
    return { key: "", on: 1, ...JSON.parse((row as { value: string }).value) };
  }

  putApiAuth(a: ApiAuth) {
    this.db
      .query(
        "INSERT INTO kv (scope, key, value) VALUES ('api', 'auth', ?) ON CONFLICT (scope, key) DO UPDATE SET value = excluded.value",
      )
      .run(JSON.stringify(a));
  }

  // ---- dashboard password ----

  /** Stored password hash, or null while the default password is in effect. */
  getDashPass(): DashPass | null {
    const row = this.db.query("SELECT value FROM kv WHERE scope = 'dash' AND key = 'pass'").get();
    if (!row) return null;
    return JSON.parse((row as { value: string }).value) as DashPass;
  }

  putDashPass(p: DashPass) {
    this.db
      .query(
        "INSERT INTO kv (scope, key, value) VALUES ('dash', 'pass', ?) ON CONFLICT (scope, key) DO UPDATE SET value = excluded.value",
      )
      .run(JSON.stringify(p));
  }

  // ---- custom providers ----

  listCustomProviders(): Record<string, unknown>[] {
    const rows = this.db.query("SELECT key, value FROM kv WHERE scope = 'provider' ORDER BY key ASC").all() as {
      key: string;
      value: string;
    }[];
    return rows.map((r) => ({ id: r.key, ...JSON.parse(r.value) }));
  }

  putCustomProvider(id: string, p: Provider) {
    this.db
      .query(
        "INSERT INTO kv (scope, key, value) VALUES ('provider', ?, ?) ON CONFLICT (scope, key) DO UPDATE SET value = excluded.value",
      )
      .run(id, JSON.stringify({ ...p, id }));
  }

  deleteCustomProvider(id: string) {
    this.db.query("DELETE FROM kv WHERE scope = 'provider' AND key = ?").run(id);
  }

  // ---- usage log (batched, off hot path) ----

  logRequest(row: {
    provider: string;
    model: string;
    combo?: string;
    status: string;
    latency_ms: number;
    tokens?: Record<string, number>;
    rtk_saved?: number;
    rtk_seen?: number;
  }) {
    const rec: [string, string, string, string | null, string, number, string, number, number] = [
      new Date().toISOString(),
      row.provider,
      row.model,
      row.combo ?? null,
      row.status,
      row.latency_ms,
      JSON.stringify(row.tokens ?? {}),
      row.rtk_saved ?? 0,
      row.rtk_seen ?? 0,
    ];
    this.logQueue.push(rec);
  }

  startLogFlush(intervalMs = 2000) {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => this.flushLogs(), intervalMs);
    this.flushTimer.unref();
  }

  flushLogs() {
    if (this.logQueue.length === 0 && !this.lastTrim) return;
    const batch = this.logQueue.splice(0, this.logQueue.length);
    try {
      this.db.transaction(() => {
        for (const row of batch) {
          this.db
            .query(
              "INSERT INTO usage_history (ts, provider, model, combo, status, latency_ms, tokens, rtk_saved, rtk_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .run(...row);
        }
      })();
    } catch {
      // put the batch back so a transient lock/IO error doesn't silently drop
      // usage rows — bounded so a persistent failure can't grow memory forever
      const kept = batch.slice(-10_000);
      this.logQueue.unshift(...kept);
    }
    // bound the table so stats scans stay cheap forever
    if (!this.lastTrim || Date.now() - this.lastTrim > 3600_000) {
      this.lastTrim = Date.now();
      this.db.query("DELETE FROM usage_history WHERE ts < ?").run(new Date(Date.now() - 30 * 864e5).toISOString());
    }
  }

  listLogs(limit = 50) {
    const rows = this.db.query("SELECT * FROM usage_history ORDER BY ts DESC LIMIT ?").all(limit) as {
      tokens?: string;
    }[];
    return rows.map((r) => {
      // tokens is stored as JSON text — hand it to clients as an object,
      // otherwise every r.tokens.prompt_tokens read lands on a string
      if (typeof r.tokens !== "string") return { ...r, tokens: undefined };
      try {
        return { ...r, tokens: JSON.parse(r.tokens) };
      } catch {
        return { ...r, tokens: undefined };
      }
    });
  }

  /** Durable cooldown/circuit event — called before the in-memory mutation. */
  appendStateEvent(e: StateEvent): void {
    this.db
      .query(
        "INSERT INTO state_events (ts, kind, conn_id, key, circuit_key, status, reason, until_ms, backoff_level) VALUES (?,?,?,?,?,?,?,?,?)",
      )
      .run(
        e.ts,
        e.kind,
        e.conn_id,
        e.key ?? null,
        e.circuit_key ?? null,
        e.status ?? null,
        e.reason ?? null,
        e.until_ms ?? null,
        e.backoff_level ?? null,
      );
    // bound the log — cooldowns older than a day are worthless on replay
    if (!this.stateTrim || Date.now() - this.stateTrim > 3600_000) {
      this.stateTrim = Date.now();
      this.pruneStateEvents(86400_000);
    }
  }

  foldStateEvents(): StateEvent[] {
    return this.db.query("SELECT * FROM state_events ORDER BY id ASC").all() as StateEvent[];
  }

  pruneStateEvents(maxAgeMs: number): void {
    this.db.query("DELETE FROM state_events WHERE ts < ?").run(Date.now() - maxAgeMs);
  }

  /**
   * Request counts bucketed by LOCAL day + model for the last `days` days.
   * Zero-filled (every day in the window has an entry) so charts can render
   * a full axis without client-side gaps.
   */
  statsDaily(days: number): { days: { day: string; models: { model: string; requests: number }[] }[] } {
    const offsetMs = new Date().getTimezoneOffset() * 60_000;
    const dayKey = (iso: string) => new Date(Date.parse(iso) - offsetMs).toISOString().slice(0, 10);
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - days + 1);
    const out = new Map<string, Map<string, number>>();
    for (let i = 0; i < days; i++) {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      out.set(dayKey(d.toISOString()), new Map());
    }
    const rows = this.db.query("SELECT ts, model FROM usage_history WHERE ts >= ?").all(start.toISOString()) as {
      ts: string;
      model: string;
    }[];
    for (const r of rows) {
      const bucket = out.get(dayKey(r.ts));
      if (bucket) bucket.set(r.model, (bucket.get(r.model) ?? 0) + 1);
    }
    return {
      days: [...out.entries()].map(([day, models]) => ({
        day,
        models: [...models.entries()]
          .map(([model, requests]) => ({ model, requests }))
          .sort((a, b) => b.requests - a.requests),
      })),
    };
  }
}
