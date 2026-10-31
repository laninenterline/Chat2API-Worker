# MiniMax Free API (slim)

[MiniMax](https://agent.minimax.cn) web app → **OpenAI ChatCompletions / Anthropic Messages / OpenAI Responses** compatible API.

A **single-provider slim edition** extracted from [xiaoY233/Chat2API](https://github.com/xiaoY233/Chat2API) (an Electron desktop app, GPL-3.0):
plain Node service, no GUI, only the MiniMax provider, easy to read and modify.
Works with Claude Code, DeepSeek Harness (DSH), Codex CLI and any OpenAI-compatible client.

> **License: GPL-3.0** (inherited from upstream). For personal / research use only.
> Reverse-engineered web APIs are unstable and may get your account banned; please use the official API for commercial use.

## Models

| Model ID | Display name |
|---|---|
| `MiniMax-M3.1-Flash` | MiniMax M3.1-Flash |

The model name is mostly a routing/display label — the web endpoints decide the actual model.
Common client model names are pre-mapped: `MiniMax-M2.7 / claude-* / gpt-*`.

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

Log in to agent.minimax.cn → F12 → Application → Local Storage → `_token` (also copy `realUserID` from `user_detail_agent` if available).

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
docker build -t minimax-free-api .
docker run -d --name minimax-free-api -p 8080:8080 \
  -v $PWD/config.json:/app/config.json minimax-free-api
```

- Switch the base image: `docker build --build-arg NODE_VERSION=20|22|24 -t minimax-free-api .` (default 22)
- The image ships a `HEALTHCHECK` (`wget /health`), visible in `docker ps`
- `docker compose up -d` also works (a `docker-compose.yml` is included)
- `config.json` must be **writable** (GLM writes back a refreshed token), so do not mount it with `:ro`
- `HOST` / `PORT` environment variables override the listen address (the image defaults to `HOST=0.0.0.0`, otherwise published ports cannot reach it)
- To run as non-root: `--user 1000:1000` and make sure the host `config.json` is owned by uid 1000

Prebuilt images are published to GHCR by GitHub Actions (triggered by `v*` tags, amd64/arm64):

```bash
docker pull ghcr.io/laninenterline/minimax-free-api:latest
# or a pinned version
docker pull ghcr.io/laninenterline/minimax-free-api:1.0.6
```

## Client setup

**Claude Code**

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8080
export ANTHROPIC_AUTH_TOKEN=sk-local-test
export ANTHROPIC_MODEL=MiniMax-M3.1-Flash
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
      - id: MiniMax-M3.1-Flash
```

Add `SLIM_API_KEY: sk-local-test` to `refs` in `~/.dsh/.credentials.yaml`.

**Codex CLI** — `~/.codex/config.toml`

```toml
model = "MiniMax-M3.1-Flash"
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
print(client.chat.completions.create(model="MiniMax-M3.1-Flash", messages=[{"role": "user", "content": "hi"}]).choices[0].message.content)
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

⚠️ Protocol chain verified (`device/register` 200, `send_msg` 200), but the test account had zero credits and the upstream returned "积分不足". Works as soon as the account has credits.

```bash
npx tsc --noEmit           # type check
npm test                   # protocol conversion tests
bash scripts/smoke-test.sh # smoke test (service must be running)
```

- MiniMax web has migrated to `agent.minimax.cn` (the old `agent.minimaxi.com` only 302-redirects); this repo targets `.cn`.
- The account needs MiniMax credits, otherwise requests fail with `积分不足` (insufficient credits).

## License & credits

- Derived from [xiaoY233/Chat2API](https://github.com/xiaoY233/Chat2API), licensed under **GPL-3.0**. See [LICENSE](LICENSE).
- Chat2API itself builds on the [LLM-Red-Team](https://github.com/LLM-Red-Team) projects; thanks to the original authors.
- Not affiliated with MiniMax. Use at your own risk and respect the target site's terms of service.
