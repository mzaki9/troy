import { useState } from "react";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { Skeleton } from "../ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { TopologyView } from "../topology-view";
import { ProviderIcon } from "../provider-icon";
import type { TopoData } from "../../topology";
import {
  barHex,
  fmt,
  lastUsed,
  rateClass,
  short,
  useApi,
} from "../api";
import type { LogRow, StatsData, StatRow } from "../api";

function EmptyState({ msg }: { msg: string }) {
  return <p className="py-10 text-center text-sm text-muted-foreground">{msg}</p>;
}

function ModelCode({ model }: { model: string }) {
  return (
    <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
      {model}
    </code>
  );
}

// ---- stat cards ----

function StatCard({
  label,
  value,
  sub,
  valueClass,
}: {
  label: string;
  value: string;
  sub?: string;
  valueClass?: string;
}) {
  return (
    <Card className="gap-1 px-4 py-3.5">
      <p className="font-mono text-[10px] tracking-widest text-muted-foreground uppercase">
        {label}
      </p>
      <p className={cn("truncate font-mono text-xl font-semibold tracking-tight tabular-nums", valueClass)}>
        {value}
      </p>
      {sub ? <p className="text-[10px] text-muted-foreground">{sub}</p> : null}
    </Card>
  );
}

function StatSkeletons() {
  return (
    <>
      {Array.from({ length: 5 }).map((_, i) => (
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
            <div className="h-2 overflow-hidden rounded-[3px]" style={{ background: barHex(pct) + "1c" }}>
              <div
                className="h-full rounded-[3px] transition-all"
                style={{ width: pct.toFixed(0) + "%", background: barHex(pct) }}
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
          <TableHead className="font-mono text-[10px] tracking-widest uppercase">time</TableHead>
          <TableHead className="font-mono text-[10px] tracking-widest uppercase">provider</TableHead>
          <TableHead className="font-mono text-[10px] tracking-widest uppercase">model</TableHead>
          <TableHead className="font-mono text-[10px] tracking-widest uppercase">status</TableHead>
          <TableHead className="font-mono text-[10px] tracking-widest uppercase text-right">ms</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {list.map((r, i) => (
          <TableRow key={i}>
            <TableCell className="font-mono text-xs text-muted-foreground">
              {new Date(Date.parse(r.ts)).toLocaleTimeString()}
            </TableCell>
            <TableCell>{r.provider}</TableCell>
            <TableCell>
              <ModelCode model={r.model} />
            </TableCell>
            <TableCell className={cn("font-mono text-xs", r.status === "200 OK" ? "text-emerald-400" : "text-red-400")}>
              {r.status}
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
          <TableHead className="font-mono text-[10px] tracking-widest uppercase">model</TableHead>
          <TableHead className="font-mono text-[10px] tracking-widest uppercase">provider</TableHead>
          <TableHead className="font-mono text-[10px] tracking-widest uppercase text-right">requests</TableHead>
          <TableHead className="font-mono text-[10px] tracking-widest uppercase text-right">ok</TableHead>
          <TableHead className="font-mono text-[10px] tracking-widest uppercase text-right">avg ms</TableHead>
          <TableHead className="font-mono text-[10px] tracking-widest uppercase">last used</TableHead>
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
            <TableCell className="text-right font-mono tabular-nums">{short(r.avg_ms)}</TableCell>
            <TableCell className="font-mono text-xs text-muted-foreground">{lastUsed(r.last ?? "")}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function PeriodPills() {
  const [period, setPeriod] = useState("24h");
  const pills = ["24h", "Today", "7D", "30D", "All"];
  return (
    <div className="inline-flex w-fit rounded-md border bg-muted/50 p-1">
      {pills.map((p) => (
        <button
          key={p}
          onClick={() => setPeriod(p)}
          className={cn(
            "rounded-[4px] px-3 py-1 font-mono text-xs transition-colors",
            period === p
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
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
  const stats = useApi<StatsData>("/api/stats", { interval: 3000 });
  const logs = useApi<LogRow[]>("/api/logs", { interval: 3000 });
  const topo = useApi<TopoData>("/api/topology?window=60", { interval: 2000 });

  const t = stats.data?.totals;
  const rate = t && t.requests ? (t.ok / t.requests) * 100 : undefined;
  const active = (topo.data?.activeCount ?? 0) > 0;

  return (
    <Tabs defaultValue="overview">
      <TabsList>
        <TabsTrigger value="overview">Overview</TabsTrigger>
        <TabsTrigger value="details">Details</TabsTrigger>
      </TabsList>

      <TabsContent value="overview" className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
          {!t ? (
            <StatSkeletons />
          ) : (
            <>
              <StatCard label="Total Requests" value={fmt.format(t.requests)} />
              <StatCard
                label="Success rate"
                value={t.requests ? rate!.toFixed(1) + "%" : "—"}
                sub={rate! < 100 && t.requests ? (rate! >= 95 ? "" : "below 95%") : ""}
                valueClass={t.requests ? rateClass(rate!) : ""}
              />
              <StatCard
                label="Failed"
                value={fmt.format(t.fail)}
                valueClass={t.fail > 0 ? "text-red-400" : ""}
              />
              <StatCard label="Avg latency" value={t.requests ? short(t.avg_ms) : "—"} />
              <StatCard label="p95 latency" value={t.requests ? short(t.p95_ms) : "—"} />
            </>
          )}
        </div>

        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
          <Card className="relative min-h-[380px]">
            <CardHeader className="flex-row items-center justify-between">
              <CardTitle>Topology</CardTitle>
              <Badge variant={active ? "default" : "secondary"}>
                {topo.data
                  ? active
                    ? `${topo.data.activeCount} active`
                    : "idle"
                  : "…"}
              </Badge>
            </CardHeader>
            <div className="absolute inset-x-0 bottom-0 top-14">
              <TopologyView data={topo.data} />
              <span className="pointer-events-none absolute right-3 bottom-2 text-[10px] text-muted-foreground/70">
                drag to pan · scroll to zoom · dbl-click to fit
              </span>
            </div>
          </Card>

          <Card>
            <CardHeader className="flex-row items-center justify-between">
              <CardTitle>Provider health</CardTitle>
              <Badge variant="secondary">
                {stats.data ? `${stats.data.byProvider.length} providers` : "—"}
              </Badge>
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

      <TabsContent value="details" className="space-y-4">
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
