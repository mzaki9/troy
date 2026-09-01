# CLI tools — point anything OpenAI-compatible at troy

Troy is `http://localhost:31337/v1` (dashboard shows your live `troy api key`; rotate it there and snippets update). All snippets use that key — `Authorization: Bearer <key>` or `x-api-key`.

## Claude Code

```bash
export ANTHROPIC_BASE_URL=http://localhost:31337
export ANTHROPIC_AUTH_TOKEN=sk-troy-...
export ANTHROPIC_MODEL=openai/gpt-4o
claude
```

Manual `~/.claude/settings.json` via heredoc:
```bash
mkdir -p ~/.claude && cat > ~/.claude/settings.json << 'EOF'
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:31337",
    "ANTHROPIC_AUTH_TOKEN": "sk-troy-...",
    "ANTHROPIC_MODEL": "openai/gpt-4o"
  }
}
EOF
```

## Hermes

```yaml
model:
  default: "openai/gpt-4o"
  provider: "custom"
  base_url: "http://localhost:31337/v1"
  api_key: "sk-troy-..."
```
```bash
mkdir -p ~/.hermes && cat > ~/.hermes/config.yaml << 'EOF'
model:
  default: "openai/gpt-4o"
  provider: "custom"
  base_url: "http://localhost:31337/v1"
  api_key: "sk-troy-..."
EOF
```

## Codex CLI (responses API)

```toml
model_provider = "troy"
model = "openai/gpt-4o"

[model_providers.troy]
name = "Troy"
base_url = "http://localhost:31337/v1"
experimental_bearer_token = "sk-troy-..."
wire_api = "responses"
```
```bash
mkdir -p ~/.codex && cat > ~/.codex/config.toml << 'EOF'
model_provider = "troy"
model = "openai/gpt-4o"

[model_providers.troy]
name = "Troy"
base_url = "http://localhost:31337/v1"
experimental_bearer_token = "sk-troy-..."
wire_api = "responses"
EOF
```

## Cursor

In-app only (opaque SQLite):
1. Cursor → Settings → Models → Advanced (or Model → OpenAI API Key)
2. OpenAI API Base URL: `http://localhost:31337/v1`
3. OpenAI API Key: `sk-troy-...`
4. Model: `openai/gpt-4o`

## OpenCode

One-liner (live list, no snippet copy):
```bash
curl -X POST http://localhost:31337/api/install-opencode-plugin
# restart opencode, pick any troy/... model
```

Or global `~/.config/opencode/opencode.json`:
```bash
mkdir -p ~/.config/opencode && cat > ~/.config/opencode/opencode.json << 'EOF'
{
  "$schema": "https://opencode.ai/config.json",
  "model": "troy/openai/gpt-4o",
  "provider": {
    "troy": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Troy",
      "options": { "baseURL": "http://localhost:31337/v1", "apiKey": "sk-troy-..." },
      "models": { "openai/gpt-4o": { "name": "openai/gpt-4o", "modalities": { "input": ["text","image"], "output": ["text"] } } }
    }
  }
}
EOF
```

All snippets also work with combos (`my-combo` instead of `openai/gpt-4o`); the proxy fans out.

See `dashboard Tools` page for live snippets with your current key.
