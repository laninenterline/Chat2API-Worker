# MiniMax Free API — Cloudflare Worker edition

MiniMax web app → **OpenAI / Anthropic / Responses / Gemini** compatible API, running on a single Cloudflare Worker.

This is the **single-provider Worker edition** of [MiniMax-Free-API](https://github.com/laninenterline/MiniMax-Free-API),
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
| MiniMax-M3.1-Flash | MiniMax-M2.7 |

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
curl -X POST https://minimax-free-api.<subdomain>.workers.dev/admin/api/accounts \
  -H "Authorization: Bearer $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"provider":"minimax","credentials":{"token":"<jwt>","realUserID":"<id>"}}'
```

## Tests

```bash
npm run typecheck
npm test
npm run build
```

## License & credits

GPL-3.0, derived from [Chat2API-Worker](https://github.com/laninenterline/Chat2API-Worker) /
[xiaoY233/Chat2API](https://github.com/xiaoY233/Chat2API).
