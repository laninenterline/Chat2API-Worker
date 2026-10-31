/**
 * Anthropic Messages API 适配（给 Claude Code / DeepSeek Harness 用）
 *
 * 这两个客户端都讲 Anthropic 的 `/v1/messages` 协议：
 *   Claude Code:  ANTHROPIC_BASE_URL=http://127.0.0.1:8080
 *   DeepSeek Harness: DEEPSEEK_BASE_URL=http://127.0.0.1:8080
 *
 * 本文件负责两件事：
 * 1. 请求方向：Anthropic Messages 请求 → 内部 OpenAI ChatCompletions 请求
 *    （工具调用复用上游 ToolCallingEngine 的 prompt 注入方案）
 * 2. 响应方向：内部 OpenAI 响应/流 → Anthropic message / SSE 事件
 *
 * 协议参考：Anthropic Messages API（message_start / content_block_* / message_delta / message_stop）
 */

import type { ChatCompletionRequest } from '../types'
import type { OpenAIChunk } from './openaiStream'

// ---------------------------------------------------------------------------
// 请求类型（只声明用得到的字段）
// ---------------------------------------------------------------------------

export interface AnthropicTextBlock {
  type: 'text'
  text: string
}

export interface AnthropicImageBlock {
  type: 'image'
  source:
    | { type: 'base64'; media_type: string; data: string }
    | { type: 'url'; url: string }
}

export interface AnthropicToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, any>
}

export interface AnthropicToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  content?: string | Array<{ type: string; text?: string }>
  is_error?: boolean
}

export type AnthropicBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock

export interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: string | AnthropicBlock[]
}

export interface AnthropicTool {
  name: string
  description?: string
  input_schema: Record<string, any>
}

export interface AnthropicRequest {
  model: string
  max_tokens: number
  messages: AnthropicMessage[]
  system?: string | AnthropicTextBlock[]
  tools?: AnthropicTool[]
  tool_choice?: { type: 'auto' | 'any' | 'tool' | 'none'; name?: string }
  temperature?: number
  top_p?: number
  stop_sequences?: string[]
  stream?: boolean
  metadata?: { user_id?: string }
}

// ---------------------------------------------------------------------------
// 请求方向：Anthropic -> 内部 OpenAI
// ---------------------------------------------------------------------------

function textFromBlocks(blocks: AnthropicBlock[]): string {
  return blocks
    .filter((block): block is AnthropicTextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('')
}

function toolResultContent(block: AnthropicToolResultBlock): string {
  if (typeof block.content === 'string') return block.content
  if (Array.isArray(block.content)) {
    return block.content.map((part) => part.text || '').join('')
  }
  return ''
}

function toOpenAIContent(blocks: AnthropicBlock[]): string | any[] {
  const parts: any[] = []
  for (const block of blocks) {
    if (block.type === 'text') {
      parts.push({ type: 'text', text: block.text })
    } else if (block.type === 'image') {
      const url =
        block.source.type === 'base64'
          ? `data:${block.source.media_type};base64,${block.source.data}`
          : block.source.url
      parts.push({ type: 'image_url', image_url: { url } })
    }
  }

  if (parts.length === 0) return ''
  if (parts.every((part) => part.type === 'text')) {
    return parts.map((part) => part.text).join('')
  }
  return parts
}

/** Anthropic Messages 请求 → 内部 OpenAI ChatCompletions 请求 */
export function anthropicRequestToOpenAI(request: AnthropicRequest): ChatCompletionRequest {
  const messages: any[] = []

  // system（字符串或 text block 数组）
  if (request.system) {
    const system =
      typeof request.system === 'string'
        ? request.system
        : textFromBlocks(request.system)
    if (system) messages.push({ role: 'system', content: system })
  }

  for (const message of request.messages) {
    if (typeof message.content === 'string') {
      messages.push({ role: message.role, content: message.content })
      continue
    }

    if (message.role === 'user') {
      const toolResults = message.content.filter(
        (block): block is AnthropicToolResultBlock => block.type === 'tool_result'
      )
      // Anthropic 把工具结果放在 user 消息里；OpenAI 需要独立的 role:tool 消息
      for (const result of toolResults) {
        messages.push({
          role: 'tool',
          tool_call_id: result.tool_use_id,
          content: toolResultContent(result),
        })
      }

      const rest = message.content.filter((block) => block.type !== 'tool_result')
      if (rest.length > 0) {
        messages.push({ role: 'user', content: toOpenAIContent(rest) })
      }
      continue
    }

    // assistant：文本 + tool_use 块
    const text = textFromBlocks(message.content)
    const toolUses = message.content.filter(
      (block): block is AnthropicToolUseBlock => block.type === 'tool_use'
    )
    const assistant: any = { role: 'assistant', content: text || null }
    if (toolUses.length > 0) {
      assistant.tool_calls = toolUses.map((block) => ({
        id: block.id,
        type: 'function',
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input ?? {}),
        },
      }))
    }
    messages.push(assistant)
  }

  const openai: ChatCompletionRequest = {
    model: request.model,
    messages,
    max_tokens: request.max_tokens,
    temperature: request.temperature,
    top_p: request.top_p,
    stop: request.stop_sequences,
    stream: request.stream,
  }

  if (request.tools && request.tools.length > 0) {
    openai.tools = request.tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description || '',
        parameters: tool.input_schema || { type: 'object', properties: {} },
      },
    }))
  }

  if (request.tool_choice) {
    const choice = request.tool_choice
    if (choice.type === 'auto' || choice.type === 'none') {
      openai.tool_choice = choice.type
    } else if (choice.type === 'any') {
      openai.tool_choice = 'required'
    } else if (choice.type === 'tool' && choice.name) {
      openai.tool_choice = { type: 'function', function: { name: choice.name } }
    }
  }

  return openai
}

