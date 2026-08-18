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
}

export interface Settings {
  rtk_on: number;
  caveman_level: string;
  ponytail_level: string;
  strategy: string;
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

  constructor(path: string) {
    this.db = new Database(path);
    this.db.run("PRAGMA journal_mode = WAL;");
    this.db.run("PRAGMA synchronous = NORMAL;");
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
        models TEXT NOT NULL
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
    return this.db.query("SELECT * FROM connections ORDER BY provider ASC, priority ASC").all() as unknown as Connection[];
  }

  addConnection(c: { provider: string; api_key: string; name?: string | null; base_url?: string | null; extra?: string; priority?: number }): string {
    const id = crypto.randomUUID();
    const extra = c.extra ?? "{}";
    const priority = c.priority ?? 0;
    this.db
      .query(
        "INSERT INTO connections (id, provider, api_key, name, base_url, extra, priority, is_active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)"
      )
      .run(id, c.provider, c.api_key, c.name ?? null, c.base_url ?? null, extra, priority, new Date().toISOString());
    return id;
  }

  updateConnection(id: string, fields: Partial<Connection>) {
    const cur = this.getConnection(id);
    if (!cur) return;
    const next = { ...cur, ...fields };
    this.db
      .query("UPDATE connections SET api_key=?, name=?, base_url=?, extra=?, priority=?, is_active=? WHERE id=?")
      .run(next.api_key, next.name, next.base_url, next.extra, next.priority, next.is_active, id);
  }

  getConnection(id: string): Connection | undefined {
    return this.db.query("SELECT * FROM connections WHERE id = ?").get(id) as unknown as Connection | undefined;
  }

  deleteConnection(id: string) {
    this.db.query("DELETE FROM connections WHERE id = ?").run(id);
  }

  // ---- combos ----

  listCombos(): Combo[] {
    const rows = this.db.query("SELECT * FROM combos ORDER BY name ASC").all() as unknown as { id: string; name: string; models: string }[];
    return rows.map((r) => ({ ...r, models: JSON.parse(r.models) }));
  }

  getCombo(name: string): Combo | undefined {
    const r = this.db.query("SELECT * FROM combos WHERE name = ?").get(name) as unknown as { id: string; name: string; models: string } | undefined;
    return r ? { ...r, models: JSON.parse(r.models) } : undefined;
  }

  putCombo(name: string, models: string[]): void {
    const existing = this.db.query("SELECT id FROM combos WHERE name = ?").get(name);
    if (existing) {
      this.db.query("UPDATE combos SET models = ? WHERE name = ?").run(JSON.stringify(models), name);
    } else {
      this.db.query("INSERT INTO combos (id, name, models) VALUES (?, ?, ?)").run(crypto.randomUUID(), name, JSON.stringify(models));
    }
  }

  deleteCombo(name: string) {
    this.db.query("DELETE FROM combos WHERE name = ?").run(name);
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
      .query("INSERT INTO kv (scope, key, value) VALUES ('settings', 'main', ?) ON CONFLICT (scope, key) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify(next));
  }

  // ---- custom providers ----

  listCustomProviders(): Record<string, unknown>[] {
    const rows = this.db.query("SELECT key, value FROM kv WHERE scope = 'provider' ORDER BY key ASC").all() as { key: string; value: string }[];
    return rows.map((r) => ({ id: r.key, ...JSON.parse(r.value) }));
  }

  putCustomProvider(id: string, p: Provider) {
    this.db
      .query("INSERT INTO kv (scope, key, value) VALUES ('provider', ?, ?) ON CONFLICT (scope, key) DO UPDATE SET value = excluded.value")
      .run(id, JSON.stringify({ ...p, id }));
  }

  deleteCustomProvider(id: string) {
    this.db.query("DELETE FROM kv WHERE scope = 'provider' AND key = ?").run(id);
  }

  // ---- usage log (batched, off hot path) ----

  logRequest(row: { provider: string; model: string; combo?: string; status: string; latency_ms: number; tokens?: Record<string, number> }) {
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
    if (this.logQueue.length === 0) return;
    const batch = this.logQueue.splice(0, this.logQueue.length);
    this.db.transaction(() => {
      for (const row of batch) {
        this.db.query("INSERT INTO usage_history (ts, provider, model, combo, status, latency_ms, tokens) VALUES (?, ?, ?, ?, ?, ?, ?)").run(...row);
      }
    })();
  }

  listLogs(limit = 50) {
    return this.db.query("SELECT * FROM usage_history ORDER BY ts DESC LIMIT ?").all(limit);
  }
}