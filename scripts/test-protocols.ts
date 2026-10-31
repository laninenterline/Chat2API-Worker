/**
 * 协议转换单元测试（不依赖真实账号）
 *
 * 直接调用 convert/ 下的转换函数，用合成的内部 OpenAI chunk 验证：
 * - Anthropic 请求/响应/流 的转换与事件顺序
 * - Responses 请求/响应/流 的转换与事件顺序
 *
 * 运行：npx tsx scripts/test-protocols.ts
 */

import assert from 'node:assert'
import {
  anthropicRequestToOpenAI,
  openAIToAnthropicMessage,
  AnthropicStreamEncoder,
} from '../src/main/proxy/convert/anthropic.ts'
import {
  responsesRequestToOpenAI,
  openAIToResponsesResponse,
  ResponsesStreamEncoder,
} from '../src/main/proxy/convert/responses.ts'

let passed = 0
function test(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`PASS  ${name}`)
    passed++
  } catch (error) {
    console.error(`FAIL  ${name}`)
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}

function events(sse: string): Array<{ event: string; data: any }> {
  return sse
    .split('\n\n')
    .filter(Boolean)
    .map((block) => {
      const lines = block.split('\n')
      const event = lines.find((line) => line.startsWith('event:'))!.slice(6).trim()
      const dataLine = lines.find((line) => line.startsWith('data:'))!.slice(5).trim()
      return { event, data: JSON.parse(dataLine) }
    })
}

// ---------------------------------------------------------------------------
// Anthropic 请求转换
// ---------------------------------------------------------------------------

test('Anthropic 请求 → 内部 OpenAI（system / tool_result / tool_use / 图片）', () => {
  const openai = anthropicRequestToOpenAI({
    model: 'claude-sonnet-4-5',
    max_tokens: 4096,
    system: [{ type: 'text', text: '你是助手' }],
    tools: [{ name: 'Read', description: '读文件', input_schema: { type: 'object', properties: {} } }],
    tool_choice: { type: 'auto' },
    messages: [
      { role: 'user', content: '看下 a.txt' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '我来读' },
          { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { path: 'a.txt' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: 'hello' },
          { type: 'text', text: '继续' },
        ],
      },
    ],
  })

  assert.equal(openai.model, 'claude-sonnet-4-5')
  assert.equal(openai.max_tokens, 4096)
  assert.equal(openai.messages[0].role, 'system')
  assert.equal(openai.messages[2].role, 'assistant')
  assert.equal(openai.messages[2].tool_calls[0].function.name, 'Read')
  assert.deepEqual(JSON.parse(openai.messages[2].tool_calls[0].function.arguments), { path: 'a.txt' })
  // tool_result 必须变成 role:tool，且排在后续 user 文本之前
  assert.equal(openai.messages[3].role, 'tool')
  assert.equal(openai.messages[3].tool_call_id, 'toolu_1')
  assert.equal(openai.messages[4].role, 'user')
  assert.equal(openai.messages[4].content, '继续')
  assert.equal((openai.tools as any[])[0].function.name, 'Read')
  assert.equal(openai.tool_choice, 'auto')
})

test('Anthropic tool_choice: any → required, tool → function 对象', () => {
  const any = anthropicRequestToOpenAI({
    model: 'm',
    max_tokens: 1,
    messages: [{ role: 'user', content: 'hi' }],
    tool_choice: { type: 'any' },
  })
  assert.equal(any.tool_choice, 'required')

  const tool = anthropicRequestToOpenAI({
    model: 'm',
    max_tokens: 1,
    messages: [{ role: 'user', content: 'hi' }],
    tool_choice: { type: 'tool', name: 'Bash' },
  })
  assert.deepEqual(tool.tool_choice, { type: 'function', function: { name: 'Bash' } })
})

// ---------------------------------------------------------------------------
// Anthropic 响应转换
// ---------------------------------------------------------------------------

