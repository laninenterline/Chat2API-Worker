/**
 * 管理接口（slim 版）
 *
 * 上游对应：Chat2API `src/main/proxy/routes/management/*`（11 个模块，约 2100 行，带完整 CRUD）
 * 这里只保留自用最需要的几组：账号增删改查、供应商/模型查看、统计、日志、配置热更新。
 *
 * 鉴权：请求头 X-Admin-Key，或 Authorization: Bearer <adminKey>
 * 未在 config.json 里配置 adminKey 时，整个 /v0/management 返回 404（默认关闭）。
 */

import Router from '@koa/router'
import type { Context, Next } from 'koa'
import { storeManager } from '../../store/store'
import type { LoadBalanceStrategy } from '../../store/types'

const router = new Router({ prefix: '/v0/management' })

function unauthorized(ctx: Context): void {
  ctx.status = 401
  ctx.body = { success: false, error: { code: 'UNAUTHORIZED', message: 'Invalid admin key' } }
}

/** 管理接口鉴权中间件 */
async function adminAuth(ctx: Context, next: Next): Promise<void> {
  const adminKey = storeManager.getSlimConfig().adminKey
  if (!adminKey) {
    ctx.status = 404
    ctx.body = { success: false, error: { code: 'NOT_FOUND', message: 'Management API disabled' } }
    return
  }
  const fromHeader = ctx.headers['x-admin-key']
  const bearer = (ctx.headers.authorization || '').replace(/^Bearer\s+/i, '')
  if (fromHeader !== adminKey && bearer !== adminKey) {
    unauthorized(ctx)
    return
  }
  await next()
}

router.use(adminAuth)

function ok(ctx: Context, data: any): void {
  ctx.body = { success: true, data }
}

// ---------------------------------------------------------------------------
// 账号
// ---------------------------------------------------------------------------

router.get('/accounts', async (ctx: Context) => {
  const accounts = storeManager.getAccounts().map((account) => ({
    id: account.id,
    providerId: account.providerId,
    name: account.name,
    status: account.status,
    // 只回显凭据长度，不返回明文
    credentials: Object.fromEntries(
      Object.entries(account.credentials).map(([key, value]) => [key, value ? `***(${value.length} chars)` : ''])
    ),
    lastUsed: account.lastUsed,
    requestCount: account.requestCount,
    createdAt: account.createdAt,
  }))
  ok(ctx, { total: accounts.length, accounts })
})

router.post('/accounts', async (ctx: Context) => {
  const body = (ctx.request.body || {}) as { provider?: string; credentials?: Record<string, string>; name?: string }
  if (!body.provider || !body.credentials) {
    ctx.status = 400
    ctx.body = { success: false, error: { code: 'BAD_REQUEST', message: 'provider 和 credentials 必填' } }
    return
  }
  try {
    const account = storeManager.addAccount({
      provider: body.provider,
      credentials: body.credentials,
      name: body.name,
    })
    ok(ctx, { id: account.id, providerId: account.providerId })
  } catch (error) {
    ctx.status = 400
    ctx.body = {
      success: false,
      error: { code: 'ADD_ACCOUNT_FAILED', message: error instanceof Error ? error.message : 'unknown' },
    }
  }
})

router.patch('/accounts/:id', async (ctx: Context) => {
  const body = (ctx.request.body || {}) as { credentials?: Record<string, string>; status?: string }
  try {
    const account = storeManager.updateAccount(ctx.params.id, {
      ...(body.credentials ? { credentials: body.credentials } : {}),
      ...(body.status ? { status: body.status as any } : {}),
    })
    ok(ctx, { id: account.id, status: account.status })
  } catch (error) {
    ctx.status = 404
    ctx.body = { success: false, error: { code: 'NOT_FOUND', message: 'account not found' } }
  }
})

router.delete('/accounts/:id', async (ctx: Context) => {
  ok(ctx, { deleted: storeManager.deleteAccount(ctx.params.id) })
})

// ---------------------------------------------------------------------------
// 供应商 / 模型
// ---------------------------------------------------------------------------

router.get('/providers', async (ctx: Context) => {
  ok(
    ctx,
    storeManager.getProviders().map((provider) => ({
      id: provider.id,
      name: provider.name,
      enabled: provider.enabled,
      authType: provider.authType,
      apiEndpoint: provider.apiEndpoint,
      accounts: storeManager.getAccountsByProviderId(provider.id).length,
      models: storeManager.getEffectiveModels(provider.id),
    }))
  )
})

router.get('/models', async (ctx: Context) => {
  const models = storeManager
    .getProviders()
    .filter((provider) => provider.enabled)
    .flatMap((provider) =>
      storeManager.getEffectiveModels(provider.id).map((model) => ({
        ...model,
        providerId: provider.id,
      }))
    )
  ok(ctx, models)
})

// ---------------------------------------------------------------------------
// 统计 / 日志 / 会话
// ---------------------------------------------------------------------------

router.get('/stats', async (ctx: Context) => {
  ok(ctx, { runtime: storeManager.getStats() })
})

router.get('/logs', async (ctx: Context) => {
  const limit = Number(ctx.query.limit || 50)
  ok(ctx, { logs: storeManager.getRequestLogs(limit) })
})

router.get('/sessions', async (ctx: Context) => {
  ok(ctx, { sessions: storeManager.getSessions() })
})

router.delete('/sessions', async (ctx: Context) => {
  storeManager.clearAllSessions()
  ok(ctx, { cleared: true })
})

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

router.get('/config', async (ctx: Context) => {
  const config = storeManager.getConfig()
  ok(ctx, {
    host: config.proxyHost,
    port: config.proxyPort,
    mode: storeManager.getSlimConfig().mode || 'single',
    loadBalanceStrategy: config.loadBalanceStrategy,
    retryCount: config.retryCount,
    requestTimeout: config.requestTimeout,
    modelMappings: config.modelMappings,
    contextManagement: config.contextManagement,
    sessionConfig: config.sessionConfig,
  })
})

router.patch('/config', async (ctx: Context) => {
  const body = (ctx.request.body || {}) as {
    loadBalanceStrategy?: LoadBalanceStrategy
    modelMappings?: Record<string, string>
    mode?: 'single' | 'multi'
  }
  const patch: Record<string, any> = {}
  if (body.loadBalanceStrategy) patch.loadBalanceStrategy = body.loadBalanceStrategy
  if (body.mode) storeManager.getSlimConfig().mode = body.mode
  if (body.modelMappings) {
    // 合并而非整体替换：只覆盖传入的 key，保留已有映射
    const existing = storeManager.getConfig().modelMappings
    patch.modelMappings = {
      ...existing,
      ...Object.fromEntries(
        Object.entries(body.modelMappings).map(([requestModel, actualModel]) => [
          requestModel,
          { requestModel, actualModel },
        ])
      ),
    }
  }
  storeManager.updateConfig(patch)
  ok(ctx, { updated: Object.keys(patch) })
})

export default router
