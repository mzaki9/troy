import { createHash, randomBytes } from "node:crypto";

/** Troy's own API key: generation + request extraction. Kept pure (no Bun
 * server state) so the checks are unit-testable. */

/** Out-of-the-box dashboard password — shown on the login screen until the
 * user replaces it (Settings → Dashboard password). */
export const DEFAULT_DASHBOARD_PASS = "troy123";

/** Pull a bearer token or `x-api-key` off a request, or null when absent. */
export function extractApiKey(request: Request): string | null {
  const auth = request.headers.get("authorization")?.trim();
  const m = auth ? /^Bearer\s+(.+)$/i.exec(auth) : null;
  if (m?.[1]?.trim()) return m[1].trim();
  const x = request.headers.get("x-api-key");
  return x?.trim() ? x.trim() : null;
}

/** Constant-time string compare — the key never leaks its prefix via timing. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Fresh key: `sk-troy-` + 48 hex chars (24 random bytes). */
export function generateApiKey(prefix = "sk-troy-"): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return prefix + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Salted SHA-256 of the dashboard password. Salt is random per call unless
 * injected (tests use a fixed salt for stable fixtures). */
export function hashPassword(
  password: string,
  salt = randomBytes(16).toString("hex"),
): {
  salt: string;
  hash: string;
} {
  return { salt, hash: createHash("sha256").update(`${salt}:${password}`).digest("hex") };
}

/** Constant-time check of a password against its stored salt+hash. */
export function verifyPassword(password: string, salt: string, hash: string): boolean {
  return safeEqual(hash, hashPassword(password, salt).hash);
}

/** Opaque dashboard session token — 64 hex chars (32 random bytes). */
export function newSessionToken(): string {
  return randomBytes(32).toString("hex");
}
