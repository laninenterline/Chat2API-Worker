# DeepSeek Free API (slim)

[DeepSeek](https://chat.deepseek.com) web app → **OpenAI ChatCompletions / Anthropic Messages / OpenAI Responses** compatible API.

A **single-provider slim edition** extracted from [xiaoY233/Chat2API](https://github.com/xiaoY233/Chat2API) (an Electron desktop app, GPL-3.0):
plain Node service, no GUI, only the DeepSeek provider, easy to read and modify.
Works with Claude Code, DeepSeek Harness (DSH), Codex CLI and any OpenAI-compatible client.

> **License: GPL-3.0** (inherited from upstream). For personal / research use only.
> Reverse-engineered web APIs are unstable and may get your account banned; please use the official API for commercial use.

## Models

| Model ID | Display name |
|---|---|
| `deepseek-v4.1-flash` | DeepSeek V4.1-Flash |

The model name is mostly a routing/display label — the web endpoints decide the actual model.
Common client model names are pre-mapped: `deepseek-flash / deepseek-v4-flash / deepseek-v4-pro / claude-* / gpt-*`.

## Features

- Three protocol entry points: `/v1/chat/completions`, `/v1/messages` (Claude Code / DSH), `/v1/responses` (Codex)
- Streaming, tool calling (prompt injection + multi-format parsing)
- Model mapping with wildcards, multi-account round-robin / fill-first / failover
- Context management (sliding window / token limit / summary)
- Management API `/v0/management/*`
- Runs on Docker and Termux

## Quick start

```bash
npm install
cp config.example.json config.json   # fill in your token
npm start                            # http://127.0.0.1:8080
```


### Get the token

Log in to chat.deepseek.com → F12 → Application → Local Storage → `userToken`, then set it as the `token` credential.

### Node.js compatibility

| Node version | Status |
|---|---|
| 18 (EOL) | ✅ Code compatible, covered by CI |
| 20 LTS | ✅ Covered by CI |
| 22 LTS | ✅ Covered by CI (recommended) |
| 24 LTS | ✅ Covered by CI |

The start script uses the project-local `tsx` (no `node --import`), so Node 18 works too; `npm start` is equivalent.
Docker builds accept `--build-arg NODE_VERSION=20` / `22` / `24` to switch the base image (default: 22).

## Docker

```bash
cp config.example.json config.json     # fill in your token
docker build -t deepseek-free-api .
docker run -d --name deepseek-free-api -p 8080:8080 \
  -v $PWD/config.json:/app/config.json deepseek-free-api
```

- Switch the base image: `docker build --build-arg NODE_VERSION=20|22|24 -t deepseek-free-api .` (default 22)
- The image ships a `HEALTHCHECK` (`wget /health`), visible in `docker ps`
- `docker compose up -d` also works (a `docker-compose.yml` is included)
- `config.json` must be **writable** (GLM writes back a refreshed token), so do not mount it with `:ro`
- `HOST` / `PORT` environment variables override the listen address (the image defaults to `HOST=0.0.0.0`, otherwise published ports cannot reach it)
- To run as non-root: `--user 1000:1000` and make sure the host `config.json` is owned by uid 1000

Prebuilt images are published to GHCR by GitHub Actions (triggered by `v*` tags, amd64/arm64):

```bash
docker pull ghcr.io/laninenterline/deepseek-free-api:latest
# or a pinned version
docker pull ghcr.io/laninenterline/deepseek-free-api:1.0.6
```

## Client setup

**Claude Code**

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8080
export ANTHROPIC_AUTH_TOKEN=sk-local-test
export ANTHROPIC_MODEL=deepseek-v4.1-flash
claude
```

**DeepSeek Harness (DSH)** — `~/.dsh/profiles/<profile>/cordis.patch.yml`

```yaml
- id: llm-deepseek
  name: "@deepseek-ai/dsh-llm-deepseek-api-key"
  config:
    baseURL: http://127.0.0.1:8080
    apiKeyEnv: SLIM_API_KEY
    models:
      - id: deepseek-v4.1-flash
```

Add `SLIM_API_KEY: sk-local-test` to `refs` in `~/.dsh/.credentials.yaml`.

**Codex CLI** — `~/.codex/config.toml`

```toml
model = "deepseek-v4.1-flash"
model_provider = "slim"
[model_providers.slim]
base_url = "http://127.0.0.1:8080/v1"
wire_api = "responses"
env_key = "SLIM_API_KEY"
```

**OpenAI SDK**

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8080/v1", api_key="sk-local-test")
print(client.chat.completions.create(model="deepseek-v4.1-flash", messages=[{"role": "user", "content": "hi"}]).choices[0].message.content)
```

## Configuration

| Field | Description |
|---|---|
| `host` / `port` | Listen address, default `127.0.0.1:8080` |
| `apiKeys` | Keys for `/v1/*` (`Authorization: Bearer` or `x-api-key`); empty = no auth |
| `adminKey` | Management API key; empty = `/v0/management` returns 404 |
| `loadBalanceStrategy` | `round-robin` / `fill-first` / `failover` |
| `mode` | `single` (delete upstream session after each request) / `multi` |
| `modelMappings` | Alias → real model, wildcards supported |
| `accounts` | Account list; multiple accounts are load-balanced |

## Management API

Auth: `X-Admin-Key` or `Authorization: Bearer <adminKey>`

| Method | Path | Description |
|---|---|---|
| GET/POST | `/v0/management/accounts` | List / add accounts |
| PATCH/DELETE | `/v0/management/accounts/:id` | Update credentials / delete |
| GET | `/v0/management/providers` | Providers and models |
| GET | `/v0/management/models` | All models |
| GET | `/v0/management/stats` | Request statistics |
| GET | `/v0/management/logs` | Recent request logs |
| GET/PATCH | `/v0/management/config` | Read / hot-update config |

`GET /health` and `GET /stats` are also available.

## Verification

✅ Tested with a real account: non-streaming, streaming and tool calling (tool_use + input_json_delta).

```bash
npx tsc --noEmit           # type check
npm test                   # protocol conversion tests
bash scripts/smoke-test.sh # smoke test (service must be running)
```

- DeepSeek web uses a proof-of-work challenge; the bundled `assets/sha3_wasm_bg.7b9ca65ddd.wasm` is required.
- Re-copy `userToken` from the browser when it expires.

## License & credits

- Derived from [xiaoY233/Chat2API](https://github.com/xiaoY233/Chat2API), licensed under **GPL-3.0**. See [LICENSE](LICENSE).
- Chat2API itself builds on the [LLM-Red-Team](https://github.com/LLM-Red-Team) projects; thanks to the original authors.
- Not affiliated with DeepSeek. Use at your own risk and respect the target site's terms of service.
