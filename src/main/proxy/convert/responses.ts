/**
 * OpenAI Responses API 适配（给 Codex CLI 用）
 *
 * Codex CLI（openai/codex）默认走 `/v1/responses`，不是 chat/completions：
 *   ~/.codex/config.toml
 *     model_provider = "slim"
 *     [model_providers.slim]
 *     base_url = "http://127.0.0.1:8080/v1"
 *     wire_api = "responses"
 *     env_key  = "SLIM_API_KEY"
 *
 * 本文件负责：
 * 1. 请求方向：Responses 请求（input items / instructions / function tools）→ 内部 OpenAI ChatCompletions
 * 2. 响应方向：内部 OpenAI 响应/流 → Responses 对象 / SSE 事件（response.* 系列）
 *
 * 参考：OpenAI Responses API 的流式事件（response.created / response.output_item.added /
 * response.output_text.delta / response.function_call_arguments.delta / response.completed）
 */

import type { ChatCompletionRequest } from '../types'
import type { OpenAIChunk } from './openaiStream'

// ---------------------------------------------------------------------------
// 请求类型
// ---------------------------------------------------------------------------

export interface ResponsesContentPart {
  type: 'input_text' | 'output_text' | 'input_image' | 'input_file' | 'refusal'
  text?: string
  image_url?: string
  file_id?: string
  file_data?: string
  filename?: string
}

export type ResponsesItem =
  | { type?: 'message'; role: 'user' | 'assistant' | 'system' | 'developer'; content: string | ResponsesContentPart[] }
  | { type: 'function_call'; id?: string; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string | Array<{ type: string; text?: string }> }
  | { type: 'reasoning'; id?: string; summary?: any[]; content?: any[] }
  | { type: 'item_reference'; id: string }

export interface ResponsesTool {
  type: 'function'
  name: string
  description?: string
  parameters?: Record<string, any>
  strict?: boolean
}

export interface ResponsesRequest {
  model: string
  input: string | ResponsesItem[]
  instructions?: string
  tools?: ResponsesTool[]
  tool_choice?: 'auto' | 'none' | 'required' | { type: 'function'; name?: string }
  temperature?: number
  top_p?: number
  max_output_tokens?: number
  stream?: boolean
  store?: boolean
  previous_response_id?: string
  reasoning?: { effort?: string; summary?: string }
  text?: any
  parallel_tool_calls?: boolean
  metadata?: Record<string, any>
}

// ---------------------------------------------------------------------------
// 请求方向：Responses -> 内部 OpenAI
// ---------------------------------------------------------------------------

function contentToOpenAI(content: string | ResponsesContentPart[]): string | any[] {
  if (typeof content === 'string') return content

  const parts: any[] = []
  for (const part of content) {
    if (part.type === 'input_text' || part.type === 'output_text') {
      parts.push({ type: 'text', text: part.text || '' })
    } else if (part.type === 'input_image' && part.image_url) {
      parts.push({ type: 'image_url', image_url: { url: part.image_url } })
    }
    // input_file 等暂不支持：网页版模型无法直接读文件对象，忽略
  }

  if (parts.length === 0) return ''
  if (parts.every((part) => part.type === 'text')) {
    return parts.map((part) => part.text).join('')
  }
  return parts
}

function outputText(output: string | Array<{ type: string; text?: string }>): string {
  if (typeof output === 'string') return output
  return output.map((part) => part.text || '').join('')
}

