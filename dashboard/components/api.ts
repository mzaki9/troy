import { useCallback, useEffect, useState } from "react";

export async function api<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(path, { headers: { "content-type": "application/json" }, ...opts });
  if (!res.ok) throw new Error(`${res.status} ${await res.text().catch(() => "")}`);
  return res.json() as Promise<T>;
}

export interface Connection {
  id: string;
  provider: string;
  api_key: string;
  name: string | null;
  base_url: string | null;
  priority: number;
  is_active: number;
}
export interface Combo {
  name: string;
  models: string[];
}
export interface SavedModel {
  spec: string;
  provider: string;
  model: string;
  created_at: string;
  thinking?: boolean;
}
export interface Settings {
  rtk_on: number;
  caveman_level: string;
  ponytail_level: string;
  strategy: string;
}
export interface StatRow {
  provider: string;
  model: string;
  requests: number;
  ok: number;
  avg_ms: number;
  last?: string;
}
export interface StatsData {
  totals: { requests: number; ok: number; fail: number; avg_ms: number; p95_ms: number };
  byProvider: { provider: string; n: number; ok: number; av: number }[];
  byModel: StatRow[];
}
export interface LogRow {
  ts: string;
  provider: string;
  model: string;
  status: string;
  latency_ms: number;
}
export interface ProviderCat {
  id: string;
  name?: string;
  custom: boolean;
  connected: number;
  baseUrl: string;
  auth: string;
  aliases: string[];
  placeholders: string[];
}
export interface CustomProvider {
  id: string;
  name?: string;
  baseUrl: string;
  auth: string;
}

/** Poll an API endpoint; refetch() forces an immediate reload. */
export function useApi<T>(path: string | null, opts: { interval?: number } = {}) {
  const [tick, setTick] = useState(0);
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<Error | undefined>(undefined);

  useEffect(() => {
    if (!path) return;
    let alive = true;
    let timer: ReturnType<typeof setInterval> | undefined;

    const load = () => {
      api<T>(path)
        .then((d) => {
          if (alive) {
            setData(d);
            setError(undefined);
          }
        })
        .catch((e: unknown) => {
          if (alive) setError(e instanceof Error ? e : new Error(String(e)));
        });
    };

    load();
    if (opts.interval) timer = setInterval(load, opts.interval);
    return () => {
      alive = false;
      if (timer) clearInterval(timer);
    };
  }, [path, opts.interval, tick]);

  const refetch = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, refetch };
}

export const fmt = new Intl.NumberFormat();

export const mask = (k: string) => (k.length > 14 ? k.slice(0, 4) + "…" + k.slice(-4) : "…");

export const short = (ms: number) => (ms >= 1000 ? (ms / 1000).toFixed(1) + "s" : ms + "ms");

export const lastUsed = (iso: string) =>
  iso ? new Date(Date.parse(iso)).toLocaleString() : "—";

export const rateClass = (r: number) =>
  r >= 95 ? "text-emerald-600" : r >= 70 ? "text-amber-600" : "text-red-600";

export const barHex = (r: number) => (r > 70 ? "#22c55e" : r >= 30 ? "#eab308" : "#ef4444");
