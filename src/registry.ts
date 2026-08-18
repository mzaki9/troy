export type Auth = "bearer" | "raw" | "none";

export interface Provider {
  id: string;
  aliases: string[];
  /** Display label shown in the dashboard; defaults to id. */
  name?: string;
  /** Chat-completions endpoint. May contain {placeholder} tokens filled from connection `data`. */
  baseUrl: string;
  auth: Auth;
  /** Static extra headers, e.g. HTTP-Referer for OpenRouter-family. */
  headers?: Record<string, string>;
  /** Connection `data` keys that {placeholder} in baseUrl reads from. */
  placeholders?: string[];
}

const httpref = { "HTTP-Referer": "https://troy.local", "X-Title": "troy" };

export const PROVIDERS: Provider[] = [
  { id: "openai", aliases: ["openai"], baseUrl: "https://api.openai.com/v1/chat/completions", auth: "bearer" },
  { id: "openrouter", aliases: ["openrouter", "or"], baseUrl: "https://openrouter.ai/api/v1/chat/completions", auth: "bearer", headers: httpref },
  { id: "deepseek", aliases: ["deepseek", "ds"], baseUrl: "https://api.deepseek.com/chat/completions", auth: "bearer" },
  { id: "groq", aliases: ["groq"], baseUrl: "https://api.groq.com/openai/v1/chat/completions", auth: "bearer" },
  { id: "mistral", aliases: ["mistral"], baseUrl: "https://api.mistral.ai/v1/chat/completions", auth: "bearer" },
  { id: "xai", aliases: ["xai", "grok"], baseUrl: "https://api.x.ai/v1/chat/completions", auth: "bearer" },
  { id: "together", aliases: ["together"], baseUrl: "https://api.together.xyz/v1/chat/completions", auth: "bearer" },
  { id: "nvidia", aliases: ["nvidia"], baseUrl: "https://integrate.api.nvidia.com/v1/chat/completions", auth: "bearer" },
  { id: "cerebras", aliases: ["cerebras"], baseUrl: "https://api.cerebras.ai/v1/chat/completions", auth: "bearer" },
  { id: "fireworks", aliases: ["fireworks"], baseUrl: "https://api.fireworks.ai/inference/v1/chat/completions", auth: "bearer" },
  { id: "siliconflow", aliases: ["siliconflow"], baseUrl: "https://api.siliconflow.com/v1/chat/completions", auth: "bearer" },
  { id: "hyperbolic", aliases: ["hyperbolic", "hyp"], baseUrl: "https://api.hyperbolic.xyz/v1/chat/completions", auth: "bearer" },
  { id: "perplexity", aliases: ["perplexity", "pplx"], baseUrl: "https://api.perplexity.ai/chat/completions", auth: "bearer" },
  { id: "cohere", aliases: ["cohere"], baseUrl: "https://api.cohere.com/compatibility/v1/chat/completions", auth: "bearer" },
  { id: "tencent", aliases: ["hunyuan"], baseUrl: "https://api.hunyuan.cloud.tencent.com/v1/chat/completions", auth: "bearer" },
  { id: "baidu", aliases: ["qianfan", "ernie"], baseUrl: "https://qianfan.baidubce.com/v2/chat/completions", auth: "bearer" },
  { id: "minimax", aliases: ["minimax"], baseUrl: "https://api.minimax.io/v1/chat/completions", auth: "bearer" },
  { id: "minimax-cn", aliases: ["minimax-cn"], baseUrl: "https://api.minimaxi.com/v1/chat/completions", auth: "bearer" },
  { id: "xiaomi-mimo", aliases: ["mimo"], baseUrl: "https://api.xiaomimimo.com/v1/chat/completions", auth: "bearer" },
  { id: "morphllm", aliases: ["morph", "morphllm"], baseUrl: "https://api.morphllm.com/v1/chat/completions", auth: "bearer" },
  { id: "llm7", aliases: ["llm7", "llm-7"], baseUrl: "https://api.llm7.io/v1/chat/completions", auth: "bearer" },
  { id: "poolside", aliases: ["poolside", "ps"], baseUrl: "https://inference.poolside.ai/v1/chat/completions", auth: "bearer" },
  { id: "sambanova", aliases: ["samba"], baseUrl: "https://api.sambanova.ai/v1/chat/completions", auth: "bearer" },
  { id: "nebius", aliases: ["nebius"], baseUrl: "https://api.tokenfactory.nebius.com/v1/chat/completions", auth: "bearer" },
  { id: "featherless", aliases: ["featherless", "fl"], baseUrl: "https://api.featherless.ai/v1/chat/completions", auth: "bearer" },
  { id: "blackbox", aliases: ["blackbox", "bb"], baseUrl: "https://api.blackbox.ai/v1/chat/completions", auth: "bearer" },
  { id: "venice", aliases: ["venice", "vn"], baseUrl: "https://api.venice.ai/api/v1/chat/completions", auth: "bearer" },
  { id: "kimchi", aliases: ["kimchi", "k"], baseUrl: "https://llm.kimchi.dev/openai/v1/chat/completions", auth: "bearer" },
  { id: "bazaarlink", aliases: ["bzl", "bazaar-link"], baseUrl: "https://bazaarlink.ai/api/v1/chat/completions", auth: "bearer", headers: httpref },
  { id: "bluesminds", aliases: ["bm", "blue-sminds"], baseUrl: "https://api.bluesminds.com/v1/chat/completions", auth: "bearer" },
  { id: "chutes", aliases: ["chutes", "ch"], baseUrl: "https://llm.chutes.ai/v1/chat/completions", auth: "bearer" },
  { id: "vercel-ai-gateway", aliases: ["vercel", "vercel-ai-gateway"], baseUrl: "https://ai-gateway.vercel.sh/v1/chat/completions", auth: "bearer" },
  { id: "opencode", aliases: ["oc", "opencode", "opencode-free", "zen"], baseUrl: "https://opencode.ai/zen/v1/chat/completions", auth: "none" },
  { id: "opencode-go", aliases: ["ocg", "opencode-go", "opencode-zen-go"], baseUrl: "https://opencode.ai/zen/go/v1/chat/completions", auth: "bearer" },
  { id: "zai", aliases: ["zai", "glm", "z-ai"], baseUrl: "https://api.z.ai/api/coding/paas/v4/chat/completions", auth: "bearer" },
  { id: "zai-cn", aliases: ["zai-cn", "glm-cn", "zhipu", "bigmodel"], baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions", auth: "bearer" },
  { id: "api-airforce", aliases: ["af", "airforce"], baseUrl: "https://api.airforce/v1/chat/completions", auth: "bearer", headers: httpref },
  { id: "clinepass", aliases: ["clinepass"], baseUrl: "https://api.cline.bot/api/v1/chat/completions", auth: "bearer", headers: httpref },
  { id: "codebuddy-cn", aliases: ["cbcn"], baseUrl: "https://copilot.tencent.com/v2/chat/completions", auth: "bearer", headers: { "x-requested-with": "XMLHttpRequest", "X-Product": "gpts", "X-IDE-Type": "vscode" } },
  { id: "codebuddy-intl", aliases: ["cbai"], baseUrl: "https://www.codebuddy.ai/v2/chat/completions", auth: "bearer", headers: { "x-requested-with": "XMLHttpRequest", "X-Product": "gpts", "X-IDE-Type": "vscode" } },
  { id: "kilo-gateway", aliases: ["kgw"], baseUrl: "https://api.kilo.ai/api/gateway/chat/completions", auth: "bearer" },
  { id: "cloudflare-ai", aliases: ["cloudflare", "cf"], baseUrl: "https://api.cloudflare.com/client/v4/accounts/{accountId}/ai/v1/chat/completions", auth: "bearer", placeholders: ["accountId"] },
  { id: "alicode", aliases: ["alicode", "qwen-code"], baseUrl: "https://coding.dashscope.aliyuncs.com/v1/chat/completions", auth: "bearer" },
  { id: "alicode-intl", aliases: ["alicode-intl", "qwen-code-intl"], baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1/chat/completions", auth: "bearer" },
  { id: "alibaba", aliases: ["alibaba", "alims-intl", "dashscope-intl"], baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions", auth: "bearer" },
  { id: "byteplus", aliases: ["byteplus", "bpm"], baseUrl: "https://ark.ap-southeast.bytepluses.com/api/v3/chat/completions", auth: "bearer" },
  { id: "volcengine-ark", aliases: ["ark", "volcengine-ark"], baseUrl: "https://ark.cn-beijing.volces.com/api/v3/chat/completions", auth: "bearer" },
  { id: "alibaba-token-plan", aliases: ["alibaba-token-plan", "alitp-intl", "atp"], baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions", auth: "bearer" },
];

const byId = new Map<string, Provider>();
const byAlias = new Map<string, Provider>();
for (const p of PROVIDERS) {
  byId.set(p.id, p);
  byAlias.set(p.id, p);
  for (const a of p.aliases) byAlias.set(a, p);
}

// user-defined providers, loaded from the store and registered at startup
const custom = new Map<string, Provider>();

export function registerCustomProvider(p: Provider) {
  custom.set(p.id, p);
  byAlias.set(p.id, p);
  for (const a of p.aliases) byAlias.set(a, p);
}

export function unregisterCustomProvider(id: string) {
  const p = custom.get(id);
  if (!p) return;
  custom.delete(id);
  byAlias.delete(id);
  for (const a of p.aliases) byAlias.delete(a);
}

export function customProviderIds(): string[] {
  return [...custom.keys()];
}

export function getProvider(idOrAlias: string): Provider | undefined {
  return custom.get(idOrAlias) ?? byAlias.get(idOrAlias);
}

export function providerIds(): string[] {
  return [...PROVIDERS.map((p) => p.id), ...customProviderIds()];
}

/** The default provider for an unprefixed bare model name, or "openai". */
export function inferProvider(model: string): Provider {
  if (model.startsWith("claude-")) return getProvider("openrouter")!;
  if (model.startsWith("gpt-") || model.startsWith("o1") || model.startsWith("o3") || model.startsWith("o4")) return getProvider("openai")!;
  if (model.startsWith("gemini-")) return getProvider("openrouter")!;
  if (model.startsWith("deepseek-")) return getProvider("deepseek")!;
  if (model.startsWith("glm-")) return getProvider("zai-cn")!;
  if (model.includes("grok")) return getProvider("xai")!;
  return getProvider("openai")!;
}