/** Responses 请求 → 内部 OpenAI ChatCompletions 请求 */
export function responsesRequestToOpenAI(request: ResponsesRequest): ChatCompletionRequest {
  const messages: any[] = []

  if (request.instructions) {
    messages.push({ role: 'system', content: request.instructions })
  }

  if (typeof request.input === 'string') {
    messages.push({ role: 'user', content: request.input })
  } else {
    for (const item of request.input || []) {
      if (item.type === 'function_call') {
        // 工具调用结果之前是 assistant 的 tool_calls；合并到同一条 assistant 消息里
        const last = messages[messages.length - 1]
        const toolCall = {
          id: item.call_id,
          type: 'function',
          function: { name: item.name, arguments: item.arguments || '{}' },
        }
        if (last && last.role === 'assistant') {
          last.tool_calls = [...(last.tool_calls || []), toolCall]
        } else {
          messages.push({ role: 'assistant', content: null, tool_calls: [toolCall] })
        }
        continue
      }

      if (item.type === 'function_call_output') {
        messages.push({
          role: 'tool',
          tool_call_id: item.call_id,
          content: outputText(item.output),
        })
        continue
      }

      if (item.type === 'reasoning' || item.type === 'item_reference') {
        continue
      }

      // message item
      const role = item.role === 'developer' ? 'system' : item.role
      messages.push({ role, content: contentToOpenAI(item.content) })
    }
  }

  const openai: ChatCompletionRequest = {
    model: request.model,
    messages,
    max_tokens: request.max_output_tokens,
    temperature: request.temperature,
    top_p: request.top_p,
    stream: request.stream,
  }

  if (request.tools && request.tools.length > 0) {
    openai.tools = request.tools.map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description || '',
        parameters: tool.parameters || { type: 'object', properties: {} },
      },
    }))
  }

  if (request.tool_choice) {
    if (request.tool_choice === 'auto' || request.tool_choice === 'none' || request.tool_choice === 'required') {
      openai.tool_choice = request.tool_choice
    } else if (request.tool_choice.type === 'function' && request.tool_choice.name) {
      openai.tool_choice = { type: 'function', function: { name: request.tool_choice.name } }
    }
  }

  return openai
}

// ---------------------------------------------------------------------------
// 响应方向：内部 OpenAI -> Responses
// ---------------------------------------------------------------------------

export interface ResponsesBuildOptions {
  responseId: string
  inputTokens?: number
  requestedModel: string
  tools?: ResponsesTool[]
  instructions?: string
  toolChoice?: any
}

function buildUsage(body: any, inputTokens?: number): any {
  const usage = body?.usage || {}
  const input = inputTokens ?? usage.prompt_tokens ?? 0
  const output = usage.completion_tokens ?? 0
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: input + output,
  }
}

/** 内部 OpenAI 响应 → Responses API 的 response 对象 */
export function openAIToResponsesResponse(body: any, opts: ResponsesBuildOptions): any {
  const choice = body?.choices?.[0]
  const message = choice?.message || {}
  const output: any[] = []

  if (typeof message.content === 'string' && message.content.length > 0) {
    output.push({
      id: `msg_${Date.now().toString(36)}`,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: message.content, annotations: [] }],
    })
  }

  for (const toolCall of message.tool_calls || []) {
    output.push({
      id: `fc_${Math.random().toString(36).slice(2)}`,
      type: 'function_call',
      status: 'completed',
      call_id: toolCall.id || `call_${Math.random().toString(36).slice(2)}`,
      name: toolCall.function?.name || 'unknown',
      arguments: toolCall.function?.arguments || '{}',
    })
  }

  return {
    id: opts.responseId,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    model: opts.requestedModel,
    output,
    output_text: output
      .filter((item) => item.type === 'message')
      .map((item) => item.content.map((part: any) => part.text).join(''))
      .join(''),
    parallel_tool_calls: true,
    tool_choice: opts.toolChoice ?? 'auto',
    tools: opts.tools ?? [],
    instructions: opts.instructions ?? null,
    metadata: {},
    usage: buildUsage(body, opts.inputTokens),
  }
}

export function responsesError(message: string, code = 'server_error'): any {
  return { error: { message, type: 'server_error', param: null, code } }
}

// ---------------------------------------------------------------------------
// 流式：内部 OpenAI chunk -> Responses SSE 事件
// ---------------------------------------------------------------------------

function sse(event: string, data: any): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

interface ToolItemState {
  itemId: string
  outputIndex: number
  callId: string
  name: string
  arguments: string
}

