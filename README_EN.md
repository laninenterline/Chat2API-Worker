# Chat2API Worker

![CI](https://github.com/laninenterline/Chat2API/actions/workflows/ci.yml/badge.svg) ![License](https://img.shields.io/badge/license-GPL--3.0-blue) ![Platform](https://img.shields.io/badge/platform-Cloudflare%20Workers-orange)

中文 | [English](README_EN.md)


A single **Cloudflare Worker** exposing **DeepSeek / GLM / MiniMax** web models through
**OpenAI ChatCompletions**, **Anthropic Messages** and **OpenAI Responses** compatible APIs.

Extracted and merged from the Node slim repos
([DeepSeek-Free-API](https://github.com/laninenterline/DeepSeek-Free-API),
[GLM-Free-API](https://github.com/laninenterline/GLM-Free-API),
[MiniMax-Free-API](https://github.com/laninenterline/MiniMax-Free-API)).
The GLM adapter reuses the Workers-verified implementation from the HelloGML family.

> **License: GPL-3.0** (inherited). Unofficial web endpoints — unstable, personal/research use only, ban risk.

## Branches

The four related projects are merged into this repository, one per branch
(the original standalone repositories are kept and can be archived later):

| Branch | Content |
|---|---|
| [`main`](https://github.com/laninenterline/Chat2API) | Three-in-one Cloudflare Worker (default) |
| [`deepseek`](https://github.com/laninenterline/Chat2API/tree/deepseek) | DeepSeek single-provider Node edition |
| [`glm`](https://github.com/laninenterline/Chat2API/tree/glm) | GLM single-provider Node edition |
| [`minimax`](https://github.com/laninenterline/Chat2API/tree/minimax) | MiniMax single-provider Node edition |
| [`deepseek-worker`](https://github.com/laninenterline/Chat2API/tree/deepseek-worker) | DeepSeek single-provider Worker edition |
| [`glm-worker`](https://github.com/laninenterline/Chat2API/tree/glm-worker) | GLM single-provider Worker edition |
| [`minimax-worker`](https://github.com/laninenterline/Chat2API/tree/minimax-worker) | MiniMax single-provider Worker edition |

## Features

- Four protocol front-ends: `/v1/chat/completions`, `/v1/messages`, `/v1/responses`, `/v1beta/models/*` (Gemini)
- `/v1/models` returns an Anthropic-shaped list when `anthropic-version` is present
- DeepSeek (wasm PoW), GLM (signed requests), MiniMax (device register + polling)
- KV-backed multi-account pool with `round-robin` / `fill-first` / `failover` and 60s failure cooldown
- Model mappings with `*` wildcards (`claude-*`, `gpt-*`, ...)
- Tool calling via prompt injection + output parsing (bracket / XML / Anthropic / JSON formats)
- Admin API `/admin/api/*` with masked credentials
- No Node.js runtime dependencies (wasm bundled with `CompiledWasm`)

## Deploy

One-shot script:

```bash
export CLOUDFLARE_API_TOKEN=...      # Workers + KV edit
export API_KEYS="sk-a,sk-b"          # optional
export ADMIN_KEY="your-admin-key"    # optional
./scripts/deploy.sh                  # creates/binds KV, puts secrets, deploys
```

Manual:

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
npm test           # 14 unit tests (tools, OpenAI/Anthropic/Responses/Gemini converters, store, GLM adapter)
npm run build      # wrangler dry-run bundle check
```

## Limitations

- Tool calling is buffered: when `tools` are present the full answer is collected and parsed before emitting `tool_calls` (SSE stays valid, but not incremental).
- Text only (no image / video / audio generation).
- MiniMax needs credits; single-turn new conversation only.
- Web endpoints may change at any time.

## License & credits

GPL-3.0, derived from [xiaoY233/Chat2API](https://github.com/xiaoY233/Chat2API);
GLM adapter from the [HelloGML](https://github.com/LLM-Red-Team/glm-free-api) family;
protocol/tool layers reused from the `chat2api-slim` Node edition.
Not affiliated with DeepSeek / Zhipu / MiniMax.
