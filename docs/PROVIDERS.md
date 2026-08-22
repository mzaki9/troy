# Providers

## Registry

~45 built-in providers live in `src/proxy/registry.ts`. Each entry:

```ts
{ id, aliases[], name?, baseUrl, modelsUrl?, auth, headers?, placeholders?, autoToken?, staticModels? }
```

- **auth modes** — `bearer` (`Authorization: Bearer …`), `raw` (`x-api-key`), or `none`
  (keyless free tiers — troy synthesizes one `<provider>-keyless` connection)
- **aliases** — short ids accepted everywhere (`or` → openrouter, `ds` → deepseek, `k` → kimchi…)
- **placeholders** — `{placeholder}` tokens in baseUrl filled from the connection's `extra`
  JSON (e.g. Cloudflare's `{accountId}`)
- **autoToken** — providers whose token is discovered locally
- **staticModels** — providers without a usable models endpoint ship their catalog inline

Highlights beyond the majors: OpenRouter, Groq, DeepSeek, Cerebras, xAI, Mistral, Together,
NVIDIA, Fireworks, SiliconFlow, Hyperbolic, Perplexity, Cohere, z.ai/Zhipu, Baidu Qianfan,
Tencent Hunyuan, MiniMax, Xiaomi MiMo, Morph, llm7, Poolside, SambaNova, Nebius, Featherless,
Blackbox, Venice, Chutes, Vercel AI Gateway, Cloudflare AI, Alibaba (DashScope + token plan),
BytePlus, Volcengine Ark, Kilo Gateway, Clinepass, CodeBuddy (cn/intl), AliCode, api-airforce,
FreeBuff (`fb`, codebuff.com free tier with automatic CLI-token discovery)…

Bare model names route via `inferProvider`: `claude-*`/`gemini-*` → openrouter, `gpt-*` →
openai, `deepseek-*` → deepseek, `glm-*` → zai-cn, `*grok*` → xai.

## Custom providers

Three fields from the dashboard: `id` (`^[a-z0-9][a-z0-9-]{0,31}$`), http(s) `baseUrl`,
auth mode. Stored in the `kv` table, loaded at boot, and they **shadow built-ins** on id
collision. Deleting a custom provider also deletes its connections.

## Command Code bridge (`cmd`)

Bridge to Command Code's `/alpha/generate` endpoint (works on all tiers):

- Builds the CC envelope: static config block, `permissionMode: "standard"`, params carrying
  messages/tools/system/stream; native thinking knobs passed verbatim; `max_tokens` clamped
  to 200 000
- Vision heuristics map image parts across OpenAI/AI-SDK/Anthropic shapes to CC `{type:"image"}`
- Tool calls/results are only sent when **paired** (matched by call id both directions); a
  reserved-name collision (`tool_search`) is renamed on-wire and restored on reply
- Reply parser handles CC SSE events (`text-delta`, `reasoning-delta`, `tool-call`,
  `finish-step`, `error`) into chat completions or translated chunks, canonicalizing usage
  across many naming dialects without double-counting cached input

Related: [PROTOCOLS.md](PROTOCOLS.md) · [MODELS.md](MODELS.md)