/**
 * 把 OpenAI 流式 chunk 翻译成 Responses 的 SSE 事件序列。
 *
 * Codex 主要消费：
 *   response.output_item.added
 *   response.output_text.delta / response.function_call_arguments.delta
 *   response.output_item.done
 *   response.completed（最终 output 数组）
 */
export class ResponsesStreamEncoder {
  private started = false
  private finished = false
  private responseId: string
  private createdAt = Math.floor(Date.now() / 1000)
  private outputIndex = 0
  private textItemId = `msg_${Date.now().toString(36)}`
  private textOutputIndex = -1
  private textStarted = false
  private textBuffer = ''
  private tools = new Map<number, ToolItemState>()
  private toolOrder: number[] = []
  private usage: any = null
  private lastFinishReason: string | null = null
  private readonly opts: ResponsesBuildOptions

  constructor(opts: ResponsesBuildOptions) {
    this.opts = opts
    this.responseId = opts.responseId
  }

  handleChunk(chunk: OpenAIChunk): string {
    if (this.finished) return ''
    let out = this.ensureStarted()

    if (chunk.usage) this.usage = chunk.usage

    const choice = chunk.choices?.[0]
    const delta = choice?.delta
    if (delta) {
      if (typeof delta.content === 'string' && delta.content.length > 0) {
        out += this.ensureTextItem()
        this.textBuffer += delta.content
        out += sse('response.output_text.delta', {
          type: 'response.output_text.delta',
          item_id: this.textItemId,
          output_index: this.textOutputIndex,
          content_index: 0,
          delta: delta.content,
          logprobs: [],
        })
      }

      for (const toolCall of delta.tool_calls || []) {
        out += this.handleToolCall(toolCall)
      }
    }

    if (choice?.finish_reason) this.lastFinishReason = choice.finish_reason
    return out
  }

  finish(): string {
    if (this.finished) return ''
    this.finished = true
    let out = this.ensureStarted()

    out += this.closeTextItem()

    // 收尾所有工具调用
    for (const [key, tool] of this.tools) {
      out += sse('response.function_call_arguments.done', {
        type: 'response.function_call_arguments.done',
        item_id: tool.itemId,
        output_index: tool.outputIndex,
        arguments: tool.arguments,
      })
      out += sse('response.output_item.done', {
        type: 'response.output_item.done',
        output_index: tool.outputIndex,
        item: {
          id: tool.itemId,
          type: 'function_call',
          status: 'completed',
          call_id: tool.callId,
          name: tool.name,
          arguments: tool.arguments,
        },
      })
      void key
    }

    const finalResponse = this.buildFinalResponse()
    out += sse('response.completed', { type: 'response.completed', response: finalResponse })
    return out
  }

  error(message: string): string {
    if (this.finished) return ''
    this.finished = true
    return sse('error', { type: 'error', message, code: 'server_error', param: null })
  }

  // -------------------------------------------------------------------------

  private ensureStarted(): string {
    if (this.started) return ''
    this.started = true
    const skeleton = this.buildResponseShell('in_progress', [])
    return (
      sse('response.created', { type: 'response.created', response: skeleton }) +
      sse('response.in_progress', { type: 'response.in_progress', response: skeleton })
    )
  }

  private ensureTextItem(): string {
    if (this.textStarted) return ''
    this.textStarted = true
    this.textOutputIndex = this.outputIndex++

    let out = ''
    out += sse('response.output_item.added', {
      type: 'response.output_item.added',
      output_index: this.textOutputIndex,
      item: {
        id: this.textItemId,
        type: 'message',
        status: 'in_progress',
        role: 'assistant',
        content: [],
      },
    })
    out += sse('response.content_part.added', {
      type: 'response.content_part.added',
      item_id: this.textItemId,
      output_index: this.textOutputIndex,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    })
    return out
  }

