import { describe, expect, test } from "bun:test";
import { CLI_TOOLS } from "../dashboard/components/pages/tools.tsx";

const base = "http://localhost:3000";
const model = "openai/gpt-4o";
const key = "sk-troy-0123456789abcdef0123456789abcdef0123456789abcdef";

describe("CLI tool catalog", () => {
  test("exposes only the supported integrations", () => {
    expect(CLI_TOOLS.map((tool) => tool.name)).toEqual(["Claude Code", "Hermes", "Codex CLI", "Cursor", "OpenCode"]);
  });

  test("maps each integration to its native endpoint/config format", () => {
    const snippets = Object.fromEntries(CLI_TOOLS.map((tool) => [tool.name, tool.code(base, model, [model], key)]));

    expect(snippets["Claude Code"]).toContain(`ANTHROPIC_BASE_URL=${base}`);
    expect(snippets["Claude Code"]).toContain(`ANTHROPIC_MODEL=${model}`);
    expect(snippets["Claude Code"]).toContain(`ANTHROPIC_AUTH_TOKEN=${key}`);

    expect(snippets.Hermes).toContain(`base_url: "${base}/v1"`);
    expect(snippets.Hermes).toContain(`default: "${model}"`);
    expect(snippets.Hermes).toContain('provider: "custom"');

    expect(snippets["Codex CLI"]).toContain(`base_url = "${base}/v1"`);
    expect(snippets["Codex CLI"]).toContain('wire_api = "responses"');
    expect(snippets["Codex CLI"]).toContain(`model = "${model}"`);

    // Cursor ships no config file (opaque SQLite) — guide print only
    expect(snippets.Cursor).toContain(`${base}/v1`);
    expect(snippets.Cursor).toContain(`Model:               ${model}`);

    expect(snippets.OpenCode).toContain(`"baseURL": "${base}/v1"`);
    expect(snippets.OpenCode).toContain(`"model": "troy/${model}"`);
    expect(snippets.OpenCode).toContain('"npm": "@ai-sdk/openai-compatible"');
  });

  test("renders OpenCode config in the 9Router shape (modalities + explorer subagent)", () => {
    const parsed = JSON.parse(
      CLI_TOOLS.find((t) => t.name === "OpenCode")!.code(base, model, [model, "openai/gpt-5"], key),
    );

    // every model entry carries name + modalities
    for (const m of [model, "openai/gpt-5"]) {
      expect(parsed.provider.troy.models[m].name).toBe(m);
      expect(parsed.provider.troy.models[m].modalities.input).toEqual(["text", "image"]);
      expect(parsed.provider.troy.models[m].modalities.output).toEqual(["text"]);
    }

    // explorer subagent mirrors the primary model
    expect(parsed.agent.explorer).toEqual({
      description: "Fast explorer subagent for codebase exploration",
      mode: "subagent",
      model: `troy/${model}`,
    });
  });

  test("embeds the real troy api key (never the placeholder) in every snippet", () => {
    for (const tool of CLI_TOOLS) {
      const snippet = tool.code(base, model, [model], key);
      const manual = tool.manual(base, model, [model], key);
      expect(snippet, `${tool.name} snippet`).not.toContain("PLACEHOLDER");
      expect(snippet, `${tool.name} snippet`).toContain(key);
      expect(manual, `${tool.name} manual`).toContain(key);
    }
  });
});
