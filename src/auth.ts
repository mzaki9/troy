/** Troy's own API key: generation + request extraction. Kept pure (no Bun
 * server state) so the checks are unit-testable. */

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
