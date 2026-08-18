import { useEffect, useRef, useState } from "react";
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
  const navRef = useRef<HTMLElement | null>(null);
  const btnRefs = useRef<Partial<Record<PageId, HTMLButtonElement | null>>>({});
  const [ind, setInd] = useState<{ top: number; height: number } | null>(null);

  const measure = () => {
    const btn = btnRefs.current[page];
    if (!btn) return;
    setInd({ top: btn.offsetTop, height: btn.offsetHeight });
  };

  useEffect(measure, [page]);
  useEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const ro = new ResizeObserver(measure);
    ro.observe(nav);
    return () => ro.disconnect();
  }, [page]);

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

      <nav ref={navRef} className="relative flex-1 space-y-1 px-4 py-2">
        <p className="px-4 pt-2 pb-2 text-[10px] tracking-[0.08em] text-muted-foreground uppercase">
          router
        </p>
        <span
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute inset-x-4 rounded-full bg-primary transition-[top] duration-[120ms] ease-out motion-reduce:transition-none",
            ind ? "opacity-100" : "opacity-0"
          )}
          style={ind ? { top: ind.top, height: ind.height } : undefined}
        />
        {PAGES.map((p) => (
          <button
            key={p.id}
            ref={(el) => {
              btnRefs.current[p.id] = el;
            }}
            onClick={() => onNavigate(p.id)}
            className={cn(
              "relative flex w-full items-center gap-3 rounded-full px-4 py-2 text-[13px] font-medium transition-colors",
              page === p.id
                ? "text-primary-foreground hover:text-primary-foreground"
                : "text-muted-foreground hover:text-foreground"
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
