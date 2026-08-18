import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "./ui/button";
import { PAGES, type PageId } from "./sidebar";

export function Topbar({ page }: { page: PageId }) {
  const meta = PAGES.find((p) => p.id === page)!;
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    await navigator.clipboard.writeText(location.origin + "/v1").catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <header className="flex items-center justify-between gap-3 border-b border-border bg-background px-6 py-3">
      <div className="flex min-w-0 items-center gap-2.5">
        <meta.icon className="size-4 shrink-0 text-primary" />
        <div className="min-w-0">
          <h1 className="font-mono text-base leading-tight font-semibold tracking-tight">
            {meta.label}
          </h1>
          <p className="truncate text-xs text-muted-foreground">{meta.desc}</p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <span className="hidden rounded-md border bg-muted/60 px-2.5 py-1 font-mono text-xs text-muted-foreground sm:inline">
          {location.origin}/v1
        </span>
        <Button variant="ghost" size="icon" onClick={copy} aria-label="copy proxy url" title="copy proxy url">
          {copied ? <Check className="size-4 text-emerald-400" /> : <Copy className="size-4" />}
        </Button>
      </div>
    </header>
  );
}