  private closeTextItem(): string {
    if (!this.textStarted) return ''
    this.textStarted = false

    let out = ''
    out += sse('response.output_text.done', {
      type: 'response.output_text.done',
      item_id: this.textItemId,
      output_index: this.textOutputIndex,
      content_index: 0,
      text: this.textBuffer,
      logprobs: [],
    })
    out += sse('response.content_part.done', {
      type: 'response.content_part.done',
      item_id: this.textItemId,
      output_index: this.textOutputIndex,
      content_index: 0,
      part: { type: 'output_text', text: this.textBuffer, annotations: [] },
    })
    out += sse('response.output_item.done', {
      type: 'response.output_item.done',
      output_index: this.textOutputIndex,
      item: {
        id: this.textItemId,
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: this.textBuffer, annotations: [] }],
      },
    })
    return out
  }

  private handleToolCall(toolCall: {
    index?: number
    id?: string
    function?: { name?: string; arguments?: string }
  }): string {
    const key = toolCall.index ?? 0
    let tool = this.tools.get(key)
    let out = ''

    if (!tool) {
      out += this.closeTextItem()
      tool = {
        itemId: `fc_${Math.random().toString(36).slice(2)}`,
        outputIndex: this.outputIndex++,
        callId: toolCall.id || `call_${Math.random().toString(36).slice(2)}`,
        name: toolCall.function?.name || 'unknown',
        arguments: '',
      }
      this.tools.set(key, tool)
      this.toolOrder.push(key)

      out += sse('response.output_item.added', {
        type: 'response.output_item.added',
        output_index: tool.outputIndex,
        item: {
          id: tool.itemId,
          type: 'function_call',
          status: 'in_progress',
          call_id: tool.callId,
          name: tool.name,
          arguments: '',
        },
      })
    }

    const args = toolCall.function?.arguments
    if (args) {
      tool.arguments += args
      out += sse('response.function_call_arguments.delta', {
        type: 'response.function_call_arguments.delta',
        item_id: tool.itemId,
        output_index: tool.outputIndex,
        delta: args,
      })
    }

    return out
  }

  private buildResponseShell(status: string, output: any[]): any {
    return {
      id: this.responseId,
      object: 'response',
      created_at: this.createdAt,
      status,
      model: this.opts.requestedModel,
      output,
      output_text: '',
      parallel_tool_calls: true,
      tool_choice: this.opts.toolChoice ?? 'auto',
      tools: this.opts.tools ?? [],
      instructions: this.opts.instructions ?? null,
      metadata: {},
      usage: null,
    }
  }

  private buildFinalResponse(): any {
    const output: any[] = []
    if (this.textBuffer) {
      output.push({
        id: this.textItemId,
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: this.textBuffer, annotations: [] }],
      })
    }
    for (const key of this.toolOrder) {
      const tool = this.tools.get(key)!
      output.push({
        id: tool.itemId,
        type: 'function_call',
        status: 'completed',
        call_id: tool.callId,
        name: tool.name,
        arguments: tool.arguments,
      })
    }

    const response = this.buildResponseShell('completed', output)
    response.output_text = this.textBuffer
    response.usage = this.usage
      ? {
          input_tokens: this.opts.inputTokens ?? this.usage.prompt_tokens ?? 0,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: this.usage.completion_tokens ?? 0,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens:
            (this.opts.inputTokens ?? this.usage.prompt_tokens ?? 0) +
            (this.usage.completion_tokens ?? 0),
        }
      : {
          input_tokens: this.opts.inputTokens ?? 0,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: Math.max(1, Math.ceil((this.textBuffer.length + this.totalToolArgs()) / 4)),
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: this.opts.inputTokens ?? 0,
        }
    return response
  }

  private totalToolArgs(): number {
    let total = 0
    for (const tool of this.tools.values()) total += tool.arguments.length
    return total
  }
}

/** 粗略估算输入 token */
export function estimateResponsesInputTokens(request: ResponsesRequest): number {
  const payload = JSON.stringify(request.input || '') + (request.instructions || '')
  return Math.ceil(payload.length / 4)
}
