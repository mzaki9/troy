import { useState } from "react";
import { cn } from "../lib/utils";
import { providerColor } from "../topology";

/** Filename overrides; everything else resolves to `providers/<id>.svg`. */
const FILE: Record<string, string> = {
  blackbox: "providers/blackbox.png",
  together: "providers/together.png",
  venice: "providers/venice.png",
  "glm-cn": "providers/glm-cn.png",
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

/**
 * Provider logo, or a colored monogram tile when the logo is missing/unavailable.
 * Pass sizing/rounding via className (e.g. "size-8 rounded-lg").
 */
export function ProviderIcon({ id, className }: { id: string; className?: string }) {
  const [broken, setBroken] = useState(false);

  if (broken) {
    return (
      <span
        className={cn("flex shrink-0 items-center justify-center text-xs font-bold", className)}
        style={{ background: providerColor(id) + "26", color: providerColor(id) }}
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
      className={cn("shrink-0 object-contain", className)}
      style={{ background: providerColor(id) + "1a" }}
      onError={() => setBroken(true)}
    />
  );
}