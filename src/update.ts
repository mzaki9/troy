import pkg from "../package.json";
import { cLog, TAG, trace } from "./logger";

export const CURRENT_VERSION: string = pkg.version ?? "0.0.0";

const REGISTRY_URL = "https://registry.npmjs.org/troy-proxy/latest";

export interface UpdateStatus {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  checkedAt: string | null;
  disabled: boolean;
}

export type StopUpdateChecks = () => void;

function normalize(v: string): { core: number[]; pre: string | null } {
  let s = v.trim();
  if (s.startsWith("v") || s.startsWith("V") || s.startsWith("=")) s = s.slice(1);
  const plus = s.indexOf("+");
  if (plus !== -1) s = s.slice(0, plus);
  let coreStr = s;
  let pre: string | null = null;
  const dash = s.indexOf("-");
  if (dash !== -1) {
    coreStr = s.slice(0, dash);
    pre = s.slice(dash + 1);
  }
  const core = coreStr.split(".").map((p) => {
    const n = Number.parseInt(p, 10);
    return Number.isNaN(n) ? 0 : n;
  });
  return { core, pre };
}

export function compareVersions(a: string, b: string): number {
  const A = normalize(a);
  const B = normalize(b);
  const len = Math.max(A.core.length, B.core.length);
  for (let i = 0; i < len; i++) {
    const av = A.core[i] ?? 0;
    const bv = B.core[i] ?? 0;
    if (av !== bv) return av < bv ? -1 : 1;
  }
  if (A.pre === B.pre) return 0;
  if (A.pre === null) return 1;
  if (B.pre === null) return -1;
  return A.pre < B.pre ? -1 : 1;
}

export function isNewer(latest: string, current: string): boolean {
  return compareVersions(latest, current) > 0;
}

// ---- state ------------------------------------------------------------------

let latest: string | null = null;
let checkedAt: string | null = null;
let updateAvailable = false;
let notifiedFor: string | null = null;

function disabledByEnv(): boolean {
  return process.env.TROY_NO_UPDATE_CHECK === "1";
}

export function getUpdateStatus(): UpdateStatus {
  return {
    current: CURRENT_VERSION,
    latest,
    updateAvailable,
    checkedAt,
    disabled: disabledByEnv(),
  };
}

export async function checkOnce(
  log: (msg: string) => void = (msg) => trace(TAG.SYSTEM, msg),
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response> = fetch,
): Promise<void> {
  if (disabledByEnv()) return;
  try {
    const res = await fetchImpl(REGISTRY_URL, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data: unknown = await res.json();
    if (!data || typeof data !== "object" || !("version" in data)) throw new Error("bad version");
    const raw = data.version;
    if (typeof raw !== "string" || !raw.trim()) throw new Error("bad version");
    const v = raw.trim();
    latest = v;
    checkedAt = new Date().toISOString();
    updateAvailable = isNewer(v, CURRENT_VERSION);
  } catch (err) {
    log(`[update] check failed, keeping previous (${err instanceof Error ? err.message : String(err)})`);
  }
}

// ponytail: fixed 30s first-check / 6h poll; add env knob when operators ask for it.
const FIRST_CHECK_MS = 30_000;
const POLL_MS = 6 * 3_600_000;

function noopStop(): void {}

export function startUpdateChecks(
  log: (msg: string) => void = (msg) => cLog(TAG.SYSTEM, { msg }),
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response> = fetch,
): StopUpdateChecks {
  if (disabledByEnv()) return noopStop;
  let stopped = false;
  const timeout: NodeJS.Timeout = setTimeout(() => {
    if (!stopped) void run();
  }, FIRST_CHECK_MS);
  timeout.unref?.();
  const interval: NodeJS.Timeout = setInterval(() => {
    if (!stopped) void run();
  }, POLL_MS);
  interval.unref?.();
  async function run(): Promise<void> {
    await checkOnce(undefined, fetchImpl);
    if (latest !== null && updateAvailable && notifiedFor !== latest) {
      notifiedFor = latest;
      log(
        `troy update available: ${CURRENT_VERSION} → ${latest} — upgrade: npm i -g troy-proxy@latest (or: bun add -g troy-proxy@latest)`,
      );
    }
  }
  return () => {
    stopped = true;
    try {
      clearTimeout(timeout);
    } catch {}
    try {
      clearInterval(interval);
    } catch {}
  };
}

// ---- test hooks -------------------------------------------------------------

export function __setUpdateStatusForTests(s: Partial<UpdateStatus>): void {
  if (s.latest !== undefined) latest = s.latest;
  if (s.checkedAt !== undefined) checkedAt = s.checkedAt;
  if (s.updateAvailable !== undefined) updateAvailable = s.updateAvailable;
}

export function __resetUpdateStateForTests(): void {
  latest = null;
  checkedAt = null;
  updateAvailable = false;
  notifiedFor = null;
}
