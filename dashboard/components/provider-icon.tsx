import { useState } from "react";
import { cn } from "../lib/utils";

/** Brand-ish hues for provider monogram tiles; deterministic fallback for unknown ids. */
const COLORS: Record<string, string> = {
  openai: "#10a37f",
  deepseek: "#4d6bfe",
  groq: "#f55036",
  openrouter: "#2f7cf6",
  mistral: "#f7a600",
  xai: "#9ca3af",
  cerebras: "#0081cc",
  together: "#00a6ff",
  nvidia: "#76b900",
  glm: "#5b8cff",
  venice: "#a855f7",
  cohere: "#5a4fcf",
  perplexity: "#5fc98f",
  cloudflare: "#f6821f",
  github: "#a371f7",
  anthropic: "#d97757",
  gemini: "#4285f4",
};

export function providerColor(id: string): string {
  if (COLORS[id]) return COLORS[id];
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360} 70% 62%)`;
}

/** Filename overrides; everything else resolves to `providers/<id>.svg`. */
const FILE: Record<string, string> = {
  blackbox: "providers/blackbox.png",
  together: "providers/together.png",
  venice: "providers/venice.png",
  "xiaomi-mimo": "providers/xiaomi-mimo.png",
  // provider ids that outgrew their original brand name — reuse the existing logo
  zai: "providers/glm.svg",
  "zai-cn": "providers/glm-cn.png",
  alibaba: "providers/alims-intl.svg",
  "alibaba-token-plan": "providers/alitp-intl.svg",
  "command-code": "providers/command.svg",
};

export function providerIconSrc(id: string): string {
  return FILE[id] ?? `providers/${id}.svg`;
}

/** glyph is ink-on-transparent — inverts on the light tile of night track */
const INVERT: Record<string, true> = { "command-code": true };

/**
 * Provider logo, or a colored monogram tile when the logo is missing/unavailable.
 * Pass sizing/rounding via className (e.g. "size-8 rounded-lg").
 */
export function ProviderIcon({ id, className }: { id: string; className?: string }) {
  const [broken, setBroken] = useState(false);

  // "unknown" is a sentinel provider id (unroutable requests); no file exists for it
  if (broken || id === "unknown") {
    return (
      <span
        className={cn("flex shrink-0 items-center justify-center text-xs font-bold", className)}
        style={{ background: `${providerColor(id)}26`, color: providerColor(id) }}
      >
        {id.slice(0, 2).toUpperCase()}
      </span>
    );
  }

  return (
    <img
      src={providerIconSrc(id)}
      alt={id}
      loading="lazy"
      className={cn("shrink-0 object-contain", INVERT[id] && "dark:invert", className)}
      style={{ background: `${providerColor(id)}1a` }}
      onError={() => setBroken(true)}
    />
  );
}
