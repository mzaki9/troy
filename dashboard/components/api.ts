import { useCallback, useEffect, useState } from "react";

export async function api<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(path, { headers: { "content-type": "application/json" }, ...opts });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let detail = text;
    try {
      const j = JSON.parse(text) as { error?: string };
      if (typeof j?.error === "string" && j.error) detail = j.error;
    } catch {
      /* non-JSON body */
    }
    throw new Error(detail || String(res.status));
  }
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
  strategy: string;
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
  tokens_in?: number;
  tokens_out?: number;
}
export interface StatsData {
  totals: {
    requests: number;
    ok: number;
    fail: number;
    avg_ms: number;
    p95_ms: number;
    tokens_in: number;
    tokens_out: number;
  };
  byProvider: { provider: string; n: number; ok: number; av: number; tokens_in?: number; tokens_out?: number }[];
  byModel: StatRow[];
}
export interface DailyRow {
  day: string;
  models: { model: string; requests: number }[];
}
export interface DailyData {
  days: DailyRow[];
}
export interface LogRow {
  ts: string;
  provider: string;
  model: string;
  status: string;
  latency_ms: number;
  tokens?: Record<string, number>;
}
export interface ProviderCat {
  id: string;
  name?: string;
  custom: boolean;
  connected: number;
  /** chosen models for this provider (a chosen model implies a working key) */
  chosen: number;
  baseUrl: string;
  auth: string;
  aliases: string[];
  placeholders: string[];
}
export interface ApiKeyInfo {
  key: string;
  on: number;
}

/** Poll an API endpoint; refetch() forces an immediate reload. */
export function useApi<T>(path: string | null, opts: { interval?: number } = {}) {
  const [tick, setTick] = useState(0);
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<Error | undefined>(undefined);

  // biome-ignore lint/correctness/useExhaustiveDependencies: tick is the refetch trigger, intentionally not read inside the effect
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

export const mask = (k: string) => (k.length > 14 ? `${k.slice(0, 4)}…${k.slice(-4)}` : "…");

export const short = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`);

export const lastUsed = (iso: string) => (iso ? new Date(Date.parse(iso)).toLocaleString() : "—");

export const rateClass = (r: number) =>
  r >= 95
    ? "text-emerald-600 dark:text-emerald-400"
    : r >= 70
      ? "text-amber-600 dark:text-amber-400"
      : "text-red-600 dark:text-red-400";

export const barHex = (r: number) => (r > 70 ? "#22c55e" : r >= 30 ? "#eab308" : "#ef4444");
