export function isPrivateHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h === "::1" || h === "0.0.0.0") return true;
  // IPv4
  const v4 = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 0) return true;
  }
  // IPv6 private
  if (h.startsWith("fc") || h.startsWith("fd") || h === "::" || h.startsWith("::ffff:")) {
    // fc00::/7, ::ffff: private mapped
    if (h.startsWith("fc") || h.startsWith("fd")) return true;
  }
  if (h.endsWith(".localhost")) return true;
  return false;
}

export function allowLoopback(): boolean {
  return process.env.TROY_ALLOW_LOOPBACK === "1";
}

export function assertPublicUrl(urlStr: string): void {
  let u: URL;
  try {
    u = new URL(urlStr);
  } catch {
    throw new Error("invalid url");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("url must be http(s)");
  const h = u.hostname.toLowerCase();
  const nh = h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h;
  const isLoopback = nh === "127.0.0.1" || nh === "localhost" || nh === "::1" || nh === "0.0.0.0";
  if (isLoopback) {
    if (!allowLoopback()) throw new Error("private address blocked — set TROY_ALLOW_LOOPBACK=1 for local dev");
  } else if (isPrivateHostname(nh)) {
    throw new Error("private address blocked — set TROY_ALLOW_LOOPBACK=1 for local dev");
  }
}

export function assertPlaceholderValue(k: string, v: string): void {
  if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(k)) throw new Error(`invalid placeholder key: ${k}`);
  if (v.length > 512) throw new Error(`placeholder value too long: ${k}`);
  if (
    v.includes("://") ||
    v.includes("..") ||
    v.includes("\n") ||
    v.includes("\r") ||
    v.includes("<") ||
    v.includes(">") ||
    v.includes('"') ||
    v.includes("'")
  ) {
    throw new Error(`invalid placeholder value for ${k}`);
  }
}
