import type { Connection, StateEvent } from "../store/db";

const BACKOFF_CONFIG = { base: 2000, max: 300000, maxLevel: 15 };
/** symmetric ±10% jitter on backoff — synchronized expiries across accounts herd otherwise */
const BACKOFF_JITTER = 0.1;
const TRANSIENT_COOLDOWN_MS = 30000;
const COOLDOWN_LONG_MS = 120000;
const COOLDOWN_SHORT_MS = 5000;
const STICKY_ROUND_ROBIN_LIMIT = 3;
/** Circuit breaker: N failures within the window opens a member; it then
 *  fast-skips for OPEN_MS until a probe succeeds (half-open). */
const CIRCUIT_WINDOW_MS = 60000;
const CIRCUIT_THRESHOLD = 3;
const CIRCUIT_OPEN_MS = 30000;

const RE_DIGITS = /^\d+$/;

const ERROR_TEXT_BACKOFF = ["rate limit", "too many requests", "capacity", "overloaded"];

/** Balance/quota exhaustion — a dead account does not recover by retrying, so it
 *  gets one long lock instead of an escalating backoff ladder (dsh QUOTA split). */
const QUOTA_TEXT = [
  "insufficient balance",
  "insufficient credits",
  "insufficient quota",
  "quota exceeded",
  "out of budget",
  "exceeded your current quota",
  "billing",
];

const now = () => Date.now();

/** 8-char account id prefix for trace lines — full UUIDs are unreadable noise. */
function shortId(id: string): string {
  return id.slice(0, 8);
}

interface CooldownState {
  until: number;
  backoff: number;
  locks: Map<string, number>;
}

/** Durable sink for cooldown/circuit transitions — troy wires this to the
 *  SQLite `state_events` log so breakers survive restarts. */
export interface CooldownSink {
  append(e: StateEvent): void;
}

export interface RRChainPersist {
  get(name: string): number;
  set(name: string, n: number): void;
}

export class CooldownStore {
  private states = new Map<string, CooldownState>();
  private rr = new Map<string, { id: string; count: number }>();
  /** last failure text per account key — surfaced in 503s so "unavailable" is diagnosable */
  private reasons = new Map<string, string>();
  /** circuit breaker: member (provider/model) → { failures: timestamps[], openUntil } */
  private circuits = new Map<string, { fails: number[]; openUntil: number }>();
  /** per-combo round-robin start index (chain-level rotation) */
  private rrChain = new Map<string, number>();

  constructor(
    private readonly sink?: CooldownSink,
    private readonly trace?: (line: string) => void,
    private readonly rrPersist?: RRChainPersist,
  ) {}

  /** Rebuild in-memory state from the durable event log (boot recovery).
   *  Expired entries are dropped; the newest fail per key wins via max(). */
  static replay(
    events: StateEvent[],
    sink?: CooldownSink,
    trace?: (line: string) => void,
    rrPersist?: RRChainPersist,
  ): CooldownStore {
    const st = new CooldownStore(sink, trace, rrPersist);
    let locks = 0;
    let circuits = 0;
    for (const e of events) {
      if (e.kind === "circuit_open") {
        if (!e.circuit_key || e.until_ms === null || e.until_ms === undefined || e.until_ms <= now()) continue;
        st.circuits.set(e.circuit_key, { fails: [], openUntil: e.until_ms });
        circuits++;
        continue;
      }
      if (e.kind === "success") {
        st.success(e.conn_id, e.key ?? "*", e.circuit_key ?? undefined);
        continue;
      }
      // fail
      if (!e.until_ms || e.until_ms <= now()) continue;
      const s = st.ensure(e.conn_id);
      s.until = Math.max(s.until, e.until_ms);
      s.backoff = Math.max(s.backoff, e.backoff_level ?? 0);
      const lockKey = e.key ?? "*";
      s.locks.set(lockKey, Math.max(s.locks.get(lockKey) ?? 0, e.until_ms));
      if (e.reason && e.key) st.reasons.set(`${e.conn_id}|${e.key}`, e.reason);
      locks++;
    }
    if (locks || circuits) st.trace?.(`recovered ${locks} cooldown(s), ${circuits} open circuit(s)`);
    return st;
  }

  private persist(e: StateEvent) {
    try {
      this.sink?.append(e);
    } catch {
      /* durability must never break routing */
    }
  }

