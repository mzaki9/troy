// hoisted hot-path constants: no per-request RegExp/TextEncoder allocation
export const ENC = new TextEncoder();

/** upstream silence (before first byte or between chunks) longer than this is
 *  cut — flowing tokens arrive in seconds; a long silence means dead, not slow.
 *  Thinking models stream reasoning deltas, so legit gaps stay far below this. */
export const STREAM_IDLE_MS = Math.max(1000, Number(process.env.TROY_STREAM_IDLE_MS ?? 60_000));
/** whole-request ceiling for non-stream upstream calls — generous so slow
 *  reasoning generations finish; hung TCP dies here instead of never. Streams
 *  are exempt: their health is judged by STREAM_IDLE_MS gaps, not total time. */
export const UPSTREAM_TIMEOUT_MS = Math.max(1000, Number(process.env.TROY_UPSTREAM_TIMEOUT_MS ?? 300_000));
/** per-line SSE buffer cap — mirrors new-api relay/helper/stream_scanner.go DefaultMax 128MB
 *  but README says 64MB; default 64MB via env STREAM_SCANNER_MAX_BUFFER_MB. */
export const STREAM_BUF_CAP = Math.max(1, Number(process.env.STREAM_SCANNER_MAX_BUFFER_MB ?? 64)) << 20;

/** Reject if `p` hasn't settled within `ms`. Used for connect/TTFB deadlines —
 *  clearing happens in the caller's finally, so resolved promises (and their
 *  bodies) are never touched by the timer. If an AbortController is supplied
 *  it is aborted on timeout so the orphan fetch socket is torn down. */
export function withDeadline<T>(p: Promise<T>, ms: number, controller?: AbortController): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, rej) => {
      timer = setTimeout(() => {
        try {
          controller?.abort(new Error(`upstream sent nothing within ${ms}ms`));
        } catch {}
        rej(new Error(`upstream sent nothing within ${ms}ms`));
      }, ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

type Chunk = { value: Uint8Array; done: false } | { value?: undefined; done: true };

export function passthrough(res: Response, stream: boolean): Response {
  const headers = new Headers({ "access-control-allow-origin": "*" });
  const ct = res.headers.get("content-type");
  headers.set("content-type", ct ?? (stream ? "text/event-stream" : "application/json"));
  if (stream) {
    headers.set("cache-control", "no-cache");
    headers.set("connection", "keep-alive");
    headers.set("x-accel-buffering", "no");
  }
  for (const h of ["retry", "x-request-id"]) {
    const v = res.headers.get(h);
    if (v) headers.set(h, v);
  }
  return new Response(res.body, { status: res.status, headers });
}

/** Numeric fields of an upstream `usage` object, or undefined when absent. */
export function numericUsage(u: unknown): Record<string, number> | undefined {
  if (!u || typeof u !== "object") return undefined;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(u as Record<string, unknown>)) {
    if (typeof v === "number") out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

/** usage from a complete chat-completions JSON body. */
export function usageOf(text: string): Record<string, number> | undefined {
  try {
    return normalizeTokens(numericUsage((JSON.parse(text) as { usage?: unknown }).usage));
  } catch {
    return undefined;
  }
}

/** Map provider dialects onto the OpenAI keys the stats SQL extracts.
 *  Anthropic-style upstreams say input_tokens/output_tokens; others camelCase. */
export function normalizeTokens(u: Record<string, number> | undefined): Record<string, number> | undefined {
  if (!u) return u;
  const pick = (...keys: string[]): number | undefined => {
    for (const k of keys) {
      const v = u[k];
      if (typeof v === "number") return v;
    }
    return undefined;
  };
  const prompt = pick("prompt_tokens", "input_tokens", "promptTokens", "inputTokens");
  const completion = pick("completion_tokens", "output_tokens", "completionTokens", "outputTokens");
  if (prompt === undefined && completion === undefined) return u;
  return {
    ...u,
    ...(prompt !== undefined ? { prompt_tokens: prompt } : {}),
    ...(completion !== undefined ? { completion_tokens: completion } : {}),
  };
}

const BODY_CAP = 32 << 20; // upstream JSON bodies beyond this are treated as failures

/** Fully buffer a non-streaming response. Empty / reset / oversize bodies are
 *  failures so the chain walk can try the next account instead of forwarding
 *  a broken payload. */
export async function readBody(res: Response): Promise<{ text: string | null; error: string | null }> {
  if (!res.body) return { text: null, error: "upstream returned an empty body" };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const n = await reader.read();
      if (n.done) break;
      chunks.push(n.value);
      bytes += n.value.byteLength;
      if (bytes > BODY_CAP) {
        reader.cancel().catch(() => {});
        return { text: null, error: "body too large" };
      }
    }
  } catch (e) {
    return { text: null, error: e instanceof Error ? e.message : "upstream connection reset" };
  }
  if (bytes === 0) return { text: null, error: "upstream returned an empty body" };
  const text = Buffer.concat(chunks as unknown as Buffer[]).toString("utf-8");
  if (!text) return { text: null, error: "upstream returned an empty body" };
  return { text, error: null };
}

/** Consume the first chunk of a streaming response and hand back a replayable
 *  body. A 200 whose body dies before emitting anything becomes a failure so
 *  the walk continues; mid-stream death surfaces one SSE error frame and fires
 *  `onMidstreamFail` so the caller can cool the account down. The first byte
 *  must arrive within `firstByteMs` (default STREAM_IDLE_MS) or the response
 *  is a failure — headers-then-nothing is a hang, not a slow provider. */
export async function takeHead(
  res: Response,
  stream: boolean,
  onMidstreamFail?: (message: string) => void,
  firstByteMs: number = STREAM_IDLE_MS,
  controller?: AbortController,
): Promise<{ res: Response; error: string | null }> {
  const reader = res.body!.getReader();
  let first: Chunk;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    first = await Promise.race([
      reader.read(),
      new Promise<never>((_, rej) => {
        timer = setTimeout(() => {
          try {
            controller?.abort(new Error(`no first byte within ${firstByteMs}ms`));
          } catch {}
          rej(new Error(`no first byte within ${firstByteMs}ms`));
        }, firstByteMs);
      }),
    ]);
  } catch (e) {
    reader.cancel().catch(() => {});
    try {
      controller?.abort(e instanceof Error ? e : new Error(String(e)));
    } catch {}
    return { res, error: e instanceof Error ? e.message : "upstream connection reset" };
  } finally {
    clearTimeout(timer);
  }
  if (first.done) return { res, error: "upstream returned an empty body" };

  let opened = false;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(first.value);
      opened = true;
    },
    async pull(c) {
      let n: Chunk;
      try {
        n = await reader.read();
      } catch (e) {
        if (stream && opened) {
          const message = e instanceof Error ? e.message : "upstream connection lost mid-stream";
          try {
            onMidstreamFail?.(message);
          } catch {
            /* cooldown bookkeeping must never break the stream */
          }
          c.enqueue(
            ENC.encode(
              `data: ${JSON.stringify({
                error: { message, type: "server_error", code: "bad_gateway" },
              })}\n\n`,
            ),
          );
        }
        c.close();
        return;
      }
      if (n.done) c.close();
      else c.enqueue(n.value);
    },
    cancel() {
      reader.cancel();
    },
  });
  return { res: new Response(body, { status: res.status, headers: res.headers }), error: null };
}

