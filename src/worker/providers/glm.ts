import type { OpenAIChunk, ProviderAdapter } from '../types.ts'
import { createCompletionStream, setSignSecret } from '../glm-legacy/chat.ts'
import { parseSSE } from '../sse.ts'
import { contentToText } from '../helpers.ts'

let configured = false

/** 可选：用环境变量覆盖 GLM 的签名 secret */
export function configureGlm(secret?: string): void {
  if (configured) return
  configured = true
  if (secret) setSignSecret(secret)
}

/**
 * GLM（chatglm.cn）适配器：直接复用 HelloGML 在 Workers 上验证过的流式实现。
 * 文本内容以 OpenAI chunk 形式产出；工具调用由核心层统一处理。
 */
export const glm: ProviderAdapter = {
  id: 'glm',
  name: 'GLM',
  models: ['GLM-5.3-Flash', 'GLM-5.3'],
  aliases: ['GLM-5.1', 'glm-4', 'glm-4-flash'],

  async *chat(req) {
    configureGlm()
    const refreshToken = req.account.credentials.refresh_token || req.account.credentials.token
    if (!refreshToken) throw new Error('GLM 账号缺少 refresh_token')

    const messages = req.messages.map((m) => ({
      role: m.role === 'tool' ? 'user' : m.role,
      content: contentToText(m.content),
    }))

    const upstream = await createCompletionStream(messages, refreshToken, req.model)
    let finished = false

    for await (const event of parseSSE(upstream)) {
      const data = event.data.trim()
      if (!data) continue
      if (data === '[DONE]') break

      let obj: any
      try {
        obj = JSON.parse(data)
      } catch {
        continue
      }

      const choice = obj?.choices?.[0]
      const delta = choice?.delta
      if (typeof delta?.content === 'string' && delta.content.length > 0) {
        yield { choices: [{ index: 0, delta: { content: delta.content } }] } as OpenAIChunk
      }
      if (choice?.finish_reason) finished = true
    }

    yield { choices: [{ index: 0, delta: {}, finish_reason: finished ? 'stop' : 'stop' }] } as OpenAIChunk
  },
}
