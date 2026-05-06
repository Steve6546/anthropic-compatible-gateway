# Anthropic-Compatible Gateway for openai-oauth

Local-only gateway for running Claude Code against an `openai-oauth` OpenAI-compatible localhost endpoint.

```text
Claude Code -> local gateway -> openai-oauth -> Codex/ChatGPT subscription OAuth
```

This project does not use OpenAI Platform API keys, does not use `sk-*` keys, does not read or copy `~/.codex/auth.json`, does not store OAuth tokens, and does not modify Claude Code. It is for personal localhost use only.

## One Command

Run everything and open Claude Code:

```powershell
cd "C:\Users\dlwta\OneDrive\Documents\New project 19"
npm run start:all
```

Run everything without opening Claude Code:

```powershell
npm run start:all -- -NoClaude
```

Restart both local services cleanly:

```powershell
npm run start:all -- -Restart
```

Stop both local services:

```powershell
npm run stop:all
```

## What Starts

| Service | Address | Purpose |
| --- | --- | --- |
| `openai-oauth` | `http://127.0.0.1:10531/v1` | Local OpenAI-compatible OAuth-backed endpoint |
| gateway | `http://127.0.0.1:4000` | Anthropic-compatible API for Claude Code |
| Claude Code | `claude-gpt-5-3-codex` | Default project agent model alias |

The startup script sets:

```powershell
$env:ANTHROPIC_BASE_URL="http://127.0.0.1:4000"
$env:ANTHROPIC_AUTH_TOKEN="my-secret-gateway-token"
$env:ANTHROPIC_MODEL="claude-gpt-5-3-codex"
```

Project defaults are also stored in `.claude/settings.json`, so this also works after services are running:

```powershell
cd "C:\Users\dlwta\OneDrive\Documents\New project 19"
claude
```

## Models

These model names are exposed:

| Claude Code alias | OpenAI-compatible model |
| --- | --- |
| `GPT-5.5` | `gpt-5.5` |
| `GPT-5.5 Instant` | `gpt-5.5` |
| `GPT-5.4` | `gpt-5.4` |
| `gpt-5.3-codex` | `gpt-5.3-codex` |
| `claude-gpt-5-5` | `gpt-5.5` |
| `claude-gpt-5-4` | `gpt-5.4` |
| `claude-gpt-5-3-codex` | `gpt-5.3-codex` |

Default:

```text
claude-gpt-5-3-codex -> gpt-5.3-codex
```

There is no GPT-4 or `gpt-4o` fallback. If a selected model is unavailable, the gateway returns:

```text
The requested OpenAI model is not available on this account or API.
```

## MCP

The project includes `.mcp.json` with a project-scoped filesystem MCP server:

```text
filesystem -> C:\Users\dlwta\OneDrive\Documents\New project 19
```

Check MCP health:

```powershell
claude mcp list
```

Expected result:

```text
filesystem ... Connected
```

## API

The gateway exposes only:

- `GET /v1/models`
- `POST /v1/messages`
- `POST /v1/messages/count_tokens`

It authenticates requests with:

```text
Authorization: Bearer my-secret-gateway-token
```

## Tests

Unit tests:

```powershell
npm test
```

Full integration and load test:

```powershell
npm run test:all
```

Custom load settings:

```powershell
npm run test:all -- -Requests 20 -Concurrency 4
```

The full test checks:

- `openai-oauth /v1/models`
- gateway `/v1/models`
- gateway `/v1/messages/count_tokens`
- gateway non-streaming messages
- gateway SSE streaming messages
- MCP filesystem health
- Claude Code CLI through the gateway
- concurrent gateway requests

The latest report is written to:

```text
latest-test-report.json
```

## Curl Checks

Models:

```powershell
curl.exe -s http://127.0.0.1:4000/v1/models `
  -H "Authorization: Bearer my-secret-gateway-token"
```

Message:

```powershell
$body = @{
  model = "claude-gpt-5-3-codex"
  max_tokens = 128
  stream = $false
  messages = @(@{ role = "user"; content = "Say hello in one sentence." })
} | ConvertTo-Json -Depth 10

Invoke-RestMethod `
  -Uri "http://127.0.0.1:4000/v1/messages" `
  -Method Post `
  -Headers @{ Authorization = "Bearer my-secret-gateway-token" } `
  -ContentType "application/json" `
  -Body $body
```

## Notes

- Gateway logs are written to `gateway.log`.
- Provider calls time out after 60 seconds.
- Streaming supports Anthropic SSE, including text and tool-use JSON deltas.
- Tool calls are translated for OpenAI-compatible chat and Responses formats.
- `count_tokens` uses a local estimate and does not call `openai-oauth`.
- Keep the gateway bound to localhost only.