/** SSE scanner that lifts `usage` out of chat chunks without touching bytes. */
export function scanUsage(onUsage: (u: Record<string, number>) => void): TransformStream<Uint8Array, Uint8Array> {
  const dec = new TextDecoder();
  let pending: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  const grab = (raw: string) => {
    if (!raw || raw === "[DONE]") return;
    try {
      const u = numericUsage((JSON.parse(raw) as { usage?: unknown }).usage);
      if (u) onUsage(u);
    } catch {
      /* non-JSON line */
    }
  };
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, c) {
      let combined: Uint8Array<ArrayBufferLike>;
      if (pending.length) {
        combined = new Uint8Array(pending.length + chunk.length);
        combined.set(pending, 0);
        combined.set(chunk, pending.length);
      } else {
        combined = chunk;
      }
      if (combined.byteLength > STREAM_BUF_CAP) {
        c.enqueue(
          ENC.encode(
            `data: ${JSON.stringify({ error: { message: `upstream buffer exceeds ${STREAM_BUF_CAP} bytes`, type: "server_error", code: "too_large" } })}\n\n`,
          ),
        );
        c.error(new Error(`upstream buffer exceeds ${STREAM_BUF_CAP} bytes`));
        return;
      }
      // binary \n scan (10) over combined bytes, decode each line slice only once
      let start = 0;
      for (let i = 0; i < combined.length; i++) {
        if (combined[i] !== 10) continue; // \n
        const line = dec.decode(combined.subarray(start, i)).trim();
        start = i + 1;
        if (line.startsWith("data:")) grab(line.slice(5).trim());
      }
      pending = start === 0 ? combined : start < combined.length ? combined.slice(start) : new Uint8Array(0);
      // if we emitted lines, pending is the incomplete tail; already checked cap above,
      // but a tail that alone exceeds cap without newline should still error next chunk
      if (pending.byteLength > STREAM_BUF_CAP) {
        c.enqueue(
          ENC.encode(
            `data: ${JSON.stringify({ error: { message: `upstream buffer exceeds ${STREAM_BUF_CAP} bytes`, type: "server_error", code: "too_large" } })}\n\n`,
          ),
        );
        c.error(new Error(`upstream buffer exceeds ${STREAM_BUF_CAP} bytes`));
        return;
      }
      c.enqueue(chunk);
    },
    flush() {
      if (!pending.length) return;
      const tail = dec.decode(pending).trim();
      if (tail.startsWith("data:")) grab(tail.slice(5).trim());
    },
  });
}

