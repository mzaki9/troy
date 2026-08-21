/**
 * Reasoning/thinking-model support — modeled after OmniRoute (the 9router
 * TypeScript fork): effort aliases, capability flags, silent effort drop for
 * non-reasoning models.
 *
 * Effort aliases follow OpenAI's own convention (o3-mini-high → o3-mini +
 * reasoning_effort "high") and OmniRoute's alias-id generation.
 */

/** Aliases accepted after a "-" on a reasoning model id. */
export const EFFORT_ALIASES = ["minimal", "low", "medium", "high", "max", "xhigh"] as const;

const REASONING: RegExp[] = [
  /^(o1|o3|o4)(-|$)/, // OpenAI o-series
  /^gpt-5/, // OpenAI gpt-5 family
  /(^|[-_])(r1|r2)([-_]|$)/i, // deepseek-r1/r2, glm-r1, kimi-r1-0528
  /(^|[-_])thinking([-_]|$)/i, // qwen3-thinking, kimi-k2-thinking, longcat-r1-thinking
  /(^|[-_])reasoning([-_]|$)/i, // grok-4-…-reasoning
  /(^|[-_])reasoner([-_]|$)/i, // qwen3-reasoner, deepseek-reasoner
  /^deepseek-(v3|v4|v5)/, // deepseek chat probes thinking on v3+
  /^gemini-(2\.5|3)/, // gemini 2.5+ / 3 think natively
  /^claude-(opus|sonnet)-4/, // claude 4.x
  /^glm-(4\.6|4\.7|5)/, // glm-4.6+ (zai/glm coding plans)
  /^kimi-k2/, // kimi k2 thinking
  /^minimax-m2/, // minimax m2 thinking mode
  /^ernie-4\.5/, // ernie-4.5-8k thinks
  /^nemotron-3/, // nvidia nemotron-3 ultra
];

/** Whether a model id is reasoning-capable. */
export function isReasoningModel(model: string): boolean {
  return REASONING.some((re) => re.test(model));
}

/**
 * Split a trailing effort alias off a model id, when the base model is
 * reasoning-capable ("o3-mini-high" → o3-mini + "high"). Non-reasoning bases
 * pass through untouched so real ids like "gpt-4o-mini" never get munged.
 */
export function resolveEffortAlias(spec: string): { model: string; effort: string | undefined } {
  const m = /^(.*)-([a-z]+)$/i.exec(spec);
  if (!m) return { model: spec, effort: undefined };
  const base = m[1];
  const word = m[2].toLowerCase();
  if (!(EFFORT_ALIASES as readonly string[]).includes(word)) return { model: spec, effort: undefined };
  if (!isReasoningModel(base)) return { model: spec, effort: undefined };
  return { model: base, effort: word };
}
