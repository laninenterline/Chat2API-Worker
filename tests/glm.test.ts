import './setup.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { glm } from '../src/worker/providers/glm.ts'

function sseStream(events: any[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder()
      for (const event of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
      controller.close()
    },
  })
}

test('GLM 适配器：mock 上游 SSE → OpenAI chunk', async () => {
  const originalFetch = globalThis.fetch
  ;(globalThis as any).fetch = async (input: any) => {
    const url = typeof input === 'string' ? input : input.url
    if (url.includes('user-api/user/refresh')) {
      return new Response(JSON.stringify({ code: 0, result: { access_token: 'at', refresh_token: 'rt' } }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }
    if (url.includes('assistant/stream')) {
      return new Response(
        sseStream([
          { conversation_id: 'c1', parts: [{ logic_id: 'p1', content: [{ type: 'text', text: '你好' }], status: 'finish' }] },
          { status: 'finish', conversation_id: 'c1' },
        ]),
        { headers: { 'Content-Type': 'text/event-stream' } },
      )
    }
    return new Response('{}', { headers: { 'Content-Type': 'application/json' } })
  }

  try {
    const chunks: any[] = []
    for await (const chunk of glm.chat({
      account: { id: 'acc', provider: 'glm', credentials: { refresh_token: 'rt' } },
      model: 'GLM-5.3',
      originalModel: 'GLM-5.3',
      messages: [{ role: 'user', content: '你好' }],
      stream: true,
    })) {
      chunks.push(chunk)
    }
    const text = chunks.map((c) => c.choices?.[0]?.delta?.content || '').join('')
    assert.match(text, /你好/)
    const last = chunks[chunks.length - 1]
    assert.ok(last.choices?.[0]?.finish_reason === 'stop')
  } finally {
    globalThis.fetch = originalFetch
  }
})
