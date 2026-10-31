/**
 * Gemini（Google Generative Language API）协议转换
 * 请求：v1beta contents/systemInstruction/generationConfig/tools → 内部 OpenAI 格式
 * 响应：内部 OpenAI 响应/流 → Gemini candidates 格式
 */

export interface GeminiPart {
  text?: string
  inlineData?: { mimeType?: string; data?: string }
  functionCall?: { name?: string; args?: any }
  functionResponse?: { name?: string; response?: any }
}

export interface GeminiContent {
  role?: 'user' | 'model'
  parts: GeminiPart[]
}

export interface GeminiRequest {
  contents?: GeminiContent[]
  systemInstruction?: { parts?: GeminiPart[] }
  generationConfig?: {
    temperature?: number
    maxOutputTokens?: number
    topP?: number
    stopSequences?: string[]
  }
  tools?: Array<{ functionDeclarations?: Array<{ name: string; description?: string; parameters?: any }> }>
  stream?: boolean
}

function partsToText(parts: GeminiPart[] | undefined): string {
  return (parts || [])
    .map((part) => {
      if (typeof part.text === 'string') return part.text
      if (part.inlineData) return '[图片]'
      return ''
    })
    .join('')
}

/** Gemini 请求 → 内部 OpenAI ChatCompletionRequest */
export function geminiRequestToOpenAI(model: string, body: GeminiRequest, stream: boolean): any {
  const messages: any[] = []

  const systemText = partsToText(body.systemInstruction?.parts)
  if (systemText) messages.push({ role: 'system', content: systemText })

  for (const content of body.contents || []) {
    const role = content.role === 'model' ? 'assistant' : 'user'
    const toolCalls: any[] = []
    const toolResponses: any[] = []
    const texts: string[] = []

    for (const part of content.parts || []) {
      if (typeof part.text === 'string') texts.push(part.text)
      else if (part.inlineData) texts.push('[图片]')
      else if (part.functionCall) {
        toolCalls.push({
          id: `call_${(part.functionCall.name || 'fn')}_${toolCalls.length}`,
          type: 'function',
          function: {
            name: part.functionCall.name || 'unknown',
            arguments: JSON.stringify(part.functionCall.args ?? {}),
          },
        })
      } else if (part.functionResponse) {
        toolResponses.push({
          role: 'tool',
          tool_call_id: `call_${(part.functionResponse.name || 'fn')}_0`,
          content: JSON.stringify(part.functionResponse.response ?? {}),
        })
      }
    }

    if (toolResponses.length > 0) {
      messages.push(...toolResponses)
      continue
    }

    const message: any = { role, content: texts.join('') }
    if (toolCalls.length > 0) message.tool_calls = toolCalls
    if (message.content || message.tool_calls) messages.push(message)
  }

  const tools = (body.tools || [])
    .flatMap((t) => t.functionDeclarations || [])
    .map((fn) => ({
      type: 'function',
      function: {
        name: fn.name,
        description: fn.description || '',
        parameters: fn.parameters || { type: 'object', properties: {} },
      },
    }))

  return {
    model,
    messages,
    stream,
    temperature: body.generationConfig?.temperature,
    max_tokens: body.generationConfig?.maxOutputTokens,
    tools: tools.length > 0 ? tools : undefined,
  }
}

const FINISH_REASON_MAP: Record<string, string> = {
  stop: 'STOP',
  tool_calls: 'STOP',
  length: 'MAX_TOKENS',
  content_filter: 'SAFETY',
}

function safeParseJSON(text: string | undefined): any {
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    return { raw: text }
  }
}

/** 内部 OpenAI 响应体 → Gemini generateContent 响应 */
export function openAIToGeminiResponse(body: any): any {
  const choice = body.choices?.[0]
  const parts: GeminiPart[] = []

  if (typeof choice?.message?.content === 'string' && choice.message.content) {
    parts.push({ text: choice.message.content })
  }
  for (const call of choice?.message?.tool_calls || []) {
    parts.push({ functionCall: { name: call.function?.name, args: safeParseJSON(call.function?.arguments) } })
  }
  if (parts.length === 0) parts.push({ text: '' })

  return {
    candidates: [
      {
        content: { parts, role: 'model' },
        finishReason: FINISH_REASON_MAP[choice?.finish_reason || 'stop'] || 'STOP',
        index: 0,
      },
    ],
    usageMetadata: {
      promptTokenCount: body.usage?.prompt_tokens || 0,
      candidatesTokenCount: body.usage?.completion_tokens || 0,
      totalTokenCount: body.usage?.total_tokens || 0,
    },
    modelVersion: body.model,
  }
}

/** 内部 OpenAI chunk 流 → Gemini SSE（alt=sse 客户端） */
export class GeminiStreamEncoder {
  private finished = false
  private finishReason = 'STOP'

  constructor(private readonly model: string) {}

  handleChunk(chunk: any): string {
    if (this.finished) return ''
    const choice = chunk.choices?.[0]
    if (choice?.finish_reason) {
      this.finishReason = FINISH_REASON_MAP[choice.finish_reason] || 'STOP'
    }

    const parts: GeminiPart[] = []
    if (typeof choice?.delta?.content === 'string' && choice.delta.content) {
      parts.push({ text: choice.delta.content })
    }
    for (const call of choice?.delta?.tool_calls || []) {
      parts.push({ functionCall: { name: call.function?.name, args: safeParseJSON(call.function?.arguments) } })
    }
    if (parts.length === 0) return ''

    return `data: ${JSON.stringify({ candidates: [{ content: { parts, role: 'model' }, index: 0 }], modelVersion: this.model })}\n\n`
  }

  finish(): string {
    if (this.finished) return ''
    this.finished = true
    return `data: ${JSON.stringify({
      candidates: [{ content: { parts: [{ text: '' }], role: 'model' }, finishReason: this.finishReason, index: 0 }],
      modelVersion: this.model,
    })}\n\n`
  }

  error(message: string): string {
    return `data: ${JSON.stringify({ error: { code: 500, message, status: 'INTERNAL' } })}\n\n`
  }
}
