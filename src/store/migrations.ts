import type { Database } from "bun:sqlite";

/** Schema creation + in-place upgrades for pre-existing databases. Runs on
 *  every boot; every step is idempotent. */
export function runMigrations(db: Database): void {
  db.exec(`
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
        tokens TEXT DEFAULT '{}',
        rtk_saved INTEGER NOT NULL DEFAULT 0,
        rtk_seen INTEGER NOT NULL DEFAULT 0,
        request_id TEXT
      );      CREATE INDEX IF NOT EXISTS idx_conn_provider ON connections(provider, is_active, priority);
      CREATE INDEX IF NOT EXISTS idx_uh_ts ON usage_history(ts DESC);
      CREATE TABLE IF NOT EXISTS state_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        kind TEXT NOT NULL,
        conn_id TEXT NOT NULL,
        key TEXT,
        circuit_key TEXT,
        status INTEGER,
        reason TEXT,
        until_ms INTEGER,
        backoff_level INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_state_events_ts ON state_events(ts);
    `);
  // migrate old provider ids → canonical names
  db.run("UPDATE connections SET provider = 'alibaba' WHERE provider = 'alims-intl';");
  db.run("UPDATE usage_history SET provider = 'alibaba' WHERE provider = 'alims-intl';");
  db.run("UPDATE connections SET provider = 'zai' WHERE provider = 'glm';");
  db.run("UPDATE usage_history SET provider = 'zai' WHERE provider = 'glm';");
  db.run("UPDATE connections SET provider = 'zai-cn' WHERE provider = 'glm-cn';");
  db.run("UPDATE usage_history SET provider = 'zai-cn' WHERE provider = 'glm-cn';");
  db.run("UPDATE connections SET provider = 'alibaba-token-plan' WHERE provider = 'alitp-intl';");
  db.run("UPDATE usage_history SET provider = 'alibaba-token-plan' WHERE provider = 'alitp-intl';");
  // add connection name column on pre-existing databases
  const cols = db.query("PRAGMA table_info(connections)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "name")) {
    db.run("ALTER TABLE connections ADD COLUMN name TEXT");
  }
  // add combo strategy column on pre-existing databases
  const ccols = db.query("PRAGMA table_info(combos)").all() as { name: string }[];
  if (!ccols.some((c) => c.name === "strategy")) {
    db.run("ALTER TABLE combos ADD COLUMN strategy TEXT NOT NULL DEFAULT 'fallback'");
  }
  // RTK gain tracking columns on pre-existing databases
  const ucols = db.query("PRAGMA table_info(usage_history)").all() as { name: string }[];
  if (!ucols.some((c) => c.name === "rtk_saved")) {
    db.run("ALTER TABLE usage_history ADD COLUMN rtk_saved INTEGER NOT NULL DEFAULT 0");
    db.run("ALTER TABLE usage_history ADD COLUMN rtk_seen INTEGER NOT NULL DEFAULT 0");
  }
  if (!ucols.some((c) => c.name === "request_id")) {
    db.run("ALTER TABLE usage_history ADD COLUMN request_id TEXT");
  }
}
