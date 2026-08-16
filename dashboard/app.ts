import { QueryClient, QueryObserver } from "@tanstack/query-core";
import { createTopology, providerColor, type TopoProvider } from "./topology";

const client = new QueryClient({ defaultOptions: { queries: { staleTime: 3000 } } });
const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

async function api<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(path, { headers: { "content-type": "application/json" }, ...opts });
  if (!res.ok) throw new Error(`${res.status} ${await res.text().catch(() => "")}`);
  return res.json() as Promise<T>;
}

function query<T>(key: string[], fetcher: () => Promise<T>, opts: { interval?: number } = {}) {
  const observer = new QueryObserver(client, { queryKey: key, queryFn: fetcher, refetchInterval: opts.interval });
  return {
    subscribe(fn: (data?: T) => void): void {
      observer.subscribe((result) => {
        if (result.isSuccess) fn(result.data as T);
      });
    },
  };
}

function el(tag: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}

function badge(cls: string, text: string): HTMLElement {
  const b = el("span", text);
  b.className = `badge ${cls}`;
  return b;
}

function dot(color: string): HTMLElement {
  const d = el("span");
  d.className = `badge-dot ${color}`;
  return d;
}

function codeCell(model: string): HTMLElement {
  const td = el("td");
  const code = el("code", model);
  code.className = "model";
  td.append(code);
  return td;
}

function statusCell(status: string): HTMLElement {
  const td = el("td", status);
  td.className = status === "200 OK" ? "status-ok" : "status-err";
  return td;
}

function numCell(text: string): HTMLElement {
  const td = el("td", text);
  td.className = "num";
  return td;
}

const mask = (k: string) => (k.length > 14 ? k.slice(0, 4) + "…" + k.slice(-4) : "…");
const invalidate = (key: string[]) => client.invalidateQueries({ queryKey: key });
const fmt = new Intl.NumberFormat();
const short = (ms: number) => (ms >= 1000 ? (ms / 1000).toFixed(1) + "s" : ms + "ms");
const lastUsed = (iso: string) => (iso ? new Date(Date.parse(iso)).toLocaleString() : "—");

interface Connection { id: string; provider: string; api_key: string; base_url: string | null; priority: number; is_active: number }
interface Combo { name: string; models: string[] }
interface Settings { rtk_on: number; caveman_level: string; ponytail_level: string; strategy: string }
interface StatRow { provider: string; model: string; requests: number; ok: number; avg_ms: number; last?: string }
interface StatsData { totals: { requests: number; ok: number; fail: number; avg_ms: number; p95_ms: number }; byProvider: { provider: string; n: number; ok: number; av: number }[]; byModel: StatRow[] }
interface LogRow { ts: string; provider: string; model: string; status: string; latency_ms: number }
interface ProviderCat { id: string; connected: number }
interface TopoData { activeCount: number; providers: TopoProvider[] }

const PAGES: Record<string, [string, string]> = {
  usage: ["Usage", "requests, providers, latency"],
  providers: ["Providers", "OpenAI-compatible catalog + connections"],
  combos: ["Combos", "ordered fallback chains"],
  settings: ["Settings", "routing & token savers"],
};

function showPage(page: string) {
  for (const b of Array.from(document.querySelectorAll<HTMLButtonElement>(".nav-item"))) b.classList.toggle("active", b.dataset.page === page);
  for (const sec of Array.from(document.querySelectorAll<HTMLElement>(".page"))) sec.classList.toggle("active", sec.id === `page-${page}`);
  $("#pageIcon").textContent = page === "usage" ? "data_usage" : page === "providers" ? "hub" : page === "combos" ? "layers" : "tune";
  $("#pageTitle").textContent = PAGES[page][0];
  $("#pageDesc").textContent = PAGES[page][1];
}

const rateColor = (r: number) => (r >= 95 ? "var(--success)" : r >= 70 ? "var(--warning)" : "var(--danger)");
const barHex = (r: number) => (r > 70 ? "#22c55e" : r >= 30 ? "#eab308" : "#ef4444");

// ---- usage overview ----

function renderStats(s: StatsData) {
  const grid = $("#statGrid");
  grid.replaceChildren();
  const t = s.totals;
  const rate = t.requests ? (t.ok / t.requests) * 100 : 0;
  const cards: [string, string, string?][] = [
    ["Total Requests", fmt.format(t.requests), ""],
    ["Success rate", t.requests ? rate.toFixed(1) + "%" : "—", rate < 100 && t.requests ? (rate >= 95 ? "" : "below 95%") : ""],
    ["Failed", fmt.format(t.fail), ""],
    ["Avg latency", t.requests ? short(t.avg_ms) : "—", ""],
    ["p95 latency", t.requests ? short(t.p95_ms) : "—", ""],
  ];
  for (const [label, value, sub] of cards) {
    const card = el("div");
    card.className = "card stat";
    card.append(el("span", label).setClass("stat-label"));
    const v = el("div", value);
    v.className = "stat-value";
    if (label === "Failed" && t.fail > 0) v.style.color = "var(--danger)";
    if (label === "Success rate" && t.requests) v.style.color = rateColor(rate);
    card.append(v);
    if (sub) card.append(el("span", sub).setClass("stat-sub"));
    grid.append(card);
  }
}

