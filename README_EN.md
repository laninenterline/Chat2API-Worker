# Chat2API Worker

A single **Cloudflare Worker** exposing **DeepSeek / GLM / MiniMax** web models through
**OpenAI ChatCompletions**, **Anthropic Messages** and **OpenAI Responses** compatible APIs.

Extracted and merged from the Node slim repos
([DeepSeek-Free-API](https://github.com/laninenterline/DeepSeek-Free-API),
[GLM-Free-API](https://github.com/laninenterline/GLM-Free-API),
[MiniMax-Free-API](https://github.com/laninenterline/MiniMax-Free-API)).
The GLM adapter reuses the Workers-verified implementation from the HelloGML family.

> **License: GPL-3.0** (inherited). Unofficial web endpoints — unstable, personal/research use only, ban risk.

## Features

- Three protocol front-ends: `/v1/chat/completions`, `/v1/messages`, `/v1/responses`
- DeepSeek (wasm PoW), GLM (signed requests), MiniMax (device register + polling)
- KV-backed multi-account pool with `round-robin` / `fill-first` / `failover` and 60s failure cooldown
- Model mappings with `*` wildcards (`claude-*`, `gpt-*`, ...)
- Tool calling via prompt injection + output parsing (bracket / XML / Anthropic / JSON formats)
- Admin API `/admin/api/*` with masked credentials
- No Node.js runtime dependencies (wasm bundled with `CompiledWasm`)

## Deploy

```bash
npm install
npx wrangler login
npx wrangler kv namespace create KV      # put the id into wrangler.toml
npx wrangler secret put API_KEYS         # "sk-a,sk-b"
npx wrangler secret put ADMIN_KEY
npm run deploy
```

Add accounts:

```bash
BASE=https://chat2api-worker.<you>.workers.dev; KEY=your-admin-key
curl -X POST $BASE/admin/api/accounts -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"provider":"deepseek","credentials":{"token":"<userToken>"}}'
curl -X POST $BASE/admin/api/accounts -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"provider":"glm","credentials":{"refresh_token":"<refresh_token>"}}'
curl -X POST $BASE/admin/api/accounts -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"provider":"minimax","credentials":{"token":"<jwt>","realUserID":"<id>"}}'
```

## Clients

```bash
# Claude Code
export ANTHROPIC_BASE_URL=https://chat2api-worker.xxx.workers.dev
export ANTHROPIC_AUTH_TOKEN=sk-your-key
export ANTHROPIC_MODEL=GLM-5.3

# Codex CLI (~/.codex/config.toml)
model = "GLM-5.3"
model_provider = "worker"
[model_providers.worker]
base_url = "https://chat2api-worker.xxx.workers.dev/v1"
wire_api = "responses"
env_key = "WORKER_API_KEY"

# OpenAI SDK
client = OpenAI(base_url="https://chat2api-worker.xxx.workers.dev/v1", api_key="sk-your-key")
```

## Tests

```bash
npm run typecheck
npm test           # 11 unit tests (tools, converters, store, GLM adapter with mocked fetch)
npm run build      # wrangler dry-run bundle check
```

## Limitations

- Tool calling is buffered: when `tools` are present the full answer is collected and parsed before emitting `tool_calls` (SSE stays valid, but not incremental).
- Text only (no image / video / audio generation).
- No Gemini endpoint (OpenAI / Anthropic / Responses cover DSH, Claude Code, Codex).
- MiniMax needs credits; single-turn new conversation only.
- Web endpoints may change at any time.

## License & credits

GPL-3.0, derived from [xiaoY233/Chat2API](https://github.com/xiaoY233/Chat2API);
GLM adapter from the [HelloGML](https://github.com/LLM-Red-Team/glm-free-api) family;
protocol/tool layers reused from the `chat2api-slim` Node edition.
Not affiliated with DeepSeek / Zhipu / MiniMax.
