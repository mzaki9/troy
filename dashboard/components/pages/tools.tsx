import type { LucideIcon } from "lucide-react";
import {
  ArrowRight,
  Bot,
  Box,
  ChevronDown,
  Code2,
  KeyRound,
  Layers,
  MousePointer2,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { useState } from "react";
import { cn } from "../../lib/utils";
import { type ApiKeyInfo, api, type Combo, type LogRow, type SavedModel, useApi } from "../api";
import { CopyButton } from "../copy-button";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";

/** Placeholder while the real key loads — every generated snippet swaps it out. */
export const KEY_PLACEHOLDER = "sk-troy-PLACEHOLDER";

export interface CliTool {
  name: string;
  desc: string;
  icon: LucideIcon;
  lang: string;
  /** base = origin, model = primary model spec, all = every chosen model spec, key = troy api key */
  code: (base: string, model: string, all: string[], key: string) => string;
  /** OmniRoute-style hand edit: exact config path + mkdir/cat heredoc recipe. */
  manual: (base: string, model: string, all: string[], key: string) => string;
  manualLang?: string;
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
    code: (b, m, all, key) => {
      const small = all[1] ? `export ANTHROPIC_SMALL_FAST_MODEL=${all[1]}\n` : "";
      return `export ANTHROPIC_BASE_URL=${b}
export ANTHROPIC_AUTH_TOKEN=${key}
export ANTHROPIC_MODEL=${m}
${small}claude`;
    },
    manual: (b, m, all, key) => {
      const small = all[1] ? `,\n    "ANTHROPIC_SMALL_FAST_MODEL": "${all[1]}"` : "";
      return `mkdir -p ~/.claude && cat > ~/.claude/settings.json << 'EOF'
{
  "env": {
    "ANTHROPIC_BASE_URL": "${b}",
    "ANTHROPIC_AUTH_TOKEN": "${key}",
    "ANTHROPIC_MODEL": "${m}"${small}
  }
}
EOF
# test: claude`;
    },
  },
  {
    name: "Hermes",
    desc: "~/.hermes/config.yaml — OpenAI-compatible endpoint",
    icon: Sparkles,
    lang: "yaml",
    code: (b, m, _all, key) => `model:
  default: "${m}"
  provider: "custom"
  base_url: "${b}/v1"
  api_key: "${key}"`,
    manual: (b, m, _all, key) => `mkdir -p ~/.hermes && cat > ~/.hermes/config.yaml << 'EOF'
model:
  default: "${m}"
  provider: "custom"
  base_url: "${b}/v1"
  api_key: "${key}"
EOF
# test: hermes`,
  },
  {
    name: "Codex CLI",
    desc: "~/.codex/config.toml — uses the responses API",
    icon: Box,
    lang: "toml",
    code: (b, m, _all, key) => `model_provider = "troy"
model = "${m}"

[model_providers.troy]
name = "Troy"
base_url = "${b}/v1"
experimental_bearer_token = "${key}"
wire_api = "responses"`,
    manual: (b, m, _all, key) => `mkdir -p ~/.codex && cat > ~/.codex/config.toml << 'EOF'
model_provider = "troy"
model = "${m}"

[model_providers.troy]
name = "Troy"
base_url = "${b}/v1"
experimental_bearer_token = "${key}"
wire_api = "responses"
EOF
# test: codex`,
  },
  {
    name: "Cursor",
    desc: "in-app steps — Cursor's config is opaque, so no file is written",
    icon: MousePointer2,
    lang: "text",
    code: (b, m, _all, key) => `Settings → Models → Advanced (or Model → OpenAI API Key)

OpenAI API Base URL: ${b}/v1
OpenAI API Key:      ${key}
Model:               ${m}`,
    manualLang: "text",
    manual: (b, m, _all, key) => `Cursor's config is opaque (SQLite) — nothing to edit by hand, set it in-app:

1. Cursor → Settings → Models → Advanced (or Model → OpenAI API Key)
2. OpenAI API Base URL: ${b}/v1
3. OpenAI API Key:      ${key}
4. Model:               ${m}
5. Chat (Cmd+I / Cmd+L) and pick the Troy model`,
  },
  {
    name: "OpenCode",
    desc: "opencode.json (project or ~/.config/opencode) — every chosen model",
    icon: Code2,
    lang: "json",
    code: (b, m, all, key) => {
      const entries = (all.length ? all : [m])
        .map(
          (s) => `        "${s}": {
          "name": "${s}",
          "modalities": {
            "input": ["text", "image"],
            "output": ["text"]
          }
        }`,
        )
        .join(",\n");
      return `{
  "$schema": "https://opencode.ai/config.json",
  "model": "troy/${m}",
  "provider": {
    "troy": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Troy",
      "options": {
        "baseURL": "${b}/v1",
        "apiKey": "${key}"
      },
      "models": {
${entries}
      }
    }
  },
  "agent": {
    "explorer": {
      "description": "Fast explorer subagent for codebase exploration",
      "mode": "subagent",
      "model": "troy/${m}"
    }
  }
}`;
    },
    manual: (b, m, all, key) => {
      const entries = (all.length ? all : [m])
        .map(
          (s) => `        "${s}": {
          "name": "${s}",
          "modalities": {
            "input": ["text", "image"],
            "output": ["text"]
          }
        }`,
        )
        .join(",\n");
      return `# global config — the same JSON works as a project's opencode.json
mkdir -p ~/.config/opencode && cat > ~/.config/opencode/opencode.json << 'EOF'
{
  "$schema": "https://opencode.ai/config.json",
  "model": "troy/${m}",
  "provider": {
    "troy": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Troy",
      "options": {
        "baseURL": "${b}/v1",
        "apiKey": "${key}"
      },
      "models": {
${entries}
      }
    }
  },
  "agent": {
    "explorer": {
      "description": "Fast explorer subagent for codebase exploration",
      "mode": "subagent",
      "model": "troy/${m}"
    }
  }
}
EOF
# test: opencode run "hi" --model troy/${m}`;
    },
  },
];

