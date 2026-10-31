import './setup.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  GeminiStreamEncoder,
  geminiRequestToOpenAI,
  openAIToGeminiResponse,
} from '../src/worker/convert/gemini.ts'

test('Gemini 请求 → OpenAI（文本 + system + tools）', () => {
  const request = geminiRequestToOpenAI(
    'GLM-5.3',
    {
      systemInstruction: { parts: [{ text: '你是助手' }] },
      contents: [
        { role: 'user', parts: [{ text: '你好' }] },
        { role: 'model', parts: [{ text: '你好！' }] },
        { role: 'user', parts: [{ text: '读文件' }] },
      ],
      generationConfig: { temperature: 0.3, maxOutputTokens: 128 },
      tools: [
        {
          functionDeclarations: [
            { name: 'read_file', description: '读取文件', parameters: { type: 'object' } },
          ],
        },
      ],
    },
    false,
  )

  assert.equal(request.model, 'GLM-5.3')
  assert.equal(request.temperature, 0.3)
  assert.equal(request.max_tokens, 128)
  assert.equal(request.messages[0].role, 'system')
  assert.equal(request.messages[1].content, '你好')
  assert.equal(request.messages[2].role, 'assistant')
  assert.equal(request.tools[0].function.name, 'read_file')
})

test('OpenAI 响应 → Gemini（文本 + functionCall）', () => {
  const textResponse = openAIToGeminiResponse({
    model: 'GLM-5.3',
    choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
  })
  assert.equal(textResponse.candidates[0].content.parts[0].text, 'hi')
  assert.equal(textResponse.candidates[0].finishReason, 'STOP')
  assert.equal(textResponse.usageMetadata.totalTokenCount, 4)

  const toolResponse = openAIToGeminiResponse({
    choices: [
      {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"filePath":"/tmp/a"}' } },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
  })
  assert.equal(toolResponse.candidates[0].content.parts[0].functionCall.name, 'read_file')
})

test('Gemini 流式编码', () => {
  const encoder = new GeminiStreamEncoder('GLM-5.3')
  let output = encoder.handleChunk({ choices: [{ index: 0, delta: { content: '你' } }] } as any)
  output += encoder.handleChunk({ choices: [{ index: 0, delta: { content: '好' } }] } as any)
  output += encoder.handleChunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] } as any)
  output += encoder.finish()
  assert.match(output, /"text":"你"/)
  assert.match(output, /"text":"好"/)
  assert.match(output, /"finishReason":"STOP"/)
})
