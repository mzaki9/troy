import { useState } from "react";
import { Check, Copy, Moon, Sun } from "lucide-react";
import { Button } from "./ui/button";
import { PAGES, type PageId } from "./sidebar";
import { toggleDark, useDark } from "../dark";

export function Topbar({ page }: { page: PageId }) {
  const meta = PAGES.find((p) => p.id === page)!;
  const [copied, setCopied] = useState(false);
  const dark = useDark();

  const copy = async () => {
    await navigator.clipboard.writeText(location.origin + "/v1").catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <header className="flex items-center justify-between gap-3 border-b border-border bg-card px-8 py-4">
      <div className="flex min-w-0 items-center gap-3">
        <meta.icon className="size-4 shrink-0 text-foreground" />
        <div className="min-w-0">
          <h1 className="text-lg leading-tight font-medium tracking-[0.02em]">{meta.label}</h1>
          <p className="truncate text-xs text-muted-foreground">{meta.desc}</p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <span className="hidden rounded-full border border-border bg-card px-3.5 py-1.5 font-mono text-xs text-muted-foreground sm:inline">
          {location.origin}/v1
        </span>
        <Button
          variant="ghost"
          size="icon"
          onClick={toggleDark}
          aria-label="toggle dark mode"
          title={dark ? "switch to light mode" : "switch to dark mode"}
        >
          {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
        </Button>
        <Button variant="ghost" size="icon" onClick={copy} aria-label="copy proxy url" title="copy proxy url">
          {copied ? <Check className="size-4 text-green-600 dark:text-green-400" /> : <Copy className="size-4" />}
        </Button>
      </div>
    </header>
  );
}