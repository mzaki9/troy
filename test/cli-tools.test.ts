import { describe, expect, test } from "bun:test";
import { CLI_TOOLS } from "../dashboard/components/pages/tools.tsx";

const base = "http://localhost:3000";
const model = "openai/gpt-4o";

describe("CLI tool catalog", () => {
  test("exposes only the supported integrations", () => {
    expect(CLI_TOOLS.map((tool) => tool.name)).toEqual([
      "Claude Code",
      "Hermes",
      "Codex CLI",
      "Cursor",
      "OpenCode",
    ]);
  });

  test("maps each integration to its native endpoint/config format", () => {
    const snippets = Object.fromEntries(CLI_TOOLS.map((tool) => [tool.name, tool.code(base, model, [model])]));

    expect(snippets["Claude Code"]).toContain(`ANTHROPIC_BASE_URL=${base}`);
    expect(snippets["Claude Code"]).toContain(`ANTHROPIC_MODEL=${model}`);
    expect(snippets["Claude Code"]).toContain("ANTHROPIC_AUTH_TOKEN=sk-troy");

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
});