  /** terminal trace line — account ids shortened to 8 chars for readability */
  private emit(line: string) {
    try {
      this.trace?.(line);
    } catch {
      /* tracing must never break routing */
    }
  }

  /** next start index for a round-robin combo chain — persisted in kv so restarts keep rotation */
  nextChainStart(name: string): number {
    const n = this.rrPersist ? this.rrPersist.get(name) : (this.rrChain.get(name) ?? 0);
    const next = n + 1;
    if (this.rrPersist) {
      try {
        this.rrPersist.set(name, next);
      } catch {
        /* persistence must never break routing */
      }
    } else {
      this.rrChain.set(name, next);
    }
    return n;
  }

  /** The reason an account got locked, so the 503 can explain itself. */
  lastFailReason(id: string, key: string): string | null {
    return this.reasons.get(`${id}|${key}`) ?? this.reasons.get(`${id}|*`) ?? null;
  }

  /** true while a member's circuit is open — the fallback walk skips it fast. */
  isOpen(key: string): boolean {
    const c = this.circuits.get(key);
    if (!c) return false;
    if (c.openUntil > now()) return true;
    this.circuits.delete(key);
    return false;
  }

  backoffLevel(id: string): number {
    return this.states.get(id)?.backoff ?? 0;
  }

  lockExpiry(id: string, key: string): number {
    const s = this.states.get(id);
    if (!s) return 0;
    return Math.max(s.until, s.locks.get(key) ?? 0, s.locks.get("*") ?? 0);
  }

  isEligible(id: string, key: string): boolean {
    return this.lockExpiry(id, key) <= now();
  }

  fail(id: string, key: string, status: number, errText: string, circuitKey = key, retryAfterMs?: number | null) {
    const s = this.ensure(id);
    const cls = classify(status, errText, s.backoff);
    // server Retry-After wins over local backoff when sane (dsh llm-retry rule)
    const cooldownMs =
      retryAfterMs != null && retryAfterMs > 0 && retryAfterMs <= BACKOFF_CONFIG.max ? retryAfterMs : cls.cooldownMs;
    const until = now() + cooldownMs;
    // write-ahead: durable before memory so a restart folds this back
    this.persist({
      ts: now(),
      kind: "fail",
      conn_id: id,
      key,
      circuit_key: circuitKey,
      status,
      reason: extractReason(errText),
      until_ms: until,
      backoff_level: cls.newBackoffLevel,
    });
    s.until = until;
    s.backoff = cls.newBackoffLevel;
    s.locks.set(key, until);
    const reason = extractReason(errText);
    if (reason) this.reasons.set(`${id}|${key}`, reason);
    this.countFailure(circuitKey);
    this.emit(
      `cooldown ${key} ${status || "net"} → ${Math.round(cooldownMs / 1000)}s (acct ${shortId(id)})${reason ? ` — ${reason}` : ""}`,
    );
  }

  success(id: string, key: string, circuitKey = key) {
    const s = this.states.get(id);
    if (!s) return;
    // trace only real recoveries — a plain 200 with nothing locked is noise
    const wasLocked = s.until > now() || (s.locks.get(key) ?? 0) > now() || this.circuits.has(circuitKey);
    this.persist({ ts: now(), kind: "success", conn_id: id, key, circuit_key: circuitKey });
    s.locks.delete(key);
    s.until = 0;
    for (const [k, v] of s.locks) {
      if (v <= now()) s.locks.delete(k);
    }
    if (s.locks.size === 0) {
      s.backoff = 0;
      this.reasons.delete(`${id}|${key}`);
      this.reasons.delete(`${id}|*`);
      // drop the shell entirely — states must not grow with every account ever seen
      if (s.until <= now()) this.states.delete(id);
    }
    // half-open probe succeeded → close the circuit
    this.circuits.delete(circuitKey);
    if (wasLocked) this.emit(`clear ${key} (acct ${shortId(id)})`);
  }

  private countFailure(key: string) {
    const c = this.circuits.get(key) ?? { fails: [], openUntil: 0 };
    c.fails = c.fails.filter((t) => t > now() - CIRCUIT_WINDOW_MS);
    c.fails.push(now());
    if (c.fails.length >= CIRCUIT_THRESHOLD) {
      c.openUntil = now() + CIRCUIT_OPEN_MS;
      this.persist({ ts: now(), kind: "circuit_open", conn_id: "", circuit_key: key, until_ms: c.openUntil });
      this.emit(`circuit OPEN ${key} — ${c.fails.length} fails, skipping ${Math.round(CIRCUIT_OPEN_MS / 1000)}s`);
    }
    this.circuits.set(key, c);
  }

