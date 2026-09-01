/** In-memory fixed-window rate limiter — mirrors new-api's fixed-window semantics.
 *  Boundary burst up to 2× is documented and acceptable (do not switch to sliding window).
 *  Sweep expired windows every 60s with unref timer (reuse sessionSweep pattern).
 */
export class FixedWindowLimiter {
  private readonly windows = new Map<string, { count: number; start: number }>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {
    if (max <= 0 || windowMs <= 0) throw new Error("invalid limiter config");
    // sweep expired windows every 60s — unref so it never keeps process alive
    this.sweepTimer = setInterval(() => this.sweep(), 60_000);
    this.sweepTimer.unref?.();
  }

  /** Check and consume one token for `key`. Returns allowed + retryAfterMs (0 if allowed). */
  take(key: string): { allowed: boolean; retryAfterMs: number } {
    const now = Date.now();
    const rec = this.windows.get(key);
    if (!rec || now - rec.start >= this.windowMs) {
      this.windows.set(key, { count: 1, start: now });
      return { allowed: true, retryAfterMs: 0 };
    }
    if (rec.count < this.max) {
      rec.count += 1;
      return { allowed: true, retryAfterMs: 0 };
    }
    const retryAfterMs = rec.start + this.windowMs - now;
    return { allowed: false, retryAfterMs: Math.max(0, retryAfterMs) };
  }

  private sweep(): void {
    try {
      const now = Date.now();
      for (const [k, v] of this.windows) {
        if (now - v.start >= this.windowMs) this.windows.delete(k);
      }
    } catch {}
  }

  /** Stop the sweep timer (for tests / shutdown). */
  stop(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer as unknown as NodeJS.Timeout);
      this.sweepTimer = null;
    }
  }

  /** For tests: current window count. */
  size(): number {
    return this.windows.size;
  }
}

/** Parse "60/60s" or "5/10s" etc into {max, windowMs}. Returns null on parse failure. */
export function parseRateLimit(env: string | undefined, fallback: string): { max: number; windowMs: number } | null {
  const raw = (env ?? fallback).trim();
  if (!raw) return null;
  // forms: "60/60s", "60/60", "60", "60/s", "60/1m"
  const parts = raw.split("/");
  const max = Number(parts[0]);
  if (!Number.isFinite(max) || max <= 0) return null;
  if (parts.length === 1) {
    // just max, default window 60s
    return { max, windowMs: 60_000 };
  }
  const winStr = parts[1].trim().toLowerCase();
  // numeric seconds with optional s/m/h suffix
  const m = winStr.match(/^(\d+)(s|m|h)?$/);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2] ?? "s";
  let ms = n * 1000;
  if (unit === "m") ms = n * 60_000;
  else if (unit === "h") ms = n * 3600_000;
  return { max, windowMs: ms };
}
