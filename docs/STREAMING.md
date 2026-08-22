# Streaming

How troy keeps SSE flows alive, observable, and honest about failure.

## Deadlines

- `TROY_STREAM_IDLE_MS` (default 60 000, min 1 000) — TTFB/connect guard for streams and
  command-code requests; also the per-read idle watchdog once the stream flows
- `TROY_UPSTREAM_TIMEOUT_MS` (default 300 000, min 1 000) — whole-request ceiling for
  non-stream bodies

Timers are cleared on resolution — a healthy body is never touched by its guard.

## The stream pipeline

1. **`takeHead`** — consumes the first chunk under the deadline and replays it into a fresh
   `ReadableStream`. A mid-stream read error injects exactly one SSE
   `{"error":{...bad_gateway}}` frame, closes cleanly, and fires the cooldown callback so the
   failure is classified like any other.
2. **`idleGuard`** — per-read watchdog; a stall past the limit emits one SSE timeout error
   frame (`upstream idle for over Xms`, code `timeout`), closes the response, cancels upstream.
3. **`scanUsage`** — a transparent TransformStream that scans `data:` lines for `usage`
   payloads without touching the bytes the client sees.
4. **`endMark`** — fires its callback exactly once on consume/abort/cancel; drives
   end-of-stream logging.

Non-stream bodies buffer via `readBody` with a 32 MiB cap; empty/reset/oversize counts as a
failure so the failover walk continues to the next account.

`passthrough` rebuilds the final Response with CORS `*`, correct content-type (defaulting
`text/event-stream` / `application/json`), and forwards `retry` / `x-request-id` headers.
Bun's idle timeout is disabled (`server.timeout(request, 0)`) once a streaming body exists.

## Translation under streaming

`sseTranslate` is the generic engine used by the Anthropic and Responses bridges: splits SSE
`data:` lines, parses each JSON chunk, maps it through a protocol callback, and runs a
finalize pass once at `[DONE]`/flush — producing proper protocol event sequences
(`message_start`…`message_stop`, `response.created`…`response.completed`).

Related: [PROTOCOLS.md](PROTOCOLS.md) · [RESILIENCE.md](RESILIENCE.md)
