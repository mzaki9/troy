/**
 * Shared image-part normalizer — single place that understands every image
 * shape clients send. Bridges map the normalized URL to their native shape.
 *
 * Shapes covered (9router/OmniRoute parity):
 * - OpenAI chat: {type:"image_url", image_url:{url, detail}|string}
 * - AI-SDK (OpenCode): {type:"image", image:"data:...|https:..."}
 * - Claude: {type:"image", source:{type:"base64", media_type, data}}
 * - Claude URL: {type:"image", source:{type:"url", url}}
 * - Responses: {type:"input_image", image_url:"..."} or {url:"..."}
 */

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Normalized image: ready-to-forward URL (remote or data:) + optional detail. */
export interface NormalizedImage {
  url: string;
  detail?: string;
}

/** One content item → image URL + detail, or undefined when not an image. */
export function extractImage(part: Obj): NormalizedImage | undefined {
  const detailOf = (o: Obj): string | undefined => {
    const d = str(o.detail);
    return d || undefined;
  };

  // Responses input_image: image_url is a plain string (or {url} variant)
  if (part.type === "input_image") {
    const iu = part.image_url;
    if (typeof iu === "string" && iu) return { url: iu, detail: str(part.detail) || undefined };
    if (isObj(iu)) {
      const url = str(iu.url) || str(iu.image_url);
      if (url) return { url, detail: detailOf(part) ?? detailOf(iu) };
    }
    const direct = str(part.url);
    if (direct) return { url: direct, detail: str(part.detail) || undefined };
    return undefined;
  }

  // OpenAI image_url: {url, detail} object or bare string
  if (part.type === "image_url") {
    const iu = part.image_url;
    if (typeof iu === "string" && iu) return { url: iu, detail: detailOf(part) };
    if (isObj(iu)) {
      const url = str(iu.url);
      if (url) return { url, detail: detailOf(part) ?? detailOf(iu) };
    }
    return undefined;
  }

  // AI-SDK / CC image: direct string, or Anthropic-style source block
  if (part.type === "image") {
    const direct = str(part.image);
    if (direct) return { url: direct, detail: detailOf(part) };
    const source = isObj(part.source) ? part.source : null;
    if (source) {
      if (source.type === "base64") {
        const data = str(source.data);
        if (data) return { url: `data:${str(source.media_type) || "image/png"};base64,${data}` };
      }
      const url = str(source.url);
      if (url) return { url };
    }
    return undefined;
  }

  return undefined;
}

export type SplitPart = { kind: "text"; text: string } | { kind: "image"; image: NormalizedImage };

/** chat content (string | parts[]) → text/image parts. Unknown parts skipped. */
export function splitContent(content: unknown): SplitPart[] {
  if (typeof content === "string") return content ? [{ kind: "text", text: content }] : [];
  if (!Array.isArray(content)) return [];
  const out: SplitPart[] = [];
  for (const raw of content) {
    if (!isObj(raw)) continue;
    if (raw.type === "text" || raw.type === "input_text") {
      const t = str(raw.text);
      if (t) out.push({ kind: "text", text: t });
      continue;
    }
    const img = extractImage(raw);
    if (img) out.push({ kind: "image", image: img });
  }
  return out;
}

/** Structured vision scan over chat messages — no substring matching. */
export function hasVision(messages: unknown): boolean {
  if (!Array.isArray(messages)) return false;
  for (const raw of messages) {
    if (!isObj(raw)) continue;
    const c = raw.content;
    if (typeof c === "string") continue;
    if (!Array.isArray(c)) continue;
    for (const p of c) {
      if (isObj(p) && (p.type === "image_url" || p.type === "image" || p.type === "input_image")) {
        if (extractImage(p)) return true;
      }
    }
  }
  return false;
}

/** ~1k vision tokens per image; base64 payload excluded from the /4 estimate. */
const IMAGE_TOKEN_EST = 1000;

/** Token estimate for preflight: full JSON length/4, minus base64 payload
 *  bytes (counted flat instead), plus ~1k vision tokens per image. Remote
 *  URLs stay in the /4 estimate — they are short. */
export function estimateTokens(messages: unknown): number {
  const jsonLen = JSON.stringify(messages ?? "").length;
  if (!Array.isArray(messages)) return Math.ceil(jsonLen / 4);
  let images = 0;
  let dataLen = 0;
  for (const raw of messages) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
    for (const part of splitContent((raw as Record<string, unknown>).content)) {
      if (part.kind !== "image") continue;
      images += 1;
      if (part.image.url.startsWith("data:")) dataLen += part.image.url.length;
    }
  }
  return Math.ceil((jsonLen - dataLen) / 4) + images * IMAGE_TOKEN_EST;
}

// ponytail: no blob store / remote fetch / downscale here —
// add when payloads hit limits or an upstream rejects oversize images.
