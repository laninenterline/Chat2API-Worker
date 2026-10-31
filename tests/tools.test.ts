import './setup.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { injectToolPrompt, parseAssistantOutput, chunksFromMessage, collectToBody } from '../src/worker/tools.ts'

const tools = [
  {
    type: 'function',
    function: { name: 'read_file', description: '读取文件', parameters: { type: 'object' } },
  },
]

test('injectToolPrompt 注入 system 且幂等', () => {
  const messages: any = [{ role: 'user', content: 'hi' }]
  const injected = injectToolPrompt(messages, tools as any)
  assert.equal(injected.length, 2)
  assert.equal(injected[0].role, 'system')
  assert.match(String(injected[0].content), /read_file/)
  // 已经注入过就不再重复
  assert.equal(injectToolPrompt(injected, tools as any), injected)
})

test('parseAssistantOutput 解析 [function_calls] 格式', () => {
  const text = '我先读取文件\n[function_calls]\n[call:read_file]{"filePath":"/tmp/a.txt"}[/call]\n[/function_calls]'
  const parsed = parseAssistantOutput(text)
  assert.equal(parsed.toolCalls.length, 1)
  assert.equal(parsed.toolCalls[0].function.name, 'read_file')
  assert.deepEqual(JSON.parse(parsed.toolCalls[0].function.arguments), { filePath: '/tmp/a.txt' })
  assert.ok(!parsed.content.includes('[function_calls]'))
})

test('chunksFromMessage + collectToBody 往返', async () => {
  const chunks = chunksFromMessage('GLM-5.3', '你好', [])
  const body = await collectToBody(
    (async function* () {
      for (const chunk of chunks) yield chunk
    })(),
    'GLM-5.3',
  )
  assert.equal(body.choices[0].message.content, '你好')
  assert.equal(body.choices[0].finish_reason, 'stop')
  assert.ok(body.usage.total_tokens >= 1)
})
