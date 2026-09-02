export const TAG = {
  HTTP: "troy:http",
  AUTH: "troy:auth",
  PROXY: "troy:proxy",
  PROVIDER: "troy:provider",
  STORE: "troy:store",
  MODELSDEV: "troy:modelsdev",
  SYSTEM: "troy:system",
} as const;

export type Tag = (typeof TAG)[keyof typeof TAG];

export function isTraceEnabled(): boolean {
  return process.env.TROY_TRACE === "1";
}

export function httpLog(fields: {
  requestId: string;
  status: number;
  latency: number;
  ip: string;
  method: string;
  path: string;
  error?: string;
}): void {
  if (!isTraceEnabled() && fields.status < 400) return;
  try {
    console.log(JSON.stringify({ tag: TAG.HTTP, ...fields, ts: new Date().toISOString() }));
  } catch {}
}

export function trace(tag: Tag, msg: string): void {
  if (!isTraceEnabled()) return;
  try {
    console.log(`[${tag}] ${msg}`);
  } catch {}
}

export function panic(tag: Tag, msg: string, err: unknown, extra?: Record<string, string>): void {
  try {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? (err.stack ?? undefined) : undefined;
    console.error(
      JSON.stringify({
        tag,
        msg,
        error: message,
        ...(stack ? { stack } : {}),
        ...(extra ?? {}),
        ts: new Date().toISOString(),
      }),
    );
  } catch {}
}

export function cLog(tag: Tag, fields: Record<string, unknown>): void {
  try {
    console.log(JSON.stringify({ tag, ...fields, ts: new Date().toISOString() }));
  } catch {}
}
