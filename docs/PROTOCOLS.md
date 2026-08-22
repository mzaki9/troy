# Protocols

troy speaks three inbound wire protocols and translates them all onto OpenAI chat completions —
the internal currency for tools, reasoning and usage — before talking to any upstream.

```
Claude Code ──/v1/messages──┐
Codex CLI ──/v1/responses───┼──▶ [OpenAI chat completions internally] ──▶ any provider
any OpenAI tool ──/v1/chat──┘
```

## `/v1/chat/completions`

Native passthrough. Body goes through routing (RTK compression, prompt injection, effort
aliases) and out essentially as-is. Streaming is SSE with a transparent `usage` scan.

## `/v1/messages` — Anthropic bridge

Full Anthropic Messages translation so Claude Code (and friends) work unmodified.

**Request → chat:**
- `system` (string or blocks) → system message
- assistant `tool_use` blocks → `tool_calls` (`input` → JSON-stringified `arguments`)
- user `tool_result` blocks → separate `role:"tool"` messages
- `image` blocks (base64 or URL source) → `image_url` parts
- `stop_sequences` → `stop`; `thinking.budget_tokens` → `reasoning_effort`
  (≥ 32 000 → high, ≥ 8 000 → medium, else low)
- `tools[].{name, description, input_schema}` → OpenAI function-tool shape

**Response ← chat:**
- content blocks: text + `tool_use` (arguments parsed back into an input object)
- `stop_reason`: `length`→`max_tokens`, `tool_calls`→`tool_use`, else `end_turn`
- usage `input_tokens` / `output_tokens`, id `msg_<uuid>`

**Streaming:** a state machine emits the proper event choreography — `message_start`,
per-block `content_block_start` / `content_block_delta` (text deltas; per-tool-index
`input_json_delta.partial_json`) / `content_block_stop`, then `message_delta` with output
tokens and `message_stop`.

Errors come back wrapped in the Anthropic envelope
(`{type:"error", error:{type:"api_error"|...}}`) with `retry-after` forwarded.

## `/v1/responses` — OpenAI Responses bridge

For Codex CLI (which dropped `wire_api = "chat"` in 2026+).

**Request → chat:** `instructions` → system; string `input` → one user message; items:
`message` (incl. `input_image` → image_url), `function_call` → assistant `tool_calls`,
`function_call_output` → `role:"tool"`. `reasoning` items are dropped (the upstream does its
own thinking). `max_output_tokens` → `max_tokens`; `reasoning.effort` → `reasoning_effort`.

**Response ← chat:** output items `message` (`output_text` parts) and `function_call`
(`call_id`, `name`, stringified arguments); usage includes
`input_tokens_details.cached_tokens` and `output_tokens_details.reasoning_tokens`; plus the
top-level `output_text` convenience field.

**Streaming:** emits the full lifecycle — `response.created`, `response.in_progress`,
`response.output_item.added/done`, `response.content_part.added/done`,
`response.output_text.delta/done`, `response.function_call_arguments.delta/done`, closing
with `response.completed`. Non-OK upstream responses pass through as-is (error shapes are
compatible).

## Tool calling across every boundary

Inbound bridges convert *into* chat shape; outbound bridges convert *back out*:

| Protocol | tools in | tool calls back |
|---|---|---|
| Chat Completions | `tools[]` | `tool_calls` |
| Anthropic | `tools[].input_schema` | `tool_use` content blocks + `input_json_delta` |
| Responses | function tools | `function_call` items + argument delta events |

Command Code pairs tool calls/results by id and only forwards complete pairs.
Reasoning is unified onto `reasoning_effort` everywhere and
stripped for models that can't use it.

Related: [ROUTING.md](ROUTING.md) · [PROVIDERS.md](PROVIDERS.md) · [STREAMING.md](STREAMING.md)
