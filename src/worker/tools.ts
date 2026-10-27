import { hasToolPromptInjected, toolsToSystemPrompt } from '../main/proxy/utils/tools.ts'
import { parseToolCalls } from '../main/proxy/utils/toolParser/index.ts'
import type { ChatMessage, OpenAIChunk, OpenAIToolCall } from './types.ts'
import { unixTimestamp, uuid } from './helpers.ts'

/** 把工具定义注入 system 消息（网页版模型没有原生 function calling，只能靠提示词） */
export function injectToolPrompt(messages: ChatMessage[], tools: any[] | undefined): ChatMessage[] {
  if (!tools || tools.length === 0) return messages
  if (hasToolPromptInjected(messages as any)) return messages

  const prompt = toolsToSystemPrompt(tools as any, false)
  if (!prompt) return messages

  const system = messages.find((m) => m.role === 'system')
  if (system) {
    return messages.map((m) =>
      m === system
        ? { ...m, content: typeof m.content === 'string' ? `${m.content}\n\n${prompt}` : prompt }
        : m,
    )
  }
  return [{ role: 'system', content: prompt }, ...messages]
}

export interface ParsedAssistant {
  content: string
  toolCalls: OpenAIToolCall[]
}

/** 从模型完整输出里解析工具调用（统一支持 bracket/xml/anthropic/json 格式） */
export function parseAssistantOutput(text: string): ParsedAssistant {
  const result = parseToolCalls(text || '')
  const toolCalls: OpenAIToolCall[] = (result.toolCalls || []).map((call: any, index: number) => ({
    index,
    id: call.id || `call_${uuid(false).slice(0, 20)}`,
    type: 'function' as const,
    function: {
      name: call.function?.name || call.name || '',
      arguments:
        typeof call.function?.arguments === 'string'
          ? call.function.arguments
          : JSON.stringify(call.function?.arguments ?? call.arguments ?? {}),
    },
  }))

  return {
    content: result.content || '',
    toolCalls,
  }
}

/** 把「完整回答」拆成 OpenAI chunk 序列（供三协议流式编码器使用） */
export function chunksFromMessage(model: string, content: string, toolCalls: OpenAIToolCall[]): OpenAIChunk[] {
  const id = `chatcmpl-${uuid(false)}`
  const created = unixTimestamp()
  const chunks: OpenAIChunk[] = []

  if (content) {
    chunks.push({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: { role: 'assistant', content } }],
    })
  }
  if (toolCalls.length > 0) {
    chunks.push({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: { tool_calls: toolCalls } }],
    })
  }
  chunks.push({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop' }],
  })
  return chunks
}

/** 把 chunk 流聚合成 OpenAI 非流式响应体 */
export async function collectToBody(
  chunks: AsyncIterable<OpenAIChunk>,
  model: string,
): Promise<any> {
  const id = `chatcmpl-${uuid(false)}`
  const created = unixTimestamp()
  let content = ''
  let reasoning = ''
  let finishReason: string | null = 'stop'
  let usage: any = null
  const toolCalls: OpenAIToolCall[] = []

  for await (const chunk of chunks) {
    const choice = chunk.choices?.[0]
    const delta = choice?.delta
    if (delta) {
      if (typeof delta.content === 'string') content += delta.content
      if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content
      if (delta.tool_calls) toolCalls.push(...delta.tool_calls)
    }
    if (choice?.finish_reason) finishReason = choice.finish_reason
    if (chunk.usage) usage = chunk.usage
  }

  if (!usage) {
    const promptChars = Math.max(1, content.length)
    usage = {
      prompt_tokens: Math.max(1, Math.ceil(promptChars / 4)),
      completion_tokens: Math.max(1, Math.ceil(content.length / 4)),
      total_tokens: Math.max(2, Math.ceil((promptChars + content.length) / 4)),
    }
  }

  const message: any = { role: 'assistant', content: content || (toolCalls.length > 0 ? null : '') }
  if (reasoning) message.reasoning_content = reasoning
  if (toolCalls.length > 0) message.tool_calls = toolCalls

  return {
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [{ index: 0, message, finish_reason: toolCalls.length > 0 ? 'tool_calls' : finishReason }],
    usage,
  }
}

/** 并行收集流（用于工具模式：必须先拿到完整文本才能解析） */
export async function collectChunks(iterable: AsyncIterable<OpenAIChunk>): Promise<{
  content: string
  reasoning: string
  finishReason: string | null
  usage: any
}> {
  let content = ''
  let reasoning = ''
  let finishReason: string | null = 'stop'
  let usage: any = null
  for await (const chunk of iterable) {
    const choice = chunk.choices?.[0]
    const delta = choice?.delta
    if (delta) {
      if (typeof delta.content === 'string') content += delta.content
      if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content
    }
    if (choice?.finish_reason) finishReason = choice.finish_reason
    if (chunk.usage) usage = chunk.usage
  }
  return { content, reasoning, finishReason, usage }
}
