import type { ProviderId } from './types.ts'
import type { Store } from './store.ts'
import { json, CORS_HEADERS } from './protocols.ts'
import { PROVIDER_CATALOG } from './providers/catalog.ts'
import { allCatalogModelIds } from './providers/catalog.ts'

const PROVIDER_IDS: ProviderId[] = ['deepseek', 'glm', 'minimax']

function maskKeys(keys: string[]): string[] {
  return keys.map((k) => (k.length > 8 ? `${k.slice(0, 3)}***${k.slice(-3)}` : '***'))
}

/** /admin/api/* 管理接口 + 一个极简 HTML 面板 */
export async function handleAdmin(request: Request, url: URL, store: Store): Promise<Response> {
  const path = url.pathname.replace(/\/+$/, '')
  const method = request.method

  if (path === '/admin') return new Response(ADMIN_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8', ...CORS_HEADERS } })

  const parts = path.split('/').filter(Boolean) // ['admin','api','accounts','id']
  if (parts[1] !== 'api') return json({ error: { message: 'Not found' } }, 404)
  const resource = parts[2]
  const id = parts[3]

  if (resource === 'status' && method === 'GET') {
    const cfg = await store.config()
    const accounts = await store.accounts()
    const byProvider: Record<string, number> = {}
    for (const account of accounts) byProvider[account.provider] = (byProvider[account.provider] || 0) + 1
    return json({
      service: 'chat2api-worker',
      version: '1.0.0',
      strategy: cfg.strategy,
      auth: { apiKeys: cfg.apiKeys.length, adminKey: Boolean(cfg.adminKey) },
      accounts: { total: accounts.length, byProvider },
      providers: PROVIDER_CATALOG.map((p) => ({ id: p.id, name: p.name, models: p.models })),
      models: allCatalogModelIds(),
      modelMappings: cfg.modelMappings,
      stats: store.snapshot().stats,
    })
  }

  if (resource === 'config') {
    if (method === 'GET') {
      const cfg = await store.config()
      return json({ strategy: cfg.strategy, apiKeys: maskKeys(cfg.apiKeys), adminKey: cfg.adminKey ? '***' : '', modelMappings: cfg.modelMappings })
    }
    if (method === 'POST') {
      const body: any = await request.json().catch(() => null)
      if (!body) return json({ error: { message: 'Invalid JSON body' } }, 400)
      const current: any = (await store.env.KV.get('config', 'json')) || {}
      const next = {
        ...current,
        ...(body.apiKeys !== undefined ? { apiKeys: body.apiKeys } : {}),
        ...(body.adminKey !== undefined ? { adminKey: body.adminKey } : {}),
        ...(body.strategy !== undefined ? { strategy: body.strategy } : {}),
        ...(body.modelMappings !== undefined ? { modelMappings: body.modelMappings } : {}),
      }
      await store.env.KV.put('config', JSON.stringify(next))
      store.invalidate()
      return json({ ok: true, config: { strategy: next.strategy || 'round-robin', modelMappings: next.modelMappings || {} } })
    }
    return json({ error: { message: 'Method not allowed' } }, 405)
  }

  if (resource === 'accounts') {
    if (!id && method === 'GET') return json(await store.accountsSnapshot())

    if (!id && method === 'POST') {
      const body: any = await request.json().catch(() => null)
      if (!body?.provider || !body?.credentials) {
        return json({ error: { message: 'Body must contain provider and credentials' } }, 400)
      }
      if (!PROVIDER_IDS.includes(body.provider)) {
        return json({ error: { message: `provider must be one of: ${PROVIDER_IDS.join(', ')}` } }, 400)
      }
      const account = await store.addAccount({
        provider: body.provider,
        credentials: body.credentials,
        name: body.name,
        id: body.id,
      })
      return json({ ok: true, account: { ...account, credentials: undefined } })
    }

    if (id && method === 'PATCH') {
      const body: any = await request.json().catch(() => null)
      if (!body) return json({ error: { message: 'Invalid JSON body' } }, 400)
      const updated = await store.updateAccount(id, {
        ...(body.credentials ? { credentials: body.credentials } : {}),
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.status !== undefined ? { status: body.status } : {}),
      })
      if (!updated) return json({ error: { message: 'Account not found' } }, 404)
      return json({ ok: true, account: { ...updated, credentials: undefined } })
    }

    if (id && method === 'DELETE') {
      const removed = await store.removeAccount(id)
      if (!removed) return json({ error: { message: 'Account not found' } }, 404)
      return json({ ok: true })
    }

    return json({ error: { message: 'Method not allowed' } }, 405)
  }

  return json({ error: { message: 'Not found' } }, 404)
}

const ADMIN_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>Chat2API Worker 管理</title>
<style>body{font-family:system-ui,sans-serif;max-width:760px;margin:40px auto;padding:0 16px;color:#222}
code{background:#f3f3f3;padding:2px 5px;border-radius:4px}pre{background:#f7f7f7;padding:12px;overflow:auto}
button{padding:6px 12px;margin-left:8px}</style></head><body>
<h2>Chat2API Worker</h2>
<p>状态接口：<code>GET /admin/api/status</code>（需 <code>ADMIN_KEY</code> 或任一 API Key）</p>
<ul>
<li><code>GET /admin/api/accounts</code> 账号列表（脱敏）</li>
<li><code>POST /admin/api/accounts</code> 添加账号：<pre>{"provider":"deepseek|glm|minimax","name":"可选","credentials":{...}}</pre></li>
<li><code>PATCH /admin/api/accounts/:id</code> 改凭证/状态</li>
<li><code>DELETE /admin/api/accounts/:id</code> 删除账号</li>
<li><code>GET/POST /admin/api/config</code> 查看/修改策略、API Key、模型映射</li>
</ul>
<p>示例（添加 GLM 账号）：</p>
<pre>curl -X POST http://&lt;worker&gt;/admin/api/accounts \\
  -H "Authorization: Bearer $ADMIN_KEY" -H "Content-Type: application/json" \\
  -d '{"provider":"glm","name":"glm-1","credentials":{"refresh_token":"..."}}'</pre>
</body></html>`
