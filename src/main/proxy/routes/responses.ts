/**
 * OpenAI Responses API 入口：`POST /v1/responses`
 * 面向 Codex CLI（openai/codex，默认 wire_api = "responses"）
 *
 * 客户端配置（~/.codex/config.toml）：
 *   model = "deepseek-v4-pro"
 *   model_provider = "slim"
 *   [model_providers.slim]
 *   name = "chat2api-slim"
 *   base_url = "http://127.0.0.1:8080/v1"
 *   wire_api = "responses"
 *   env_key = "SLIM_API_KEY"        # 启动时 export SLIM_API_KEY=sk-local-test
 */

import Router from '@koa/router'
import type { Context } from 'koa'
import { PassThrough } from 'stream'
import { runCompletion } from '../completion'
import { iterateOpenAIStream } from '../convert/openaiStream'
import {
  estimateResponsesInputTokens,
  openAIToResponsesResponse,
  ResponsesStreamEncoder,
  responsesError,
  responsesRequestToOpenAI,
  type ResponsesRequest,
} from '../convert/responses'

const router = new Router()

function generateResponseId(): string {
  return `resp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

function setSseHeaders(ctx: Context): void {
  ctx.set('Content-Type', 'text/event-stream; charset=utf-8')
  ctx.set('Cache-Control', 'no-cache')
  ctx.set('Connection', 'keep-alive')
  ctx.set('X-Accel-Buffering', 'no')
}

router.post('/v1/responses', async (ctx: Context) => {
  const body = (ctx.request.body || {}) as ResponsesRequest

  if (!body.model) {
    ctx.status = 400
    ctx.body = responsesError('Missing required field: model', 'invalid_request_error')
    return
  }
  if (!body.input) {
    ctx.status = 400
    ctx.body = responsesError('Missing required field: input', 'invalid_request_error')
    return
  }

  const stream = body.stream === true
  const responseId = generateResponseId()
  const inputTokens = estimateResponsesInputTokens(body)
  const openaiRequest = responsesRequestToOpenAI({ ...body, stream })

  const outcome = await runCompletion(openaiRequest)

  if (!outcome.ok) {
    ctx.status = outcome.status && outcome.status >= 400 && outcome.status < 600 ? outcome.status : 502
    ctx.body = responsesError(outcome.error || 'Upstream request failed', 'upstream_error')
    return
  }

  const buildOptions = {
    responseId,
    inputTokens,
    requestedModel: body.model,
    tools: body.tools,
    instructions: body.instructions,
    toolChoice: body.tool_choice,
  }

  // ---- 非流式 ----
  if (!stream) {
    ctx.body = openAIToResponsesResponse(outcome.body, buildOptions)
    return
  }

  // ---- 流式 ----
  if (!outcome.stream) {
    // 上游没返回流（理论上不会），退化成一次性事件流
    setSseHeaders(ctx)
    const encoder = new ResponsesStreamEncoder(buildOptions)
    const output = new PassThrough()
    ctx.body = output
    output.write(encoder.handleChunk({ choices: [{ delta: { content: JSON.stringify(outcome.body) } }] } as any))
    output.write(encoder.finish())
    output.end()
    return
  }

  setSseHeaders(ctx)
  const encoder = new ResponsesStreamEncoder(buildOptions)
  const output = new PassThrough()
  ctx.body = output

  const upstream = outcome.stream
  let aborted = false
  ctx.req.on('close', () => {
    aborted = true
    ;(upstream as any).destroy?.()
  })

  void (async () => {
    try {
      for await (const chunk of iterateOpenAIStream(upstream)) {
        if (aborted) return
        const sse = encoder.handleChunk(chunk)
        if (sse) output.write(sse)
      }
      if (!aborted) {
        const tail = encoder.finish()
        if (tail) output.write(tail)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Stream failed'
      if (!aborted) output.write(encoder.error(message))
    } finally {
      output.end()
    }
  })()
})

export default router
