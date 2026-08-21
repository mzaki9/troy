import { useEffect, useRef, useState } from "react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { cn } from "../../lib/utils";
import type { DailyData, LogRow, StatRow, StatsData } from "../api";
import { barHex, fmt, lastUsed, rateClass, short, useApi } from "../api";
import { ProviderIcon, providerColor } from "../provider-icon";
import { Badge } from "../ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { type ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from "../ui/chart";
import { Skeleton } from "../ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";

function EmptyState({ msg }: { msg: string }) {
  return <p className="py-10 text-center text-sm text-muted-foreground">{msg}</p>;
}

/** compact token counts: 940 → "940", 12_300 → "12.3k", 5_600_000 → "5.6M" */
function tok(n: number | undefined): string {
  if (!n) return "0";
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

function ModelCode({ model }: { model: string }) {
  return <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">{model}</code>;
}

// ---- stat cards ----

function StatCard({
  label,
  value,
  sub,
  subClass,
  valueClass,
  title,
}: {
  label: string;
  value: string;
  sub?: string;
  subClass?: string;
  valueClass?: string;
  title?: string;
}) {
  return (
    <Card className="gap-1 px-5 py-4">
      <p className="text-[11px] tracking-[0.08em] text-muted-foreground uppercase">{label}</p>
      <p className={cn("truncate text-3xl font-light tracking-[0.02em] tabular-nums", valueClass)} title={title}>
        {value}
      </p>
      {sub ? <p className={cn("text-[10px] text-muted-foreground tabular-nums", subClass)}>{sub}</p> : null}
    </Card>
  );
}

function StatSkeletons() {
  return (
    <>
      {Array.from({ length: 4 }).map((_, i) => (
        <Card key={i} className="gap-2 px-5 py-4">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-7 w-24" />
        </Card>
      ))}
    </>
  );
}

// ---- provider health bars ----

function ProviderBars({ byProvider }: { byProvider: StatsData["byProvider"] }) {
  if (byProvider.length === 0) {
    return <EmptyState msg="No traffic yet — send a request on the proxy." />;
  }
  return (
    <div className="space-y-3.5">
      {byProvider.slice(0, 8).map((p) => {
        const pct = p.n ? (p.ok / p.n) * 100 : 0;
        return (
          <div key={p.provider} className="space-y-1">
            <div className="flex items-center justify-between text-sm">
              <span className="flex min-w-0 items-center gap-2 font-medium">
                <ProviderIcon id={p.provider} className="size-5.5 rounded-md" />
                <span className="truncate">{p.provider}</span>
              </span>
              <span className={cn("shrink-0 font-medium", rateClass(pct))}>{pct.toFixed(0)}%</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full" style={{ background: `${barHex(pct)}26` }}>
              <div
                className="h-full rounded-full transition-all"
                style={{ width: `${pct.toFixed(0)}%`, background: barHex(pct) }}
              />
            </div>
            <p className="text-[11px] text-muted-foreground">
              {fmt.format(p.n)} requests · {fmt.format(p.ok)} ok
            </p>
          </div>
        );
      })}
    </div>
  );
}

// ---- daily stacked bar chart (7d, per model) ----

/** "2026-08-13" → "Wed 13" using LOCAL date parts (Date(iso) would shift across tz). */
function fmtDay(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { weekday: "short", day: "numeric" });
}

