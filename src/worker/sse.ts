/** 把 Web ReadableStream 解析成 SSE 事件（data 行） */
export interface SSEEvent {
  event?: string
  data: string
}

export async function* parseSSE(stream: ReadableStream<Uint8Array>): AsyncGenerator<SSEEvent> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let eventName: string | undefined
  let dataLines: string[] = []

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      let idx: number
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const raw = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 1)
        const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw

        if (line === '') {
          if (dataLines.length > 0) {
            yield { event: eventName, data: dataLines.join('\n') }
            dataLines = []
            eventName = undefined
          }
          continue
        }
        if (line.startsWith(':')) continue // 注释/keep-alive
        if (line.startsWith('event:')) {
          eventName = line.slice(6).trim()
          continue
        }
        if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).replace(/^ /, ''))
        }
      }
    }
    // 流结束时把残余数据吐出
    if (dataLines.length > 0) yield { event: eventName, data: dataLines.join('\n') }
  } finally {
    try {
      reader.releaseLock()
    } catch {}
  }
}

/** 直接按行读取文本流（DeepSeek 原生 SSE 也走 parseSSE） */
export async function readAllText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let out = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      out += decoder.decode(value, { stream: true })
    }
    out += decoder.decode()
    return out
  } finally {
    try {
      reader.releaseLock()
    } catch {}
  }
}