function renderProviderBars(s: StatsData) {
  const box = $("#providerBars");
  box.replaceChildren();
  const list = s.byProvider.slice(0, 8);
  $("#provHealthBadge").replaceChildren(badge("badge-default", `${list.length} providers`));
  if (list.length === 0) {
    box.append(el("div", "No traffic yet — send a request on the proxy.").setClass("hint"));
    return;
  }
  for (const p of list) {
    const pct = p.n ? (p.ok / p.n) * 100 : 0;
    const head = el("div");
    head.className = "bar-head";
    const name = el("span");
    name.className = "bar-name";
    const c = el("span", p.provider.slice(0, 2).toUpperCase());
    c.style.cssText = `width:22px;height:22px;border-radius:6px;display:inline-flex;align-items:center;justify-content:center;font-weight:700;font-size:10px;background:${providerColor(p.provider)}26;color:${providerColor(p.provider)}`;
    name.append(c, el("span", p.provider));
    const right = el("span", pct.toFixed(0) + "%");
    right.style.color = rateColor(pct);
    head.append(name, right);
    const track = el("div");
    track.className = "bar-track";
    track.style.background = `${barHex(pct)}1c`;
    const fill = el("div");
    fill.style.width = pct.toFixed(0) + "%";
    fill.style.background = barHex(pct);
    track.append(fill);
    const meta = el("div", `${fmt.format(p.n)} requests · ${fmt.format(p.ok)} ok`);
    meta.className = "bar-meta";
    box.append(head, track, meta);
  }
}

function logRow(r: LogRow): HTMLElement {
  const tr = el("tr");
  tr.append(el("td", new Date(Date.parse(r.ts)).toLocaleTimeString()), el("td", r.provider), codeCell(r.model), statusCell(r.status), numCell(String(r.latency_ms)));
  return tr;
}

function emptyRow(colspan: number, msg: string): HTMLElement {
  const tr = el("tr");
  const td = document.createElement("td") as HTMLTableCellElement;
  td.textContent = msg;
  td.colSpan = colspan;
  td.className = "empty";
  tr.append(td);
  return tr;
}

function renderRecent(rows: LogRow[]) {
  const body = $("#recentBody");
  body.replaceChildren();
  if (rows.length === 0) body.append(emptyRow(5, "No usage recorded yet."));
  else for (const r of rows.slice(0, 20)) body.append(logRow(r));
}

// ---- usage details ----

function renderModelTable(rows: StatRow[]) {
  const body = $("#modelBody");
  body.replaceChildren();
  if (rows.length === 0) body.append(emptyRow(6, "No usage recorded yet."));
  else {
    for (const r of rows.slice(0, 40)) {
      const tr = el("tr");
      tr.append(codeCell(r.model), el("td", r.provider), numCell(fmt.format(r.requests)), numCell(fmt.format(r.ok)), numCell(short(r.avg_ms)), el("td", lastUsed(r.last ?? "")));
      body.append(tr);
    }
  }
}

function renderHistory(rows: LogRow[]) {
  const body = $("#historyBody");
  body.replaceChildren();
  if (rows.length === 0) body.append(emptyRow(5, "No usage recorded yet."));
  else for (const r of rows.slice(0, 100)) body.append(logRow(r));
}

// ---- providers ----

function renderProviders(catalog: ProviderCat[]) {
  const grid = $("#provGrid");
  grid.replaceChildren();
  $("#provCountBadge").replaceChildren(badge("badge-default", `${catalog.length} registered`));
  for (const p of catalog) {
    const card = el("div");
    card.className = "provider-card" + (p.connected ? " connected" : "");
    card.title = p.id;
    const left = el("div");
    left.className = "prov-left";
    const tile = el("span", p.id.slice(0, 2).toUpperCase());
    tile.style.cssText = `background:${providerColor(p.id)}26;color:${providerColor(p.id)}`;
    tile.classList.add("prov-icon-tile");
    const sub = el("div");
    sub.className = "prov-sub";
    sub.append(p.connected ? dot("dot-green") : dot("dot-gray"), el("span", p.connected ? `${p.connected} connected` : "no key"));
    const title = el("div");
    title.className = "prov-name";
    title.textContent = p.id;
    title.style.marginLeft = "8px";
    left.append(tile, title);
    card.append(left);
    grid.append(card);
  }
}

