/**
 * Koa HTTP 服务（slim 版）
 *
 * 上游对应：Chat2API `src/main/proxy/server.ts`（Electron 主进程内启动，600+ 行，含 CORS、
 * 统计、管理路由注册、生命周期管理等）
 *
 * slim 版只做四件事：
 * 1. 中间件：CORS、body 解析、/v1 的 API Key 鉴权、错误兜底、访问日志
 * 2. 注册 /v1/chat/completions、/v1/models（复用上游路由，未改动逻辑）
 * 3. 注册 /v0/management/*（slim 版管理接口）
 * 4. 给 index.ts 提供 createServer / startServer
 */

import Koa from 'koa'
import Router from '@koa/router'
import bodyParser from 'koa-bodyparser'
import type { Context, Next } from 'koa'
import { storeManager } from '../store/store'
import { proxyStatusManager } from './status'
import chatRouter from './routes/chat'
import modelsRouter from './routes/models'
import messagesRouter from './routes/messages'
import responsesRouter from './routes/responses'
import adminRouter from './routes/admin'

export interface ServerHandle {
  app: Koa
  host: string
  port: number
}

function cors(ctx: Context, next: Next): Promise<void> {
  ctx.set('Access-Control-Allow-Origin', '*')
  ctx.set('Access-Control-Allow-Headers', '*')
  ctx.set('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS')
  if (ctx.method === 'OPTIONS') {
    ctx.status = 204
    return Promise.resolve()
  }
  return next()
}

/**
 * 路径重写：部分客户端（以及 DeepSeek 官方 Anthropic 兼容端点的习惯写法）
 * 会把 baseURL 配成 `http://host/anthropic`，请求就变成 /anthropic/v1/messages。
 * 这里统一去掉前缀，交给 /v1 路由处理。
 */
async function rewriteAnthropicPrefix(ctx: Context, next: Next): Promise<void> {
  if (ctx.path === '/anthropic') {
    ctx.path = '/'
  } else if (ctx.path.startsWith('/anthropic/')) {
    ctx.path = ctx.path.slice('/anthropic'.length)
  }
  await next()
}

/** /v1 鉴权：config.json 里 apiKeys 为空则不校验（仅适合本机自用） */
async function apiKeyAuth(ctx: Context, next: Next): Promise<void> {
  const config = storeManager.getConfig()
  const apiKeys = storeManager.getSlimConfig().apiKeys || []
  if (apiKeys.length === 0 || !ctx.path.startsWith('/v1')) {
    await next()
    return
  }
  // OpenAI 客户端用 Authorization: Bearer，Anthropic 客户端（Claude Code / DSH）用 x-api-key
  const provided = (ctx.headers.authorization || '').replace(/^Bearer\s+/i, '') ||
    (ctx.headers['x-api-key'] as string) || ''
  void config
  if (!apiKeys.includes(provided)) {
    ctx.status = 401
    ctx.body = {
      error: { message: 'Invalid API key', type: 'invalid_request_error', param: null, code: 'invalid_api_key' },
    }
    void config
    return
  }
  await next()
}

async function requestLogger(ctx: Context, next: Next): Promise<void> {
  const start = Date.now()
  try {
    await next()
  } finally {
    const latency = Date.now() - start
    if (ctx.path !== '/health') {
      console.log(`[HTTP] ${ctx.method} ${ctx.path} -> ${ctx.status} (${latency}ms)`)
    }
  }
}

export function createServer(): ServerHandle {
  const app = new Koa()

  app.use(async (ctx: Context, next: Next) => {
    try {
      await next()
    } catch (error) {
      console.error('[HTTP] 未捕获异常:', error)
      ctx.status = 500
      ctx.body = {
        error: {
          message: error instanceof Error ? error.message : 'Internal server error',
          type: 'api_error',
          param: null,
          code: 'internal_error',
        },
      }
    }
  })

  app.use(cors)
  app.use(rewriteAnthropicPrefix)
  app.use(requestLogger)
  app.use(bodyParser({ enableTypes: ['json'], jsonLimit: '50mb' }))
  app.use(apiKeyAuth)

  const healthRouter = new Router()
  healthRouter.get('/health', (ctx: Context) => {
    ctx.body = {
      status: 'ok',
      uptime: process.uptime(),
      providers: storeManager.getProviders().map((provider) => ({
        id: provider.id,
        accounts: storeManager.getAccountsByProviderId(provider.id).length,
      })),
    }
  })
  healthRouter.get('/stats', (ctx: Context) => {
    ctx.body = {
      proxy: proxyStatusManager.getStatistics(),
      runtime: storeManager.getStats(),
    }
  })

  app.use(healthRouter.routes()).use(healthRouter.allowedMethods())
  app.use(chatRouter.routes()).use(chatRouter.allowedMethods())
  app.use(messagesRouter.routes()).use(messagesRouter.allowedMethods())
  app.use(responsesRouter.routes()).use(responsesRouter.allowedMethods())
  app.use(modelsRouter.routes()).use(modelsRouter.allowedMethods())
  app.use(adminRouter.routes()).use(adminRouter.allowedMethods())

  const config = storeManager.getConfig()
  // 允许部署环境用环境变量覆盖监听地址/端口（Docker 容器必须绑 0.0.0.0 才能被端口映射访问）
  const host = process.env.HOST || config.proxyHost
  const port = process.env.PORT ? Number(process.env.PORT) : config.proxyPort
  proxyStatusManager.start()

  return { app, host, port }
}

/** 启动服务，返回 Koa 的 http.Server */
export function startServer(): Promise<{ server: import('http').Server; host: string; port: number }> {
  const { app, host, port } = createServer()
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => {
      console.log(`[HTTP] 监听 http://${host}:${port}`)
      console.log(`[HTTP] OpenAI Chat:     http://${host}:${port}/v1/chat/completions`)
      console.log(`[HTTP] Anthropic:       http://${host}:${port}/v1/messages      (Claude Code / DSH)`)
      console.log(`[HTTP] OpenAI Responses:http://${host}:${port}/v1/responses     (Codex CLI)`)
      console.log(`[HTTP] 管理接口: http://${host}:${port}/v0/management`)
      resolve({ server, host, port })
    })
    server.on('error', reject)
  })
}

export default { createServer, startServer }