function fmtDayFull(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

/** Stacked request bars per day; segments + legend = model names (top N + "other"). */
function DailyChart({ data }: { data?: DailyData }) {
  if (!data) {
    return (
      <div className="flex h-[320px] items-end gap-1.5 px-1">
        {Array.from({ length: 18 }).map((_, i) => (
          <Skeleton key={i} className="flex-1 rounded-t-sm" style={{ height: `${20 + ((i * 37) % 80)}%` }} />
        ))}
      </div>
    );
  }

  const totals = new Map<string, number>();
  for (const d of data.days) {
    for (const m of d.models) totals.set(m.model, (totals.get(m.model) ?? 0) + m.requests);
  }
  if (totals.size === 0) return <EmptyState msg="No traffic in the last 7 days — send a request on the proxy." />;

  // top models by 7d volume, rest folded into "other" (reserve the name to avoid key collision)
  const top = [...totals.entries()]
    .filter(([m]) => m !== "other")
    .sort((a, b) => b[1] - a[1])
    .slice(0, 9)
    .map(([m]) => m);
  const otherN = totals.size > top.length;
  const keys = otherN ? [...top, "other"] : top;
  const rows = data.days.map((d) => {
    const row: Record<string, string | number> = { day: fmtDay(d.day), __full: d.day };
    for (const k of keys) row[k] = 0;
    for (const m of d.models) {
      const k = top.includes(m.model) ? m.model : "other";
      row[k] = (row[k] as number) + m.requests;
    }
    return row;
  });

  const config: ChartConfig = {};
  for (const m of top) config[m] = { label: m, color: providerColor(m) };
  if (otherN) config.other = { label: "other", color: "#71717a" };

  return (
    <div>
      <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1.5 pb-3">
        {keys.map((k) => (
          <span
            key={k}
            className="flex max-w-[210px] items-center gap-1.5 text-[11px] text-muted-foreground"
            title={config[k].label}
          >
            <span className="size-2 shrink-0 rounded-[2px]" style={{ backgroundColor: config[k].color }} />
            <span className="truncate">{config[k].label}</span>
          </span>
        ))}
      </div>
      <ChartContainer config={config} className="h-[320px]">
        <BarChart data={rows} margin={{ top: 4, right: 0, left: 0, bottom: 0 }}>
          <CartesianGrid vertical={false} strokeDasharray="3 3" />
          <XAxis dataKey="day" tickLine={false} axisLine={false} tickMargin={10} />
          <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={30} />
          <ChartTooltip
            cursor={{ fill: "hsl(var(--muted) / 0.35)" }}
            content={<ChartTooltipContent labelKey="__full" labelFormatter={(v) => fmtDayFull(String(v ?? ""))} />}
          />
          {keys.map((k, i) => (
            <Bar
              key={k}
              dataKey={k}
              stackId="a"
              fill={config[k]?.color ?? "#a1a1aa"}
              radius={i === keys.length - 1 ? [3, 3, 0, 0] : [0, 0, 0, 0]}
            />
          ))}
        </BarChart>
      </ChartContainer>
    </div>
  );
}

// ---- request tables ----

function RequestsTable({ rows, limit }: { rows?: LogRow[]; limit: number }) {
  if (!rows) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-8 w-full" />
        ))}
      </div>
    );
  }
  const list = rows.slice(0, limit);
  if (list.length === 0) return <EmptyState msg="No usage recorded yet." />;
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className="text-[11px] font-normal tracking-[0.08em] uppercase">time</TableHead>
          <TableHead className="text-[11px] font-normal tracking-[0.08em] uppercase">provider</TableHead>
          <TableHead className="text-[11px] font-normal tracking-[0.08em] uppercase">model</TableHead>
          <TableHead className="text-[11px] font-normal tracking-[0.08em] uppercase">status</TableHead>
          <TableHead className="text-[11px] font-normal tracking-[0.08em] uppercase text-right">tokens</TableHead>
          <TableHead className="text-[11px] font-normal tracking-[0.08em] uppercase text-right">ms</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {list.map((r, i) => (
          <TableRow key={i}>
            <TableCell className="text-muted-foreground tabular-nums">
              {new Date(Date.parse(r.ts)).toLocaleTimeString()}
            </TableCell>
            <TableCell>{r.provider}</TableCell>
            <TableCell>
              <ModelCode model={r.model} />
            </TableCell>
            <TableCell
              className={cn(
                "font-mono text-xs",
                r.status === "200 OK" ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400",
              )}
            >
              {r.status}
            </TableCell>
            <TableCell className="text-right font-mono text-xs tabular-nums text-muted-foreground">
              {r.tokens ? `${tok(r.tokens.prompt_tokens)} / ${tok(r.tokens.completion_tokens)}` : "—"}
              {(r.rtk_saved ?? 0) > 0 && (
                <Badge
                  variant="secondary"
                  className="ml-1.5 font-mono text-[10px]"
                  title={`RTK compressed ~${(r.rtk_seen ?? 0).toLocaleString()} chars of tool output`}
                >
                  rtk −{Math.round((r.rtk_saved! / (r.rtk_seen || 1)) * 100)}%
                </Badge>
              )}
            </TableCell>
            <TableCell className="text-right font-mono tabular-nums">{r.latency_ms}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function ModelTable({ rows }: { rows?: StatRow[] }) {
  if (!rows) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-8 w-full" />
        ))}
      </div>
    );
  }
  if (rows.length === 0) return <EmptyState msg="No usage recorded yet." />;
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className="text-[11px] font-normal tracking-[0.08em] uppercase">model</TableHead>
          <TableHead className="text-[11px] font-normal tracking-[0.08em] uppercase">provider</TableHead>
          <TableHead className="text-[11px] font-normal tracking-[0.08em] uppercase text-right">requests</TableHead>
          <TableHead className="text-[11px] font-normal tracking-[0.08em] uppercase text-right">ok</TableHead>
          <TableHead className="text-[11px] font-normal tracking-[0.08em] uppercase text-right">tokens</TableHead>
          <TableHead className="text-[11px] font-normal tracking-[0.08em] uppercase text-right">avg ms</TableHead>
          <TableHead className="text-[11px] font-normal tracking-[0.08em] uppercase">last used</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.slice(0, 40).map((r, i) => (
          <TableRow key={i}>
            <TableCell>
              <ModelCode model={r.model} />
            </TableCell>
            <TableCell>{r.provider}</TableCell>
            <TableCell className="text-right font-mono tabular-nums">{fmt.format(r.requests)}</TableCell>
            <TableCell className="text-right font-mono tabular-nums">{fmt.format(r.ok)}</TableCell>
            <TableCell className="text-right font-mono text-xs tabular-nums text-muted-foreground">
              {r.tokens_in || r.tokens_out ? `${tok(r.tokens_in)} / ${tok(r.tokens_out)}` : "—"}
            </TableCell>
            <TableCell className="text-right font-mono tabular-nums">{short(r.avg_ms)}</TableCell>
            <TableCell className="text-muted-foreground">{lastUsed(r.last ?? "")}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function PeriodPills() {
  const [period, setPeriod] = useState("24h");
  const wrapRef = useRef<HTMLDivElement>(null);
  const btnRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const [ind, setInd] = useState<{ left: number; width: number } | null>(null);
  const pills = ["24h", "Today", "7D", "30D", "All"];

  useEffect(() => {
    const btn = btnRefs.current[period];
    if (!btn) return;
    setInd({ left: btn.offsetLeft, width: btn.offsetWidth });
  }, [period]);

  return (
    <div ref={wrapRef} className="relative inline-flex w-fit rounded-full border bg-card p-1">
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute rounded-full bg-primary transition-[left,width] duration-[120ms] ease-out motion-reduce:transition-none",
          ind ? "opacity-100" : "opacity-0",
        )}
        style={ind ? { left: ind.left, top: 4, width: ind.width, height: "calc(100% - 8px)" } : undefined}
      />
      {pills.map((p) => (
        <button
          key={p}
          type="button"
          ref={(el) => {
            btnRefs.current[p] = el;
          }}
          onClick={() => setPeriod(p)}
          className={cn(
            "relative rounded-full px-4 py-1.5 text-xs font-medium transition-colors",
            period === p ? "text-primary-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {p}
        </button>
      ))}
    </div>
  );
}

// ---- page ----

export function UsagePage() {
  const stats = useApi<StatsData>("/api/stats", { interval: 10000 });
  const daily = useApi<DailyData>("/api/stats/daily?days=7", { interval: 15000 });
  const logs = useApi<LogRow[]>("/api/logs", { interval: 5000 });

  const t = stats.data?.totals;
  const rate = t?.requests ? (t.ok / t.requests) * 100 : undefined;

  return (
    <Tabs defaultValue="overview">
      <TabsList>
        <TabsTrigger value="overview">Overview</TabsTrigger>
        <TabsTrigger value="details">Details</TabsTrigger>
      </TabsList>

      <TabsContent value="overview" className="view-switch space-y-4">
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {!t ? (
            <StatSkeletons />
          ) : (
            <>
              <StatCard label="Total Requests" value={fmt.format(t.requests)} />
              <StatCard
                label="Success rate"
                value={rate !== undefined ? `${rate.toFixed(1)}%` : "—"}
                sub={t.requests && rate !== undefined && rate < 100 ? `${fmt.format(t.fail)} failed` : ""}
                subClass={t.fail > 0 ? "text-red-600 dark:text-red-400" : undefined}
                valueClass={rate !== undefined ? rateClass(rate) : ""}
              />
              <StatCard
                label="Latency"
                value={t.requests ? short(t.avg_ms) : "—"}
                sub={t.requests ? `p95 ${short(t.p95_ms)}` : ""}
              />
              {(() => {
                const tin = t.tokens_in ?? 0;
                const tout = t.tokens_out ?? 0;
                return (
                  <StatCard
                    label="Tokens"
                    value={tok(tin + tout)}
                    sub={`↑ ${tok(tin)} in · ↓ ${tok(tout)} out`}
                    title={`${tin.toLocaleString()} in / ${tout.toLocaleString()} out`}
                  />
                );
              })()}
              {(() => {
                const saved = t.rtk_saved ?? 0;
                const seen = t.rtk_seen ?? 0;
                if (seen <= 0) return null; // RTK off or nothing compressed — no zero-clutter card
                const pct = Math.round((saved / seen) * 100);
                const hit = t.requests ? Math.round(((t.rtk_hits ?? 0) / t.requests) * 100) : 0;
                return (
                  <StatCard
                    label="RTK saved"
                    value={`~${tok(Math.round(saved / 4))}`}
                    sub={`${pct}% of tool output · ${hit}% of reqs`}
                    title={`est. tokens — ${saved.toLocaleString()} of ${seen.toLocaleString()} chars compressed away`}
                  />
                );
              })()}
            </>
          )}
        </div>

        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
          <Card className="min-h-[380px]">
            <CardHeader className="flex-row items-center justify-between">
              <CardTitle>Requests per day</CardTitle>
              <Badge variant="secondary">last 7 days · stacked by model</Badge>
            </CardHeader>
            <CardContent>
              <DailyChart data={daily.data} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex-row items-center justify-between">
              <CardTitle>Provider health</CardTitle>
              <Badge variant="secondary">{stats.data ? `${stats.data.byProvider.length} providers` : "—"}</Badge>
            </CardHeader>
            <CardContent>
              {stats.data ? (
                <ProviderBars byProvider={stats.data.byProvider} />
              ) : (
                <div className="space-y-3.5">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <div key={i} className="space-y-1.5">
                      <Skeleton className="h-4 w-2/3" />
                      <Skeleton className="h-2 w-full" />
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Recent requests</CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <RequestsTable rows={logs.data} limit={20} />
          </CardContent>
        </Card>
      </TabsContent>

      <TabsContent value="details" className="view-switch space-y-4">
        <PeriodPills />

        <Card>
          <CardHeader>
            <CardTitle>Usage by model</CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <ModelTable rows={stats.data?.byModel} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>History</CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <RequestsTable rows={logs.data} limit={100} />
          </CardContent>
        </Card>
      </TabsContent>
    </Tabs>
  );
}
