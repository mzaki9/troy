import { Database } from "bun:sqlite";
import type { Provider } from "./registry";

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

const DEFAULTS: Settings = {
  rtk_on: 1,
  caveman_level: "off",
  ponytail_level: "off",
  strategy: "fill-first",
};

export class Store {
  private db: Database;
  private logQueue: [string, string, string, string | null, string, number, string][] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private lastTrim = 0;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.run("PRAGMA journal_mode = WAL;");
    this.db.run("PRAGMA synchronous = NORMAL;");
    // memory budget: this proxy owns no hot dataset — cap the page cache at ~1 MiB
    // and checkpoint WAL often so the -wal file stays tiny
    this.db.run("PRAGMA cache_size = -1024;");
    this.db.run("PRAGMA wal_autocheckpoint = 500;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS connections (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        api_key TEXT NOT NULL,
        base_url TEXT,
        extra TEXT NOT NULL DEFAULT '{}',
        priority INTEGER NOT NULL DEFAULT 0,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS combos (
        id TEXT PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        models TEXT NOT NULL,
        strategy TEXT NOT NULL DEFAULT 'fallback'
      );
      CREATE TABLE IF NOT EXISTS models (
        spec TEXT PRIMARY KEY,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS kv (
        scope TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (scope, key)
      );
      CREATE TABLE IF NOT EXISTS usage_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        provider TEXT,
        model TEXT,
        combo TEXT,
        status TEXT,
        latency_ms INTEGER,
        tokens TEXT DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_conn_provider ON connections(provider, is_active, priority);
      CREATE INDEX IF NOT EXISTS idx_uh_ts ON usage_history(ts DESC);
    `);
    // migrate old provider ids → canonical names
    this.db.run("UPDATE connections SET provider = 'alibaba' WHERE provider = 'alims-intl';");
    this.db.run("UPDATE usage_history SET provider = 'alibaba' WHERE provider = 'alims-intl';");
    this.db.run("UPDATE connections SET provider = 'zai' WHERE provider = 'glm';");
    this.db.run("UPDATE usage_history SET provider = 'zai' WHERE provider = 'glm';");
    this.db.run("UPDATE connections SET provider = 'zai-cn' WHERE provider = 'glm-cn';");
    this.db.run("UPDATE usage_history SET provider = 'zai-cn' WHERE provider = 'glm-cn';");
    this.db.run("UPDATE connections SET provider = 'alibaba-token-plan' WHERE provider = 'alitp-intl';");
    this.db.run("UPDATE usage_history SET provider = 'alibaba-token-plan' WHERE provider = 'alitp-intl';");
    // add connection name column on pre-existing databases
    const cols = this.db.query("PRAGMA table_info(connections)").all() as { name: string }[];
    if (!cols.some((c) => c.name === "name")) {
      this.db.run("ALTER TABLE connections ADD COLUMN name TEXT");
    }
    // add combo strategy column on pre-existing databases
    const ccols = this.db.query("PRAGMA table_info(combos)").all() as { name: string }[];
    if (!ccols.some((c) => c.name === "strategy")) {
      this.db.run("ALTER TABLE combos ADD COLUMN strategy TEXT NOT NULL DEFAULT 'fallback'");
    }
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
      const i = r.spec.indexOf("/");
      return { spec: r.spec, provider: r.spec.slice(0, i), model: r.spec.slice(i + 1), created_at: r.created_at };
    });
  }

  putModel(spec: string): SavedModel {
    const createdAt = new Date().toISOString();
    const row = this.db
      .query(
        "INSERT INTO models (spec, created_at) VALUES (?, ?) ON CONFLICT (spec) DO UPDATE SET spec = excluded.spec RETURNING created_at",
      )
      .get(spec, createdAt) as { created_at: string };
    const i = spec.indexOf("/");
    return { spec, provider: spec.slice(0, i), model: spec.slice(i + 1), created_at: row.created_at };
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
  }) {
    const rec: [string, string, string, string | null, string, number, string] = [
      new Date().toISOString(),
      row.provider,
      row.model,
      row.combo ?? null,
      row.status,
      row.latency_ms,
      JSON.stringify(row.tokens ?? {}),
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
    this.db.transaction(() => {
      for (const row of batch) {
        this.db
          .query(
            "INSERT INTO usage_history (ts, provider, model, combo, status, latency_ms, tokens) VALUES (?, ?, ?, ?, ?, ?, ?)",
          )
          .run(...row);
      }
    })();
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
