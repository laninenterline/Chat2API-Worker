/**
 * 内部流解析：把三家 adapter 产出的「OpenAI 兼容 SSE」解析成 chunk 对象
 *
 * 上游 Chat2API 里这段逻辑分散在 routes/chat.ts 的 Transform 流里（只负责原样透传），
 * slim 版因为要在中间做协议转换（Anthropic / Responses），所以抽成一个可复用的异步迭代器。
 *
 * adapter 输出格式（DeepSeek / GLM / MiniMax 都是 skipTransform=true）：
 *   data: {"id":"...","object":"chat.completion.chunk","choices":[...]}
 *   data: [DONE]
 */

export interface OpenAIChunk {
  id?: string
  object?: string
  created?: number
  model?: string
  choices?: Array<{
    index?: number
    delta?: {
      role?: string
      content?: string | null
      reasoning_content?: string | null
      tool_calls?: Array<{
        index?: number
        id?: string
        type?: string
        function?: { name?: string; arguments?: string }
      }>
    }
    message?: any
    finish_reason?: string | null
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  } | null
}

/**
 * 把 Node 的可读流解析成 OpenAI chunk 序列
 * 容错点：
 * - 兼容 \n\n 与 \r\n\r\n 分隔
 * - 兼容没有 "data:" 前缀的裸行（部分 adapter 会直接写 JSON）
 * - 遇到 [DONE] 立即结束
 */
export async function* iterateOpenAIStream(stream: NodeJS.ReadableStream): AsyncGenerator<OpenAIChunk> {
  let buffer = ''

  // 三家 adapter 实际返回的都是 PassThrough/Transform，天然支持异步迭代；
  // 这里的类型标注是 NodeJS.ReadableStream（forwarder 的公开类型），运行时按 async iterable 处理。
  for await (const chunk of stream as any) {
    buffer += chunk.toString('utf8')

    let boundary = findBoundary(buffer)
    while (boundary.index !== -1) {
      const raw = buffer.slice(0, boundary.index)
      buffer = buffer.slice(boundary.index + boundary.length)
      const parsed = parseSSEBlock(raw)
      if (parsed === 'done') return
      if (parsed) yield parsed
      boundary = findBoundary(buffer)
    }
  }

  // 流结束时把残留数据也尝试解析一次
  const tail = parseSSEBlock(buffer)
  if (tail && tail !== 'done') yield tail
}

function findBoundary(buffer: string): { index: number; length: number } {
  const lf = buffer.indexOf('\n\n')
  const crlf = buffer.indexOf('\r\n\r\n')
  if (lf === -1 && crlf === -1) return { index: -1, length: 0 }
  if (crlf !== -1 && (lf === -1 || crlf < lf)) return { index: crlf, length: 4 }
  return { index: lf, length: 2 }
}

function parseSSEBlock(raw: string): OpenAIChunk | 'done' | null {
  const lines = raw.split(/\r?\n/)
  const dataLines = lines
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())

  const payload = dataLines.length > 0 ? dataLines.join('\n').trim() : raw.trim()
  if (!payload) return null
  if (payload === '[DONE]') return 'done'

  try {
    return JSON.parse(payload) as OpenAIChunk
  } catch {
    // 不是 JSON（可能是心跳/注释行），忽略
    return null
  }
}
