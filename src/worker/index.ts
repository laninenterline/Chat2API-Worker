import type { Env } from './types.ts'
import { Store } from './store.ts'
import { json, CORS_HEADERS } from './protocols.ts'
import {
  handleAnthropicCountTokens,
  handleAnthropicMessages,
  handleChatCompletions,
  handleHealth,
  handleModels,
  handleResponses,
} from './protocols.ts'
import { handleAdmin } from './admin.ts'

async function isAuthorized(request: Request, store: Store, admin: boolean): Promise<boolean> {
  const cfg = await store.config()
  const keys = (admin ? [cfg.adminKey, ...cfg.apiKeys] : cfg.apiKeys).filter(Boolean)

  const header = request.headers.get('authorization') || ''
  const bearer = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : ''
  const token = bearer || (request.headers.get('x-api-key') || '').trim()

  if (keys.length === 0) return true // 未配置 Key 时放开（与 Node 版一致）
  return keys.includes(token)
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    const store = new Store(env)

    try {
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS_HEADERS })
      }

      const path = url.pathname.replace(/\/+$/, '') || '/'
      const method = request.method

      if (path === '/' || path === '/health') return handleHealth(store)
      if (path === '/ping') return new Response('pong', { headers: CORS_HEADERS })

      if (path.startsWith('/v1/')) {
        if (!(await isAuthorized(request, store, false))) {
          return json({ error: { message: 'Invalid API key', type: 'authentication_error' } }, 401)
        }
      } else if (path.startsWith('/admin/api')) {
        if (!(await isAuthorized(request, store, true))) {
          return json({ error: { message: 'Invalid admin key' } }, 401)
        }
      }

      if (path === '/v1/chat/completions' && method === 'POST') return await handleChatCompletions(request, store)
      if (path === '/v1/responses' && method === 'POST') return await handleResponses(request, store)
      if (path === '/v1/models' && method === 'GET') return handleModels(store)
      if (path === '/v1/messages/count_tokens' && method === 'POST') return await handleAnthropicCountTokens(request)
      if ((path === '/v1/messages' || path === '/anthropic/v1/messages') && method === 'POST') {
        return await handleAnthropicMessages(request, store)
      }
      if (path.startsWith('/admin')) return await handleAdmin(request, url, store)

      return json({ error: { message: `Not found: ${method} ${path}` } }, 404)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return json({ error: { message } }, 500)
    }
  },
}
