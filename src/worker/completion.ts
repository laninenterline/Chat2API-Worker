import type { ChatMessage, OpenAIChunk, ProviderChatRequest } from './types.ts'
import type { Store } from './store.ts'
import { collectChunks, chunksFromMessage, injectToolPrompt, parseAssistantOutput } from './tools.ts'
import { getProvider } from './providers/index.ts'

export interface CompletionOutcome {
  ok: boolean
  status?: number
  error?: string
  providerId?: string
  model: string
  chunks?: AsyncIterable<OpenAIChunk>
}

/**
 * 核心执行器：模型映射 → 选账号 → 工具提示注入 → 调 provider。
 * 协议入口（OpenAI / Anthropic / Responses）全部走这里。
 */
export async function runCompletion(openaiRequest: any, store: Store): Promise<CompletionOutcome> {
  const requestedModel: string = openaiRequest.model
  const resolved = await store.resolveModel(requestedModel)
  if (!resolved) {
    return { ok: false, status: 400, error: `Unknown model: ${requestedModel}`, model: requestedModel }
  }

  const adapter = getProvider(resolved.provider.id)
  if (!adapter) {
    return { ok: false, status: 400, error: `Provider not available: ${resolved.provider.id}`, model: requestedModel }
  }

  const account = await store.pickAccount(adapter.id)
  if (!account) {
    return {
      ok: false,
      status: 503,
      error: `No available account for model "${requestedModel}" (mapped: "${resolved.actualModel}")`,
      model: requestedModel,
      providerId: adapter.id,
    }
  }

  const messages = injectToolPrompt((openaiRequest.messages || []) as ChatMessage[], openaiRequest.tools)
  const hasTools = Array.isArray(openaiRequest.tools) && openaiRequest.tools.length > 0

  const chatRequest: ProviderChatRequest = {
    account,
    model: resolved.actualModel,
    originalModel: requestedModel,
    messages,
    stream: Boolean(openaiRequest.stream),
    temperature: openaiRequest.temperature,
    max_tokens: openaiRequest.max_tokens,
    web_search: openaiRequest.web_search,
    reasoning_effort: openaiRequest.reasoning_effort,
  }

  // 工具模式：网页版模型没有原生 tool_calls，只能先拿完整文本再解析
  if (hasTools) {
    try {
      const collected = await collectChunks(adapter.chat(chatRequest))
      const parsed = parseAssistantOutput(collected.content)
      const chunks = chunksFromMessage(requestedModel, parsed.content, parsed.toolCalls)
      store.clearAccountFailure(account.id)
      store.record(true)
      return {
        ok: true,
        model: requestedModel,
        providerId: adapter.id,
        chunks: (async function* () {
          for (const chunk of chunks) yield chunk
        })(),
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      store.markAccountFailed(account.id, message)
      store.record(false, message)
      return { ok: false, status: 502, error: message, model: requestedModel, providerId: adapter.id }
    }
  }

  // 纯文本模式：边产边发
  const source = adapter.chat(chatRequest)
  return {
    ok: true,
    model: requestedModel,
    providerId: adapter.id,
    chunks: (async function* () {
      try {
        for await (const chunk of source) yield chunk
        store.clearAccountFailure(account.id)
        store.record(true)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        store.markAccountFailed(account.id, message)
        store.record(false, message)
        throw error
      }
    })(),
  }
}
