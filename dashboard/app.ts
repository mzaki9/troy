import { QueryClient, QueryObserver } from "@tanstack/query-core";

const client = new QueryClient({ defaultOptions: { queries: { staleTime: 3000 } } });
const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

async function api<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(path, { headers: { "content-type": "application/json" }, ...opts });
  if (!res.ok) throw new Error(`${res.status} ${await res.text().catch(() => "")}`);
  return res.json() as Promise<T>;
}

interface Connection {
  id: string;
  provider: string;
  api_key: string;
  base_url: string | null;
  priority: number;
  is_active: number;
}
interface Combo {
  name: string;
  models: string[];
}
interface Settings {
  rtk_on: number;
  caveman_level: string;
  ponytail_level: string;
  strategy: string;
}
interface LogRow {
  ts: string;
  provider: string;
  model: string;
  status: string;
  latency_ms: number;
}

function query<T>(key: string[], fetcher: () => Promise<T>, opts: { interval?: number } = {}) {
  const observer = new QueryObserver(client, { queryKey: key, queryFn: fetcher, refetchInterval: opts.interval });
  return {
    subscribe(fn: (data?: T, error?: Error) => void): void {
      observer.subscribe((result) => {
        if (result.isSuccess) fn(result.data as T);
        else if (result.isError) fn(undefined, result.error as Error);
      });
      client.invalidateQueries({ queryKey: key });
    },
  };
}

function el(tag: string): HTMLElement;
function el(tag: string, text: string): HTMLElement;
function el(tag: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}

const mask = (k: string) => (k.length > 14 ? k.slice(0, 4) + "…" + k.slice(-4) : "…");
const invalidate = (key: string[]) => client.invalidateQueries({ queryKey: key });

function start(): void {
  const tbody = $("#connTable tbody");

  query<Connection[]>(["connections"], () => api("/api/connections")).subscribe((data) => {
    tbody.replaceChildren();
    for (const c of data ?? []) {
      const tr = el("tr");
      tr.append(el("td", c.provider), el("td", String(c.priority)), el("td", mask(c.api_key)), el("td", c.base_url ?? ""), el("td"));
      const last = tr.querySelector("td:last-child") as HTMLElement;
      const t = el("button", c.is_active ? "on" : "off") as HTMLButtonElement;
      t.onclick = async () => {
        await api(`/api/connections/${c.id}`, { method: "PUT", body: JSON.stringify({ is_active: c.is_active ? 0 : 1 }) });
        invalidate(["connections"]);
      };
      const d = el("button", "del") as HTMLButtonElement;
      d.onclick = async () => {
        await api(`/api/connections/${c.id}`, { method: "DELETE" });
        invalidate(["connections"]);
      };
      last.append(t, " ", d);
      tbody.append(tr);
    }
  });

  const connForm = document.createElement("form");
  const sel = document.createElement("select") as HTMLSelectElement;
  for (const p of ["openai", "deepseek", "groq", "openrouter", "glm-cn", "xai", "mistral", "cerebras", "together", "nvidia"]) sel.append(new Option(p, p));
  const key = document.createElement("input") as HTMLInputElement;
  key.placeholder = "api key";
  const prio = document.createElement("input") as HTMLInputElement;
  prio.type = "number";
  prio.value = "0";
  const addB = document.createElement("button") as HTMLButtonElement;
  addB.type = "submit";
  addB.textContent = "add";
  connForm.append(sel, key, prio, addB);
  connForm.onsubmit = async (e) => {
    e.preventDefault();
    if (!key.value) return;
    await api("/api/connections", {
      method: "POST",
      body: JSON.stringify({ provider: sel.value, api_key: key.value, priority: Number(prio.value || 0) }),
    });
    key.value = "";
    invalidate(["connections"]);
  };
  tbody.parentElement!.append(connForm);

  query<Combo[]>(["combos"], () => api("/api/combos")).subscribe((data) => {
    const list = $("#comboList");
    list.replaceChildren();
    for (const c of data ?? []) {
      const row = el("div");
      const d = el("button", "del") as HTMLButtonElement;
      d.onclick = async () => {
        await api(`/api/combos/${encodeURIComponent(c.name)}`, { method: "DELETE" });
        invalidate(["combos"]);
      };
      row.append(el("span", c.name), " → ", el("span", c.models.join(" → ")), " ", d);
      list.append(row);
    }
    const form = document.createElement("form") as HTMLFormElement;
    const name = document.createElement("input") as HTMLInputElement;
    name.placeholder = "combo name";
    const models = document.createElement("input") as HTMLInputElement;
    models.placeholder = "openai/gpt-4o-mini deepseek/deepseek-chat";
    const add = document.createElement("button") as HTMLButtonElement;
    add.type = "submit";
    add.textContent = "add";
    form.append(name, models, add);
    form.onsubmit = async (e) => {
      e.preventDefault();
      const chain = models.value.split(/\s+/).filter(Boolean);
      if (name.value && chain.length) {
        await api("/api/combos", { method: "POST", body: JSON.stringify({ name: name.value, models: chain }) });
        models.value = "";
        invalidate(["combos"]);
      }
    };
    list.append(form);
  });

  query<Settings>(["settings"], () => api("/api/settings")).subscribe((data) => {
    if (!data) return;
    const box = $("#settingsBox");
    box.replaceChildren();
    const onoff = document.createElement("select") as HTMLSelectElement;
    onoff.append(new Option("off", "off"), new Option("on", "on"));
    onoff.value = data.rtk_on ? "on" : "off";
    const levels = ["off", "lite", "full", "ultra", "wenyan-lite", "wenyan", "wenyan-ultra"];
    const cav = document.createElement("select") as HTMLSelectElement;
    for (const l of levels) cav.append(new Option(l, l));
    cav.value = data.caveman_level;
    const pony = document.createElement("select") as HTMLSelectElement;
    for (const l of ["off", "lite", "full", "ultra"]) pony.append(new Option(l, l));
    pony.value = data.ponytail_level;
    const strat = document.createElement("select") as HTMLSelectElement;
    strat.append(new Option("fill-first", "fill-first"), new Option("round-robin", "round-robin"));
    strat.value = data.strategy;
    const save = document.createElement("button") as HTMLButtonElement;
    save.textContent = "save";
    save.onclick = async () => {
      await api("/api/settings", {
        method: "PUT",
        body: JSON.stringify({ rtk_on: onoff.value === "on" ? 1 : 0, caveman_level: cav.value, ponytail_level: pony.value, strategy: strat.value }),
      });
      invalidate(["settings"]);
    };
    box.append(el("span", "rtk "), onoff, el("span", "  caveman "), cav, el("span", "  ponytail "), pony, el("span", "  strategy "), strat, el("span", "  "), save);
  });

  query<LogRow[]>(["logs"], () => api("/api/logs"), { interval: 5000 }).subscribe((data) => {
    const body = $("#logBody");
    body.replaceChildren();
    for (const row of data ?? []) {
      const tr = el("tr");
      const status = el("td", row.status) as HTMLElement;
      status.style.color = row.status === "200 OK" ? "#4ade80" : "#f87171";
      tr.append(el("td", new Date(Date.parse(row.ts)).toLocaleTimeString()), el("td", row.provider), el("td", row.model), status, el("td", String(row.latency_ms)));
      body.append(tr);
    }
  });
}

$("#proxyHint").textContent = `proxy: ${location.origin}/v1`;
start();