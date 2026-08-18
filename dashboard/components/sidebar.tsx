import { Gauge, Layers, Network, Settings2 } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "../lib/utils";

export const PAGES: { id: PageId; label: string; desc: string; icon: LucideIcon }[] = [
  { id: "usage", label: "Usage", desc: "requests, providers, latency", icon: Gauge },
  { id: "providers", label: "Providers", desc: "OpenAI-compatible catalog + connections", icon: Network },
  { id: "combos", label: "Combos", desc: "ordered fallback chains", icon: Layers },
  { id: "settings", label: "Settings", desc: "routing & token savers", icon: Settings2 },
];

export type PageId = "usage" | "providers" | "combos" | "settings";

export function Sidebar({
  page,
  onNavigate,
}: {
  page: PageId;
  onNavigate: (p: PageId) => void;
}) {
  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-border bg-card">
      <div className="flex items-center gap-2.5 px-5 pt-5 pb-4">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-primary/40 bg-gradient-to-br from-[#4493f8] to-[#2458ab] font-mono text-[13px] font-bold text-white">
          T
        </span>
        <span className="min-w-0">
          <span className="block font-mono text-[13px] font-semibold tracking-wide">troy</span>
          <span className="block text-[10px] tracking-widest text-muted-foreground uppercase">
            minimal ai router
          </span>
        </span>
      </div>

      <nav className="flex-1 space-y-0.5 px-3 py-2">
        <p className="px-2.5 pt-2 pb-1.5 font-mono text-[10px] tracking-widest text-muted-foreground uppercase">
          router
        </p>
        {PAGES.map((p) => (
          <button
            key={p.id}
            onClick={() => onNavigate(p.id)}
            className={cn(
              "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
              page === p.id &&
                "bg-primary/10 text-primary ring-1 ring-inset ring-primary/20 hover:bg-primary/10 hover:text-primary"
            )}
          >
            <p.icon className="size-4" />
            {p.label}
          </button>
        ))}
      </nav>

      <div className="border-t border-border px-5 py-3">
        <p className="flex items-center gap-1.5 font-mono text-[10px] tracking-widest text-muted-foreground uppercase">
          <span className="size-1.5 bg-emerald-500" aria-hidden="true" />
          router online
        </p>
        <p className="mt-1.5 truncate font-mono text-[11px] text-muted-foreground/80">
          {location.origin}/v1
        </p>
      </div>
    </aside>
  );
}
