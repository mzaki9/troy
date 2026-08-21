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

/** Argon2id hash of the dashboard password via Bun.password. Stored in
 *  DashPass.hash (`$argon2id$…`) with DashPass.salt = "" — legacy rows keep
 *  their salted-SHA-256 hex in both fields, told apart by the `$` prefix. */
export function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password);
}

/** Check a password against a stored hash in either format: argon2id when the
 *  hash starts with `$`, else legacy salted SHA-256 (constant-time compare). */
export async function verifyPassword(password: string, salt: string, hash: string): Promise<boolean> {
  if (hash.startsWith("$")) return Bun.password.verify(password, hash);
  return safeEqual(hash, createHash("sha256").update(`${salt}:${password}`).digest("hex"));
}

/** Opaque dashboard session token — 64 hex chars (32 random bytes). */
export function newSessionToken(): string {
  return randomBytes(32).toString("hex");
}