/** Fire a callback exactly once when the body is consumed or abandoned. */
export function endMark(body: ReadableStream<Uint8Array>, onEnd: () => void): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let fired = false;
  const fire = () => {
    if (!fired) {
      fired = true;
      onEnd();
    }
  };
  return new ReadableStream<Uint8Array>({
    async pull(c) {
      let n: Chunk;
      try {
        n = await reader.read();
      } catch {
        fire();
        c.close();
        return;
      }
      if (n.done) {
        fire();
        c.close();
        return;
      }
      c.enqueue(n.value);
    },
    cancel() {
      fire();
      reader.cancel();
    },
  });
}

/** Cut a stream whose upstream stalls: no chunk within `ms` → one SSE error
 *  frame, then close (dsh per-read idle watchdog). Covers mid-stream death
 *  that takeHead's first-chunk guard cannot see. Also emits `: ping` keepalive
 *  every 15s so nginx/proxy idle timeouts don't close long reasoning gaps. */
export function idleGuard(body: ReadableStream<Uint8Array>, ms: number, pingMs = 15_000): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let pingTimer: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  const clearPing = () => {
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = undefined;
    }
  };

  return new ReadableStream<Uint8Array>({
    start(c) {
      // keepalive ping — matches new-api stream_scanner.go:150 pingTicker 10s
      pingTimer = setInterval(() => {
        if (closed) return;
        try {
          c.enqueue(ENC.encode(": ping\n\n"));
        } catch {
          clearPing();
        }
      }, pingMs);
    },
    async pull(c) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const n = await Promise.race([
          reader.read(),
          new Promise<"idle">((res) => {
            timer = setTimeout(() => res("idle"), ms);
          }),
        ]);
        if (n === "idle") {
          c.enqueue(
            ENC.encode(
              `data: ${JSON.stringify({
                error: { message: `upstream idle for over ${ms}ms`, type: "server_error", code: "timeout" },
              })}\n\n`,
            ),
          );
          closed = true;
          clearPing();
          c.close();
          reader.cancel().catch(() => {});
          return;
        }
        if (n.done) {
          closed = true;
          clearPing();
          c.close();
          return;
        }
        c.enqueue(n.value);
      } catch {
        closed = true;
        clearPing();
        c.close();
      } finally {
        clearTimeout(timer);
      }
    },
    cancel() {
      closed = true;
      clearPing();
      reader.cancel().catch(() => {});
    },
  });
}

/**
 * Shared chat-chunk → protocol-events SSE translator. Splits the upstream byte
 * stream into `data:` lines, parses each JSON chunk, maps it through
 * `translate`, and re-encodes the produced events as SSE frames. `[DONE]` and
 * end-of-stream both run `finalize` exactly once and emit its events.
 */
export function sseTranslate(
  translate: (chunk: unknown) => Record<string, unknown>[],
  finalize: (out: Record<string, unknown>[]) => void,
): TransformStream<Uint8Array, Uint8Array> {
  const dec = new TextDecoder();
  let buf = "";
  const frame = (e: Record<string, unknown>) => ENC.encode(`data: ${JSON.stringify(e)}\n\n`);
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buf += dec.decode(chunk, { stream: true });
      if (buf.length > STREAM_BUF_CAP) {
        controller.enqueue(
          ENC.encode(
            `data: ${JSON.stringify({ error: { message: `upstream buffer exceeds ${STREAM_BUF_CAP} bytes`, type: "server_error", code: "too_large" } })}\n\n`,
          ),
        );
        controller.error(new Error(`upstream buffer exceeds ${STREAM_BUF_CAP} bytes`));
        return;
      }
      for (let idx = buf.indexOf("\n"); idx >= 0; idx = buf.indexOf("\n")) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") {
          const events: Record<string, unknown>[] = [];
          finalize(events);
          for (const e of events) controller.enqueue(frame(e));
          return;
        }
        let ev: unknown;
        try {
          ev = JSON.parse(data);
        } catch {
          continue;
        }
        for (const e of translate(ev)) controller.enqueue(frame(e));
      }
    },
    flush(controller) {
      const events: Record<string, unknown>[] = [];
      finalize(events);
      for (const e of events) controller.enqueue(frame(e));
    },
  });
}
