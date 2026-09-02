import { buildTroyServer } from "../../src/app";
import { CooldownStore } from "../../src/proxy/cooldown";
import type { StateEvent } from "../../src/store/db";
import { Store } from "../../src/store/db";
import { createMockUpstream, type MockUpstream } from "./upstream";
export interface TestTroy {
  store: Store;
  cooldowns: CooldownStore;
  upstream: MockUpstream;
  url: string;
  apiKey: string;
  server: ReturnType<typeof buildTroyServer>["server"];
  stop: () => void;
  /** fetch against the troy server (adds troy api key automatically unless opts.noAuth) */
  fetch: (path: string, init?: RequestInit & { noAuth?: boolean }) => Promise<Response>;
  /** login via dashboard and return { cookie, token } */
  login: (password?: string) => Promise<{ cookie: string; token: string; authed: boolean }>;
  /** helper to add a connection pointing at the mock upstream */
  addConnection: (
    provider: string,
    key: string,
    extra?: Partial<{ priority: number; base_url: string; name: string }>,
  ) => ReturnType<Store["addConnection"]>;
  /** helper to put a combo */
  putCombo: (name: string, models: string[], strategy?: string) => ReturnType<Store["putCombo"]>;
}

/**
 * Creates an isolated Troy instance:
 *  - Store(":memory:")
 *  - CooldownStore with durable append to same Store (real replay path)
 *  - MockUpstream (Bun.serve) for all provider upstreams
 *  - buildTroyServer({store, cooldowns, port:0, enableBackgroundTasks:false})
 *
 * Caller must call `t.stop()` in afterEach/afterAll.
 */
export function createTestTroy(): TestTroy {
  const prev = process.env.TROY_ALLOW_LOOPBACK;
  process.env.TROY_ALLOW_LOOPBACK = "1";
  const store = new Store(":memory:");
  // cooldown sink batches writes; expose batch path so flushPending syncs to DB
  const cooldowns = new CooldownStore({
    append: (e: StateEvent) => store.appendStateEvent(e),
    appendBatch: (es: StateEvent[]) => store.appendStateEventsBatch(es),
  } as unknown as { append: (e: StateEvent) => void });
  const upstream = createMockUpstream();
  const { server } = buildTroyServer({ store, cooldowns, port: 0, enableBackgroundTasks: false });
  const url = server.url.toString().replace(/\/$/, "");
  const apiKey = store.getApiAuth().key;

  const troyFetch = async (path: string, init: RequestInit & { noAuth?: boolean } = {}) => {
    const { noAuth, headers, ...rest } = init as RequestInit & { noAuth?: boolean; headers?: Record<string, string> };
    const hdrs: Record<string, string> = { ...(headers as Record<string, string> | undefined) };
    if (!noAuth && apiKey) hdrs.authorization = `Bearer ${apiKey}`;
    if (rest.body && !hdrs["content-type"]) hdrs["content-type"] = "application/json";
    return fetch(`${url}${path}`, { ...rest, headers: hdrs });
  };

  const login = async (password = "troy123") => {
    const res = await fetch(`${url}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
    });
    const cookie = res.headers.get("set-cookie") ?? "";
    const token = cookie.match(/troy_session=([^;]+)/)?.[1] ?? "";
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean };
    return { cookie, token, authed: body.ok === true };
  };

  const addConnection = (
    provider: string,
    key: string,
    extra: Partial<{ priority: number; base_url: string; name: string }> = {},
  ) => {
    return store.addConnection({
      provider,
      api_key: key,
      base_url: extra.base_url ?? upstream.url,
      name: extra.name ?? null,
      priority: extra.priority ?? 0,
    } as never);
  };

  const putCombo = (name: string, models: string[], strategy = "fallback") => store.putCombo(name, models, strategy);

  const stop = () => {
    try {
      server.stop(true);
    } catch {}
    try {
      upstream.stop();
    } catch {}
    if (prev === undefined) delete process.env.TROY_ALLOW_LOOPBACK;
    else process.env.TROY_ALLOW_LOOPBACK = prev;
  };
  return { store, cooldowns, upstream, url, apiKey, server, stop, fetch: troyFetch, login, addConnection, putCombo };
}

/** Helper to extract troy_session cookie header value for authed dashboard requests */
export function cookieHeader(cookie: string): Record<string, string> {
  // cookie from login is like "troy_session=xxx; Path=/; ..." — we need just the pair
  const pair = cookie.split(";")[0]?.trim() ?? cookie;
  return { cookie: pair };
}