test('OpenAI 响应 → Anthropic message（文本 + tool_use + stop_reason）', () => {
  const anthropic = openAIToAnthropicMessage(
    {
      id: 'chatcmpl-1',
      choices: [
        {
          message: {
            role: 'assistant',
            content: '好的',
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'Bash', arguments: '{"cmd":"ls"}' } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 12, completion_tokens: 34 },
    },
    'claude-sonnet-4-5',
    12
  )

  assert.equal(anthropic.type, 'message')
  assert.equal(anthropic.role, 'assistant')
  assert.equal(anthropic.content[0].type, 'text')
  assert.equal(anthropic.content[1].type, 'tool_use')
  assert.deepEqual(anthropic.content[1].input, { cmd: 'ls' })
  assert.equal(anthropic.stop_reason, 'tool_use')
  assert.equal(anthropic.usage.input_tokens, 12)
  assert.equal(anthropic.usage.output_tokens, 34)
})

test('OpenAI 流 → Anthropic SSE（文本块 + 工具块 + 结束事件）', () => {
  const encoder = new AnthropicStreamEncoder('claude-sonnet-4-5', { inputTokens: 99 })
  let sse = ''
  sse += encoder.handleChunk({ choices: [{ delta: { role: 'assistant', content: '你' } }] })
  sse += encoder.handleChunk({ choices: [{ delta: { content: '好' } }] })
  sse += encoder.handleChunk({
    choices: [
      {
        delta: {
          tool_calls: [{ index: 0, id: 'toolu_1', function: { name: 'Bash', arguments: '{"cmd":' } }],
        },
      },
    ],
  })
  sse += encoder.handleChunk({
    choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"ls"}' } }] }, finish_reason: 'tool_calls' }],
  })
  sse += encoder.finish()

  const list = events(sse)
  assert.equal(list[0].event, 'message_start')
  assert.equal(list[0].data.message.usage.input_tokens, 99)
  assert.equal(list[1].event, 'ping')

  const textDelta = list.filter((item) => item.event === 'content_block_delta' && item.data.delta.type === 'text_delta')
  assert.equal(textDelta.map((item) => item.data.delta.text).join(''), '你好')

  const toolStart = list.find((item) => item.event === 'content_block_start' && item.data.content_block.type === 'tool_use')
  assert.ok(toolStart)
  assert.equal(toolStart!.data.content_block.name, 'Bash')

  const jsonDeltas = list.filter((item) => item.event === 'content_block_delta' && item.data.delta.type === 'input_json_delta')
  assert.equal(jsonDeltas.map((item) => item.data.delta.partial_json).join(''), '{"cmd":"ls"}')

  const messageDelta = list.find((item) => item.event === 'message_delta')
  assert.equal(messageDelta!.data.delta.stop_reason, 'tool_use')
  assert.equal(list[list.length - 1].event, 'message_stop')
})

// ---------------------------------------------------------------------------
// Responses 请求/响应转换
// ---------------------------------------------------------------------------

test('Responses 请求 → 内部 OpenAI（instructions / function_call / function_call_output）', () => {
  const openai = responsesRequestToOpenAI({
    model: 'gpt-5-codex',
    instructions: '你是 Codex',
    input: [
      { role: 'user', content: '列一下文件' },
      { type: 'function_call', call_id: 'call_1', name: 'shell', arguments: '{"command":["ls"]}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'a.txt' },
    ],
    tools: [{ type: 'function', name: 'shell', parameters: { type: 'object', properties: {} } }],
    tool_choice: 'auto',
  })

  assert.equal(openai.messages[0].role, 'system')
  assert.equal(openai.messages[0].content, '你是 Codex')
  assert.equal(openai.messages[1].role, 'user')
  assert.equal(openai.messages[2].role, 'assistant')
  assert.equal(openai.messages[2].tool_calls[0].id, 'call_1')
  assert.equal(openai.messages[3].role, 'tool')
  assert.equal(openai.messages[3].tool_call_id, 'call_1')
  assert.equal((openai.tools as any[])[0].function.name, 'shell')
})

test('Responses 流 → response.* 事件（文本 + function_call + completed）', () => {
  const encoder = new ResponsesStreamEncoder({
    responseId: 'resp_test',
    requestedModel: 'gpt-5-codex',
    inputTokens: 50,
  })
  let sse = ''
  sse += encoder.handleChunk({ choices: [{ delta: { content: '你好' } }] })
  sse += encoder.handleChunk({
    choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'shell', arguments: '{"command":["ls"]}' } }] } }],
  })
  sse += encoder.handleChunk({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 50, completion_tokens: 7 } })
  sse += encoder.finish()

  const list = events(sse)
  assert.equal(list[0].event, 'response.created')
  assert.ok(list.some((item) => item.event === 'response.output_text.delta' && item.data.delta === '你好'))
  assert.ok(list.some((item) => item.event === 'response.output_item.added' && item.data.item.type === 'function_call'))
  assert.ok(list.some((item) => item.event === 'response.function_call_arguments.delta'))

  const completed = list[list.length - 1]
  assert.equal(completed.event, 'response.completed')
  assert.equal(completed.data.response.status, 'completed')
  const messageItem = completed.data.response.output.find((item: any) => item.type === 'message')
  assert.equal(messageItem.content[0].text, '你好')
  const functionItem = completed.data.response.output.find((item: any) => item.type === 'function_call')
  assert.equal(functionItem.name, 'shell')
  assert.equal(functionItem.arguments, '{"command":["ls"]}')
  assert.equal(completed.data.response.usage.input_tokens, 50)
})

test('OpenAI 响应 → Responses 对象（非流式）', () => {
  const response = openAIToResponsesResponse(
    {
      choices: [
        {
          message: {
            content: 'done',
            tool_calls: [{ id: 'call_9', type: 'function', function: { name: 'shell', arguments: '{}' } }],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    },
    { responseId: 'resp_x', requestedModel: 'gpt-5-codex', inputTokens: 10 }
  )

  assert.equal(response.object, 'response')
  assert.equal(response.status, 'completed')
  assert.equal(response.output.length, 2)
  assert.equal(response.output[0].type, 'message')
  assert.equal(response.output[1].type, 'function_call')
  assert.equal(response.usage.total_tokens, 15)
})

console.log(`\n${passed} tests passed`)
