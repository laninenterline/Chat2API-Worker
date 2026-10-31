# GLM Free API — Cloudflare Worker edition

GLM web app → **OpenAI / Anthropic / Responses / Gemini** compatible API, running on a single Cloudflare Worker.

This is the **single-provider Worker edition** of [the glm branch of Chat2API](https://github.com/laninenterline/Chat2API/tree/glm),
kept on the **`cf-worker` branch**; `main` holds the Node edition.

> **License: GPL-3.0**. Unofficial endpoints — personal/research use only, ban risk.

## Features

- `/v1/chat/completions`, `/v1/messages`, `/v1/responses`, `/v1beta/models/*` (Gemini)
- Anthropic-shaped `/v1/models` when `anthropic-version` is present
- KV multi-account pool (round-robin / fill-first / failover, 60s failure cooldown)
- Model mappings with wildcards, tool calling via prompt injection + parsing
- Admin API `/admin/api/*` and a minimal `/admin` panel

## Model

| Model ID | Aliases |
|---|---|
| GLM-5.3-Flash | GLM-5.1, glm-4, glm-4-flash |

## Deploy

```bash
npm install
npx wrangler login
npx wrangler kv namespace create KV
npx wrangler secret put API_KEYS
npx wrangler secret put ADMIN_KEY
npm run deploy
```

Add an account:

```bash
curl -X POST https://glm-free-api.<subdomain>.workers.dev/admin/api/accounts \
  -H "Authorization: Bearer $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"provider":"glm","credentials":{"refresh_token":"<refresh_token>"}}'
```

## Tests

```bash
npm run typecheck
npm test
npm run build
```

## License & credits

GPL-3.0, derived from [Chat2API](https://github.com/laninenterline/Chat2API) /
[xiaoY233/Chat2API](https://github.com/xiaoY233/Chat2API).