// ---------------------------------------------------------------------------
// 响应方向：内部 OpenAI -> Anthropic
// ---------------------------------------------------------------------------

const STOP_REASON_MAP: Record<string, string> = {
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'tool_use',
  function_call: 'tool_use',
  content_filter: 'refusal',
}

function toAnthropicStopReason(finishReason?: string | null): string {
  if (!finishReason) return 'end_turn'
  return STOP_REASON_MAP[finishReason] || 'end_turn'
}

/** 内部 OpenAI 响应 → Anthropic message 对象 */
export function openAIToAnthropicMessage(
  body: any,
  requestedModel: string,
  inputTokens?: number
): any {
  const choice = body?.choices?.[0]
  const message = choice?.message || {}
  const blocks: any[] = []

  if (typeof message.content === 'string' && message.content.length > 0) {
    blocks.push({ type: 'text', text: message.content })
  }

  for (const toolCall of message.tool_calls || []) {
    let input: any = {}
    try {
      input = JSON.parse(toolCall.function?.arguments || '{}')
    } catch {
      input = { _raw: toolCall.function?.arguments || '' }
    }
    blocks.push({
      type: 'tool_use',
      id: toolCall.id || `toolu_${Math.random().toString(36).slice(2)}`,
      name: toolCall.function?.name || 'unknown',
      input,
    })
  }

  if (blocks.length === 0) {
    blocks.push({ type: 'text', text: '' })
  }

  const usage = body?.usage || {}
  return {
    id: body?.id || `msg_${Date.now().toString(36)}`,
    type: 'message',
    role: 'assistant',
    model: requestedModel,
    content: blocks,
    stop_reason: toAnthropicStopReason(choice?.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: inputTokens ?? usage.prompt_tokens ?? 0,
      output_tokens: usage.completion_tokens ?? 0,
    },
  }
}

/** Anthropic 错误格式 */
export function anthropicError(message: string, type = 'api_error'): any {
  return { type: 'error', error: { type, message } }
}

// ---------------------------------------------------------------------------
// 流式：内部 OpenAI chunk -> Anthropic SSE 事件
// ---------------------------------------------------------------------------

function sse(event: string, data: any): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

/**
 * 把 OpenAI 流式 chunk 逐块翻译成 Anthropic 的 SSE 事件序列。
 *
 * 典型序列：
 *   message_start
 *   content_block_start(text) → content_block_delta(text_delta)* → content_block_stop
 *   content_block_start(tool_use) → content_block_delta(input_json_delta)* → content_block_stop
 *   message_delta → message_stop
 */
export class AnthropicStreamEncoder {
  private started = false
  private finished = false
  private blockIndex = -1
  private openBlock: { index: number; type: 'text' | 'tool'; toolKey?: number } | null = null
  private toolBlocks = new Map<number, { index: number; id: string; name: string }>()
  private lastFinishReason: string | null = null
  private outputChars = 0
  private messageId: string

  constructor(
    private readonly model: string,
    private readonly opts: { inputTokens?: number; messageId?: string } = {}
  ) {
    this.messageId = opts.messageId || `msg_${Date.now().toString(36)}`
  }

