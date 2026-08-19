import { useState } from "react";
import { Bot, Box, Code2, MousePointer2, Sparkles } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { Badge } from "../ui/badge";
import { useApi, type LogRow, type SavedModel } from "../api";
import { CopyButton } from "../copy-button";
import { cn } from "../../lib/utils";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";

export interface CliTool {
  name: string;
  desc: string;
  icon: LucideIcon;
  lang: string;
  /** base = origin, model = primary model spec, all = every chosen model spec */
  code: (base: string, model: string, all: string[]) => string;
}

/** The supported CLI integrations and their native config snippets.
 * Shapes mapped 1:1 from OmniRoute's CLI tool catalog (setup-codex /
 * setup-opencode / setup-cursor / Hermes Agent config at $HERMES_HOME). */
export const CLI_TOOLS: CliTool[] = [
  {
    name: "Claude Code",
    desc: "env vars — no config file needed (base URL at root; /v1/messages appended)",
    icon: Bot,
    lang: "bash",
    code: (b, m, all) => {
      const small = all[1] ? `export ANTHROPIC_SMALL_FAST_MODEL=${all[1]}\n` : "";
      return `export ANTHROPIC_BASE_URL=${b}
export ANTHROPIC_AUTH_TOKEN=sk-troy
export ANTHROPIC_MODEL=${m}
${small}claude`;
    },
  },
  {
    name: "Hermes",
    desc: "~/.hermes/config.yaml — OpenAI-compatible endpoint",
    icon: Sparkles,
    lang: "yaml",
    code: (b, m) => `model:
  default: "${m}"
  provider: "custom"
  base_url: "${b}/v1"
  api_key: "sk-troy"`,
  },
  {
    name: "Codex CLI",
    desc: "~/.codex/config.toml — uses the responses API",
    icon: Box,
    lang: "toml",
    code: (b, m) => `model_provider = "troy"
model = "${m}"

[model_providers.troy]
name = "Troy"
base_url = "${b}/v1"
wire_api = "responses"`,
  },
  {
    name: "Cursor",
    desc: "in-app steps — Cursor's config is opaque, so no file is written",
    icon: MousePointer2,
    lang: "text",
    code: (b, m) => `Settings → Models → Advanced (or Model → OpenAI API Key)

OpenAI API Base URL: ${b}/v1
OpenAI API Key:      sk-troy
Model:               ${m}`,
  },
  {
    name: "OpenCode",
    desc: "opencode.json in your project — every chosen model",
    icon: Code2,
    lang: "json",
    code: (b, m, all) => {
      const entries = (all.length ? all : [m]).map((s) => `        "${s}": { "name": "${s}" }`).join(",\n");
      return `{
  "$schema": "https://opencode.ai/config.json",
  "model": "troy/${m}",
  "provider": {
    "troy": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Troy",
      "options": {
        "baseURL": "${b}/v1",
        "apiKey": "sk-troy"
      },
      "models": {
${entries}
      }
    }
  }
}`;
    },
  },
];

export function ToolsPage() {
  const base = location.origin;
  const [selectedModel, setSelectedModel] = useState("");
  const logs = useApi<LogRow[]>("/api/logs?limit=100");
  const saved = useApi<SavedModel[]>("/api/models");
  const chosen = [...(saved.data ?? [])]
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
    .map((m) => m.spec);
  const lastUsed = (logs.data ?? []).find((l) => l.status === "200 OK");
  const fallbackModel = chosen[0] ?? (lastUsed ? `${lastUsed.provider}/${lastUsed.model}` : "openai/gpt-4o");
  const model = selectedModel && (chosen.length === 0 || chosen.includes(selectedModel)) ? selectedModel : fallbackModel;
  return (
    <div className="space-y-5">
      <Card>
        <CardHeader className="gap-1">
          <div className="flex items-center justify-between gap-3">
            <CardTitle className="text-sm">CLI tools</CardTitle>
            <Badge variant="secondary" className="font-mono text-[11px]">
              {base}/v1
            </Badge>
          </div>
          <CardDescription>
            troy speaks OpenAI-compatible API + Anthropic /v1/messages — point Claude Code, Hermes, Codex CLI, Cursor, or OpenCode at it. No key needed:
            troy uses your stored connection keys. The `sk-troy` in the snippets is a placeholder.
          </CardDescription>
          {chosen.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] text-muted-foreground">chosen models:</span>
              {chosen.map((s) => (
                <span key={s} className="rounded bg-primary/10 px-1.5 py-0.5 font-mono text-[11px] text-primary">
                  {s}
                </span>
              ))}
            </div>
          ) : null}
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <span className="text-[11px] text-muted-foreground">primary model for snippets:</span>
            <Select value={model} onValueChange={setSelectedModel}>
              <SelectTrigger size="sm" className="h-7 font-mono text-[11px]" aria-label="primary model for CLI snippets">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(chosen.length > 0 ? chosen : [fallbackModel]).map((spec) => (
                  <SelectItem key={spec} value={spec} className="font-mono text-xs">
                    {spec}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <p className="text-[11px] text-muted-foreground">
            {chosen.length > 0
              ? `OpenCode lists every chosen model; Claude Code gets main + fast model; Hermes, Codex, and Cursor take one model — ${model}.`
              : lastUsed
                ? `no chosen models yet — snippets use your last-used model ${model}. Pick models in the providers page and they appear here automatically.`
                : `no chosen models or usage yet — snippets use ${model} until you pick models in the providers page.`}
          </p>
        </CardHeader>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        {CLI_TOOLS.map((t) => {
          const code = t.code(base, model, chosen);
          return (
            <Card key={t.name}>
              <CardHeader className="gap-1 pb-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                      <t.icon className="size-4" />
                    </span>
                    <CardTitle className="truncate text-sm">{t.name}</CardTitle>
                  </div>
                  <CopyButton text={code} label={`copy ${t.name} config`} />
                </div>
                <CardDescription className="text-[11px]">{t.desc}</CardDescription>
              </CardHeader>
              <CardContent className="pt-0">
                <div className="relative">
                  <pre
                    className={cn(
                      "max-h-56 overflow-auto rounded-md border border-border bg-muted/40 p-3 font-mono text-[11px] leading-relaxed",
                      "whitespace-pre [&::-webkit-scrollbar]:w-1.5"
                    )}
                  >
                    <code>{code}</code>
                  </pre>
                  <span className="absolute top-2 right-2 rounded bg-background/80 px-1.5 py-0.5 font-mono text-[9px] tracking-widest text-muted-foreground uppercase">
                    {t.lang}
                  </span>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