function renderConnections(list: Connection[]) {
  const rows = $("#connList");
  rows.replaceChildren();
  $("#connCountBadge").replaceChildren(badge("badge-success", `${list.filter((c) => c.is_active).length} connected`));
  if (list.length === 0) {
    rows.append(el("div", "No connections yet — add a provider key above.").setClass("hint"));
    return;
  }
  for (const c of list) {
    const row = el("div");
    row.className = "row";
    const left = el("div");
    left.className = "row-left";
    const name = el("span", c.provider);
    name.className = "row-title";
    left.append(name, el("span", `#${c.priority}`).setClass("key-mono"), el("span", mask(c.api_key)).setClass("key-mono"));
    if (c.base_url) left.append(el("span", c.base_url).setClass("row-sub"));
    const right = el("div");
    right.className = "row-right";
    const toggle = el("button");
    toggle.className = "toggle" + (c.is_active ? " on" : "");
    toggle.setAttribute("role", "switch");
    toggle.setAttribute("aria-checked", String(c.is_active === 1));
    toggle.append(el("span").setClass("toggle-thumb"));
    toggle.onclick = async () => {
      await api(`/api/connections/${c.id}`, { method: "PUT", body: JSON.stringify({ is_active: c.is_active ? 0 : 1 }) });
      invalidate(["connections"]);
    };
    const del = el("button", "delete");
    del.className = "btn btn-ghost btn-sm";
    del.onclick = async () => {
      if (!confirm(`Remove ${c.provider} key?`)) return;
      await api(`/api/connections/${c.id}`, { method: "DELETE" });
      invalidate(["connections", "providers"]);
    };
    right.append(toggle, del);
    row.append(left, right);
    rows.append(row);
  }
}

// ---- combos ----

function renderCombos(list: Combo[]) {
  const rows = $("#comboList");
  rows.replaceChildren();
  if (list.length === 0) rows.append(el("div", "No combos yet — group providers into a fallback chain.").setClass("hint"));
  for (const c of list) {
    const row = el("div");
    row.className = "row";
    const left = el("div");
    left.className = "row-left";
    const chain = el("div");
    chain.className = "combo-chain";
    c.models.forEach((m, i) => {
      if (i > 0) chain.append(el("span", "→").setClass("chain-arrow"));
      chain.append(el("span", m).setClass("combo-chip"));
    });
    left.append(el("span", c.name).setClass("row-title").styleSet("width:120px"), chain);
    const del = el("button", "delete");
    del.className = "btn btn-ghost btn-sm";
    del.onclick = async () => {
      await api(`/api/combos/${encodeURIComponent(c.name)}`, { method: "DELETE" });
      invalidate(["combos"]);
    };
    const right = el("div");
    right.className = "row-right";
    right.append(del);
    row.append(left, right);
    rows.append(row);
  }
}

// ---- settings ----

function renderSettings(s: Settings, markDirty: () => void) {
  const rtk = $("#rtkToggle");
  rtk.classList.toggle("on", s.rtk_on === 1);
  rtk.setAttribute("aria-checked", String(s.rtk_on === 1));
  const fill = (id: string, levels: string[], cur: string) => {
    const sel = $(`#${id}`) as HTMLSelectElement;
    sel.replaceChildren();
    for (const l of levels) sel.append(new Option(l, l));
    sel.value = cur;
  };
  fill("cavSel", ["off", "lite", "full", "ultra", "wenyan-lite", "wenyan", "wenyan-ultra"], s.caveman_level);
  fill("ponySel", ["off", "lite", "full", "ultra"], s.ponytail_level);
  ($("#strategySel") as HTMLSelectElement).value = s.strategy;
  rtk.onclick = () => {
    rtk.classList.toggle("on");
    rtk.setAttribute("aria-checked", String(rtk.classList.contains("on")));
    markDirty();
  };
  ($("#cavSel") as HTMLSelectElement).onchange = markDirty;
  ($("#ponySel") as HTMLSelectElement).onchange = markDirty;
  ($("#strategySel") as HTMLSelectElement).onchange = markDirty;
}

// ---- Element helpers ----

declare global {
  interface HTMLElement {
    setClass(c: string): HTMLElement;
    styleSet(css: string): HTMLElement;
  }
}
Object.assign(HTMLElement.prototype, {
  setClass(this: HTMLElement, c: string) {
    this.classList.add(c);
    return this;
  },
  styleSet(this: HTMLElement, css: string) {
    this.style.cssText = css;
    return this;
  },
});