  earliestRetryAfter(): number | null {
    let earliest: number | null = null;
    const t = now();
    for (const s of this.states.values()) {
      if (s.until > t && (earliest === null || s.until < earliest)) earliest = s.until;
      for (const until of s.locks.values()) {
        if (until > t && (earliest === null || until < earliest)) earliest = until;
      }
    }
    return earliest;
  }

  pick(eligible: Connection[], key: string, strategy: string): Connection {
    const first = eligible[0];
    if (strategy !== "round-robin" || eligible.length < 2) return first;
    const st = this.rr.get(key);
    if (st && eligible.some((c) => c.id === st.id) && st.count < STICKY_ROUND_ROBIN_LIMIT - 1) {
      st.count += 1;
      return eligible.find((c) => c.id === st.id)!;
    }
    const idx = st
      ? Math.max(
          0,
          eligible.findIndex((c) => c.id === st.id),
        )
      : -1;
    const next = eligible[(idx + 1) % eligible.length];
    this.rr.set(key, { id: next.id, count: 0 });
    return next;
  }

  private ensure(id: string): CooldownState {
    let s = this.states.get(id);
    if (!s) {
      s = { until: 0, backoff: 0, locks: new Map() };
      this.states.set(id, s);
    }
    return s;
  }
}

type FailKind = "rate" | "quota" | "auth" | "short" | "transient";

function classify(
  status: number,
  errText: string,
  backoffLevel = 0,
): { kind: FailKind; cooldownMs: number; newBackoffLevel: number } {
  const lower = String(errText ?? "").toLowerCase();
  if (lower.includes("request not allowed"))
    return { kind: "short", cooldownMs: COOLDOWN_SHORT_MS, newBackoffLevel: backoffLevel };
  // quota/balance death: long lock, NO backoff escalation — retrying sooner never helps
  if (status === 402 || QUOTA_TEXT.some((r) => lower.includes(r)))
    return { kind: "quota", cooldownMs: COOLDOWN_LONG_MS, newBackoffLevel: backoffLevel };
  const backsOff = ERROR_TEXT_BACKOFF.some((r) => lower.includes(r)) || status === 429;
  if (backsOff) {
    const lvl = Math.min(backoffLevel + 1, BACKOFF_CONFIG.maxLevel);
    return { kind: "rate", cooldownMs: backoffDelay(lvl), newBackoffLevel: lvl };
  }
  if (status === 401 || status === 403 || status === 404) {
    return { kind: "auth", cooldownMs: COOLDOWN_LONG_MS, newBackoffLevel: backoffLevel };
  }
  return { kind: "transient", cooldownMs: TRANSIENT_COOLDOWN_MS, newBackoffLevel: backoffLevel };
}

/** Exponential backoff with symmetric jitter (dsh llm-retry formula). */
function backoffDelay(level: number): number {
  const base = Math.min(BACKOFF_CONFIG.base * 2 ** Math.max(0, level - 1), BACKOFF_CONFIG.max);
  return Math.round(base * (1 - BACKOFF_JITTER + 2 * BACKOFF_JITTER * Math.random()));
}

/** Upstream `Retry-After` header: seconds integer or HTTP-date → ms delay from
 *  now, else null. Honored verbatim over local backoff when sane. */
export function parseRetryAfter(v: string | null): number | null {
  if (!v) return null;
  const s = v.trim();
  if (RE_DIGITS.test(s)) return Number(s) * 1000;
  const d = Date.parse(s);
  return Number.isNaN(d) ? null : Math.max(0, d - now());
}

/** A short, human-safe failure excerpt for cooldown reasons (upstream error text can be huge). */
function extractReason(errText: string): string | null {
  const t = String(errText ?? "").trim();
  if (!t || t === "{}") return null;
  try {
    const j = JSON.parse(t) as { error?: { message?: string; type?: string } };
    const m = j?.error?.type && j?.error?.message ? `${j.error.type}: ${j.error.message}` : j?.error?.message;
    if (m) return m;
  } catch {
    /* non-JSON — use raw text */
  }
  return t.length > 160 ? `${t.slice(0, 160)}…` : t;
}
