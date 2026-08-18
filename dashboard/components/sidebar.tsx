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
      <div className="flex items-center gap-2.5 px-6 pt-6 pb-5">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary">
          <img src="/favicon.svg" alt="troy" className="size-5" />
        </span>
        <span className="min-w-0">
          <span className="block text-[15px] leading-tight font-semibold tracking-tight">troy</span>
          <span className="block text-[10px] tracking-[0.08em] text-muted-foreground uppercase">
            minimal ai router
          </span>
        </span>
      </div>

      <nav className="flex-1 space-y-1 px-4 py-2">
        <p className="px-4 pt-2 pb-2 text-[10px] tracking-[0.08em] text-muted-foreground uppercase">
          router
        </p>
        {PAGES.map((p) => (
          <button
            key={p.id}
            onClick={() => onNavigate(p.id)}
            className={cn(
              "flex w-full items-center gap-3 rounded-full px-4 py-2 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
              page === p.id && "bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground"
            )}
          >
            <p.icon className="size-4" />
            {p.label}
          </button>
        ))}
      </nav>

      <div className="border-t border-border px-6 py-4">
        <p className="flex items-center gap-1.5 text-[10px] tracking-[0.08em] text-muted-foreground uppercase">
          <span className="size-1.5 bg-aloe ring-1 ring-black/10" aria-hidden="true" />
          router online
        </p>
        <p className="mt-1.5 truncate font-mono text-[11px] text-muted-foreground">
          {location.origin}/v1
        </p>
      </div>
    </aside>
  );
}