export function ToolsPage() {
  const base = location.origin;
  const [selectedModel, setSelectedModel] = useState("");
  const [rotating, setRotating] = useState(false);
  const logs = useApi<LogRow[]>("/api/logs?limit=100");
  const saved = useApi<SavedModel[]>("/api/models");
  const combos = useApi<Combo[]>("/api/combos");
  const keyInfo = useApi<ApiKeyInfo>("/api/key");
  const chosen = [...(saved.data ?? [])].sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).map((m) => m.spec);
  const comboList = combos.data ?? [];
  const comboMap = new Map(comboList.map((c) => [c.name, c] as const));
  const lastUsed = (logs.data ?? []).find((l) => l.status === "200 OK");
  const fallbackModel = chosen[0] ?? (lastUsed ? `${lastUsed.provider}/${lastUsed.model}` : "openai/gpt-4o");
  const validIds = new Set([...chosen, ...comboList.map((c) => c.name)]);
  const model = selectedModel && validIds.has(selectedModel) ? selectedModel : fallbackModel;
  const activeCombo = comboMap.get(model) ?? null;
  const key = keyInfo.data?.key ?? KEY_PLACEHOLDER;

  const rotate = async () => {
    setRotating(true);
    try {
      await api<ApiKeyInfo>("/api/key/rotate", { method: "POST" });
      keyInfo.refetch();
    } finally {
      setRotating(false);
    }
  };

  const toggleAuth = async (on: boolean) => {
    await api<ApiKeyInfo>("/api/key", { method: "PUT", body: JSON.stringify({ on }) });
    keyInfo.refetch();
  };

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
            troy exposes an OpenAI-compatible API + Anthropic /v1/messages — point Claude Code, Hermes, Codex CLI,
            Cursor, or OpenCode at it. Every snippet below carries your troy api key; rotate it here and the configs
            update automatically. Each card also shows how to add the config manually.
          </CardDescription>
          <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/40 px-3 py-2">
            <KeyRound className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="text-[11px] font-medium">troy api key</span>
            <code className="min-w-0 flex-1 truncate font-mono text-[11px]">{key}</code>
            <CopyButton what="troy key" text={key} label="copy troy api key" />
            <Button
              variant="outline"
              size="sm"
              className="h-6 gap-1 px-2 text-[11px]"
              onClick={rotate}
              disabled={rotating || !keyInfo.data}
              title="generate a new api key — old key stops working immediately"
            >
              <RefreshCw className={cn("size-3", rotating && "animate-spin")} />
              rotate
            </Button>
            <label
              htmlFor="troy-key-switch"
              className="flex cursor-pointer items-center gap-1.5 text-[11px] text-muted-foreground"
            >
              <Switch
                id="troy-key-switch"
                checked={keyInfo.data?.on === 1}
                onCheckedChange={toggleAuth}
                disabled={!keyInfo.data}
                aria-label="require troy api key on /v1 requests"
              />
              require key
            </label>
          </div>
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
              <SelectTrigger
                size="sm"
                className="h-7 font-mono text-[11px]"
                aria-label="primary model for CLI snippets"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {validIds.size > 0 ? (
                  <>
                    {comboList.length > 0 && (
                      <SelectGroup>
                        <SelectLabel className="flex items-center gap-1.5">
                          <Layers className="size-3" />
                          Combos
                        </SelectLabel>
                        {comboList.map((c) => (
                          <SelectItem key={c.name} value={c.name} className="font-mono text-xs">
                            {c.name}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    )}
                    {chosen.length > 0 && (
                      <SelectGroup>
                        <SelectLabel>Models</SelectLabel>
                        {chosen.map((spec) => (
                          <SelectItem key={spec} value={spec} className="font-mono text-xs">
                            {spec}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    )}
                    {comboList.length === 0 && chosen.length === 0 && (
                      <SelectItem value={fallbackModel} className="font-mono text-xs">
                        {fallbackModel}
                      </SelectItem>
                    )}
                  </>
                ) : (
                  <SelectItem value={fallbackModel} className="font-mono text-xs">
                    {fallbackModel}
                  </SelectItem>
                )}
              </SelectContent>
            </Select>
          </div>
          {activeCombo ? (
            <div className="flex flex-wrap items-center gap-1.5 pt-1">
              <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                <Layers className="size-3" />
                {activeCombo.name} →
              </span>
              {activeCombo.models.map((m, i) => (
                <span key={m} className="flex items-center gap-1.5">
                  {i > 0 && <ArrowRight className="size-3 text-muted-foreground" />}
                  <Badge variant="secondary" className="font-mono text-[11px] font-normal">
                    {m}
                  </Badge>
                </span>
              ))}
              <span className="text-[11px] text-muted-foreground">
                — snippets use <span className="font-mono text-foreground">{model}</span>
                {model.includes("/") ? "" : " (combo name — proxy fans out)"}
                {(() => {
                  const snippet = CLI_TOOLS.find((t) => t.name === "OpenCode")?.code(base, model, chosen, key);
                  return snippet?.includes(`troy/${model}`) ? ` / OpenCode: troy/${model}` : "";
                })()}
              </span>
            </div>
          ) : null}
          <p className="text-[11px] text-muted-foreground">
            {activeCombo
              ? `Combo selected — ${activeCombo.models.length} models in fallback order. All 5 tools receive \`${model}\`; the proxy expands it.`
              : chosen.length > 0
                ? `OpenCode lists every chosen model; Claude Code gets main + fast model; Hermes, Codex, and Cursor take one model — ${model}.`
                : lastUsed
                  ? `no chosen models yet — snippets use your last-used model ${model}. Pick models in the providers page and they appear here automatically.`
                  : `no chosen models or usage yet — snippets use ${model} until you pick models in the providers page.`}
          </p>
        </CardHeader>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        {CLI_TOOLS.map((t) => (
          <ToolCard key={t.name} t={t} base={base} model={model} all={chosen} key_={key} />
        ))}
      </div>
    </div>
  );
}

/** One CLI integration card: copiable config snippet + expandable hand-edit recipe. */
function ToolCard({
  t,
  base,
  model,
  all,
  key_,
}: {
  t: CliTool;
  base: string;
  model: string;
  all: string[];
  key_: string;
}) {
  const [manualOpen, setManualOpen] = useState(false);
  const code = t.code(base, model, all, key_);
  const manual = t.manual(base, model, all, key_);
  return (
    <Card>
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
              "whitespace-pre [&::-webkit-scrollbar]:w-1.5",
            )}
          >
            <code>{code}</code>
          </pre>
          <span className="absolute top-2 right-2 rounded bg-background/80 px-1.5 py-0.5 font-mono text-[9px] tracking-widest text-muted-foreground uppercase">
            {t.lang}
          </span>
        </div>

        <div className="mt-2 flex items-center justify-between border-t border-border/60 pt-2">
          <button
            type="button"
            onClick={() => setManualOpen((v) => !v)}
            aria-expanded={manualOpen}
            className="flex items-center gap-1 rounded px-1 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
          >
            <ChevronDown className={cn("size-3.5 transition-transform", manualOpen && "rotate-180")} />
            how to add manually
          </button>
          {manualOpen ? (
            <CopyButton what={`manual:${t.name}`} text={manual} label={`copy ${t.name} manual setup`} />
          ) : null}
        </div>
        {manualOpen ? (
          <div className="relative mt-2">
            <pre
              className={cn(
                "max-h-56 overflow-auto rounded-md border border-border bg-background/60 p-3 font-mono text-[11px] leading-relaxed",
                "whitespace-pre [&::-webkit-scrollbar]:w-1.5",
              )}
            >
              <code>{manual}</code>
            </pre>
            <span className="absolute top-2 right-2 rounded bg-background/80 px-1.5 py-0.5 font-mono text-[9px] tracking-widest text-muted-foreground uppercase">
              {t.manualLang ?? "bash"}
            </span>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