  handleChunk(chunk: OpenAIChunk): string {
    if (this.finished) return ''
    let out = this.ensureStarted()

    const choice = chunk.choices?.[0]
    const delta = choice?.delta
    if (!delta) {
      if (choice?.finish_reason) this.lastFinishReason = choice.finish_reason
      return out
    }

    if (typeof delta.content === 'string' && delta.content.length > 0) {
      out += this.openTextBlock()
      out += sse('content_block_delta', {
        type: 'content_block_delta',
        index: this.openBlock!.index,
        delta: { type: 'text_delta', text: delta.content },
      })
      this.outputChars += delta.content.length
    }

    for (const toolCall of delta.tool_calls || []) {
      out += this.handleToolCall(toolCall)
    }

    if (choice?.finish_reason) {
      this.lastFinishReason = choice.finish_reason
    }

    return out
  }

  finish(): string {
    if (this.finished) return ''
    this.finished = true
    let out = this.ensureStarted()

    // 没有任何内容时补一个空 text block，避免客户端解析异常
    if (this.blockIndex === -1) {
      out += this.openTextBlock()
    }
    out += this.closeOpenBlock()

    out += sse('message_delta', {
      type: 'message_delta',
      delta: {
        stop_reason: toAnthropicStopReason(this.lastFinishReason),
        stop_sequence: null,
      },
      usage: { output_tokens: this.estimateOutputTokens() },
    })
    out += sse('message_stop', { type: 'message_stop' })
    return out
  }

  error(message: string): string {
    if (this.finished) return ''
    this.finished = true
    return sse('error', anthropicError(message))
  }

  // -------------------------------------------------------------------------

  private ensureStarted(): string {
    if (this.started) return ''
    this.started = true
    return (
      sse('message_start', {
        type: 'message_start',
        message: {
          id: this.messageId,
          type: 'message',
          role: 'assistant',
          model: this.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: this.opts.inputTokens ?? 0, output_tokens: 0 },
        },
      }) + sse('ping', { type: 'ping' })
    )
  }

  private openTextBlock(): string {
    if (this.openBlock?.type === 'text') return ''

    let out = ''
    if (this.openBlock) out += this.closeOpenBlock()

    const index = ++this.blockIndex
    this.openBlock = { index, type: 'text' }
    out += sse('content_block_start', {
      type: 'content_block_start',
      index,
      content_block: { type: 'text', text: '' },
    })
    return out
  }

  private handleToolCall(toolCall: {
    index?: number
    id?: string
    function?: { name?: string; arguments?: string }
  }): string {
    const toolKey = toolCall.index ?? 0
    let out = ''
    let block = this.toolBlocks.get(toolKey)

    if (!block) {
      if (this.openBlock) out += this.closeOpenBlock()
      const index = ++this.blockIndex
      block = {
        index,
        id: toolCall.id || `toolu_${Math.random().toString(36).slice(2)}`,
        name: toolCall.function?.name || 'unknown',
      }
      this.toolBlocks.set(toolKey, block)
      this.openBlock = { index, type: 'tool', toolKey }
      out += sse('content_block_start', {
        type: 'content_block_start',
        index,
        content_block: {
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: {},
        },
      })
    } else if (this.openBlock?.toolKey !== toolKey) {
      // 回到之前打开的工具块（一般不会发生，兜底处理）
      if (this.openBlock) out += this.closeOpenBlock()
      this.openBlock = { index: block.index, type: 'tool', toolKey }
    }

    const args = toolCall.function?.arguments
    if (args) {
      this.outputChars += args.length
      out += sse('content_block_delta', {
        type: 'content_block_delta',
        index: block.index,
        delta: { type: 'input_json_delta', partial_json: args },
      })
    }

    return out
  }

  private closeOpenBlock(): string {
    if (!this.openBlock) return ''
    const block = this.openBlock
    this.openBlock = null
    return sse('content_block_stop', { type: 'content_block_stop', index: block.index })
  }

  private estimateOutputTokens(): number {
    return Math.max(1, Math.ceil(this.outputChars / 4))
  }
}

/** 粗略估算输入 token（Claude Code 会读 message_start.usage.input_tokens 做上下文统计） */
export function estimateInputTokens(request: AnthropicRequest): number {
  const payload = JSON.stringify(request.messages || []) + (request.system ? JSON.stringify(request.system) : '')
  return Math.ceil(payload.length / 4)
}
