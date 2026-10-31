/**
 * 统一的「内部补全执行器」
 *
 * 上游 Chat2API 把选账号、映射模型、重试、统计这些逻辑直接写在 routes/chat.ts 的
 * 请求处理函数里（约 500 行，和 OpenAI 协议的解析混在一起）。
 *
 * slim 版把这段抽出来，让三个协议入口共用：
 *   /v1/chat/completions  (OpenAI 原生，见 routes/chat.ts)
 *   /v1/messages          (Anthropic，见 routes/messages.ts)
 *   /v1/responses         (OpenAI Responses，见 routes/responses.ts)
 */

import type { ChatCompletionRequest, ProxyContext } from './types'
import type { Account, Provider } from '../store/types'
import { storeManager } from '../store/store'
import { loadBalancer } from './loadbalancer'
import { modelMapper } from './modelMapper'
import { requestForwarder } from './forwarder'

export interface CompletionOutcome {
  ok: boolean
  status?: number
  error?: string
  /** 非流式响应（内部 OpenAI 格式） */
  body?: any
  /** 流式响应（内部 OpenAI SSE 格式） */
  stream?: NodeJS.ReadableStream
  provider?: Provider
  account?: Account
  /** 映射后的实际模型名 */
  actualModel?: string
  /** 客户端请求的模型名 */
  requestedModel: string
}

/**
 * 执行一次补全：
 * 1. 用 modelMapper 把客户端模型名映射成实际模型（支持通配符）
 * 2. 用 loadBalancer 选出账号（round-robin / fill-first / failover）
 * 3. 调 requestForwarder（内部完成工具调用注入、上下文管理、失败重试）
 */
export async function runCompletion(request: ChatCompletionRequest): Promise<CompletionOutcome> {
  const requestedModel = request.model
  const config = storeManager.getConfig()

  const preferredProvider = modelMapper.getPreferredProvider(requestedModel)
  const preferredAccount = modelMapper.getPreferredAccount(requestedModel)
  // mapModel 同时处理精确映射和通配符映射（getActualModel 只处理精确映射）
  const actualModel = modelMapper.mapModel(requestedModel)

  const selection = loadBalancer.selectAccount(
    actualModel,
    config.loadBalanceStrategy,
    preferredProvider,
    preferredAccount
  )

  if (!selection) {
    return {
      ok: false,
      status: 503,
      error: `No available account for model "${requestedModel}" (mapped: "${actualModel}")`,
      requestedModel,
      actualModel,
    }
  }

  const { account, provider } = selection
  const startTime = Date.now()
  const context: ProxyContext = {
    requestId: `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    providerId: provider.id,
    accountId: account.id,
    model: requestedModel,
    actualModel,
    startTime,
    isStream: Boolean(request.stream),
  }

  const result = await requestForwarder.forwardChatCompletion(
    { ...request, model: actualModel, originalModel: requestedModel },
    account,
    provider,
    actualModel,
    context
  )

  const latency = result.latency ?? Date.now() - startTime

  if (!result.success) {
    loadBalancer.markAccountFailed(account.id)
    storeManager.recordRequestInStats(false, latency, requestedModel, provider.id, account.id)
    storeManager.addRequestLog({
      timestamp: startTime,
      status: 'error',
      statusCode: result.status || 502,
      method: 'POST',
      url: '/internal/completion',
      model: requestedModel,
      actualModel,
      providerId: provider.id,
      providerName: provider.name,
      accountId: account.id,
      accountName: account.name,
      latency,
      isStream: Boolean(request.stream),
      errorMessage: result.error,
    })
    return {
      ok: false,
      status: result.status,
      error: result.error || 'Request failed',
      provider,
      account,
      actualModel,
      requestedModel,
    }
  }

  loadBalancer.clearAccountFailure(account.id)
  storeManager.recordRequestInStats(true, latency, requestedModel, provider.id, account.id)
  storeManager.updateAccount(account.id, {
    lastUsed: Date.now(),
    requestCount: (account.requestCount || 0) + 1,
  })

  return {
    ok: true,
    status: result.status ?? 200,
    body: result.body,
    stream: result.stream,
    provider,
    account,
    actualModel,
    requestedModel,
  }
}
