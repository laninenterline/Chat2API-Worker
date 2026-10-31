import './setup.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AnthropicStreamEncoder, openAIToAnthropicMessage } from '../src/main/proxy/convert/anthropic.ts'
import { ResponsesStreamEncoder, openAIToResponsesResponse } from '../src/main/proxy/convert/responses.ts'

test('Anthropic 流式编码：message_start/delta/stop', () => {
  const encoder = new AnthropicStreamEncoder('GLM-5.3', { inputTokens: 12 })
  let output = encoder.handleChunk({ choices: [{ index: 0, delta: { content: '你好' } }] } as any)
  output += encoder.handleChunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] } as any)
  output += encoder.finish()
  assert.match(output, /event: message_start|"type":"message_start"/)
  assert.match(output, /content_block_delta/)
  assert.match(output, /你好/)
  assert.match(output, /message_stop/)
  assert.match(output, /"stop_reason":"end_turn"/)
})

test('Anthropic 非流式转换', () => {
  const body = {
    id: 'chatcmpl-1',
    model: 'GLM-5.3',
    choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
  }
  const message = openAIToAnthropicMessage(body, 'GLM-5.3', 3)
  assert.equal(message.type, 'message')
  assert.equal(message.content[0].type, 'text')
  assert.equal(message.content[0].text, 'hi')
})

test('Responses 流式编码', () => {
  const encoder = new ResponsesStreamEncoder({ responseId: 'resp_test', inputTokens: 5, requestedModel: 'GLM-5.3' } as any)
  let output = encoder.handleChunk({ choices: [{ index: 0, delta: { content: 'hi' } }] } as any)
  output += encoder.finish()
  assert.match(output, /response\.(created|output_text\.delta|completed)/)
})

test('Responses 非流式转换', () => {
  const body = {
    id: 'chatcmpl-1',
    model: 'GLM-5.3',
    choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
  }
  const response = openAIToResponsesResponse(body, { responseId: 'resp_1', inputTokens: 3, requestedModel: 'GLM-5.3' } as any)
  assert.equal(response.object, 'response')
  assert.equal(response.output_text, 'hi')
})