// ---- boot ----

function boot() {
  $("#proxyPill").textContent = location.origin + "/v1";
  $("#proxyHint").textContent = "proxy " + location.origin + "/v1";

  for (const b of Array.from(document.querySelectorAll<HTMLButtonElement>(".nav-item"))) {
    b.addEventListener("click", () => showPage(b.dataset.page!));
  }
  showPage("usage");

  const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>("#usageTabs button"));
  const setTab = (tab: string) => {
    for (const b of tabs) b.classList.toggle("active", b.dataset.tab === tab);
    $("#usage-overview").classList.toggle("hidden", tab !== "overview");
    $("#usage-details").classList.toggle("hidden", tab !== "details");
  };
  tabs.forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab!)));

  for (const b of Array.from(document.querySelectorAll<HTMLButtonElement>("#periodPills button"))) {
    b.addEventListener("click", () => {
      for (const x of Array.from(document.querySelectorAll("#periodPills button"))) x.classList.toggle("active", x === b);
    });
  }

  // ---- queries ----

  query<StatsData>(["stats"], () => api("/api/stats"), { interval: 3000 }).subscribe((s) => {
    if (!s) return;
    renderStats(s);
    renderProviderBars(s);
    renderModelTable(s.byModel);
  });

  query<LogRow[]>(["logs"], () => api("/api/logs"), { interval: 3000 }).subscribe((rows) => {
    if (!rows) return;
    renderRecent(rows);
    renderHistory(rows);
  });

  query<ProviderCat[]>(["providers"], () => api("/api/providers")).subscribe((list) => {
    if (list) renderProviders(list);
  });

  query<Connection[]>(["connections"], () => api("/api/connections")).subscribe((list) => {
    if (list) renderConnections(list);
  });

  query<Combo[]>(["combos"], () => api("/api/combos")).subscribe((list) => {
    if (list) renderCombos(list);
  });

  // ---- topology ----

  const topo = createTopology($("#topo"));
  const pollTopo = () =>
    api<TopoData>("/api/topology?window=60").then((d) => {
      topo.setData(d);
      $("#topoBadge").replaceChildren(badge(d.activeCount > 0 ? "badge-primary" : "badge-default", d.activeCount > 0 ? `${d.activeCount} active` : "idle"));
    });
  pollTopo();
  setInterval(pollTopo, 2000);

  // ---- forms ----

  const provSel = $("#connProv") as HTMLSelectElement;
  query<ProviderCat[]>(["providers"], () => api("/api/providers")).subscribe((list) => {
    if (!list) return;
    provSel.replaceChildren();
    for (const p of list) provSel.append(new Option(p.id, p.id));
  });

  $("#connForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const key = ($("#connKey") as HTMLInputElement).value.trim();
    if (!key) return;
    await api("/api/connections", {
      method: "POST",
      body: JSON.stringify({ provider: provSel.value, api_key: key, priority: Number(($("#connPrio") as HTMLInputElement).value || 0) }),
    });
    ($("#connKey") as HTMLInputElement).value = "";
    invalidate(["connections", "providers"]);
  });

  $("#addComboBtn").addEventListener("click", () => $("#comboForm").classList.remove("hidden"));
  $("#comboForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = ($("#comboName") as HTMLInputElement).value.trim();
    const models = ($("#comboModels") as HTMLInputElement).value.split(/\s+/).filter(Boolean);
    if (!name || models.length === 0) return;
    await api("/api/combos", { method: "POST", body: JSON.stringify({ name, models }) });
    ($("#comboName") as HTMLInputElement).value = "";
    ($("#comboModels") as HTMLInputElement).value = "";
    $("#comboForm").classList.add("hidden");
    invalidate(["combos"]);
  });

  // ---- settings ----

  const saveBtn = $("#saveSettings") as HTMLButtonElement;
  const markDirty = () => saveBtn.removeAttribute("disabled");
  query<Settings>(["settings"], () => api("/api/settings")).subscribe((s) => {
    if (s) renderSettings(s, markDirty);
  });
  saveBtn.addEventListener("click", async () => {
    await api("/api/settings", {
      method: "PUT",
      body: JSON.stringify({
        rtk_on: $("#rtkToggle").classList.contains("on") ? 1 : 0,
        caveman_level: ($("#cavSel") as HTMLSelectElement).value,
        ponytail_level: ($("#ponySel") as HTMLSelectElement).value,
        strategy: ($("#strategySel") as HTMLSelectElement).value,
      }),
    });
    saveBtn.setAttribute("disabled", "true");
    invalidate(["settings"]);
  });
}

boot();