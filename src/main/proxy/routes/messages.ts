/**
 * Anthropic Messages API 入口：`POST /v1/messages`
 * 面向 Claude Code 与 DeepSeek Harness（DSH）
 *
 * 支持的客户端配置：
 *   Claude Code:
 *     ANTHROPIC_BASE_URL=http://127.0.0.1:8080
 *     ANTHROPIC_AUTH_TOKEN=sk-local-test        # 或 ANTHROPIC_API_KEY
 *     ANTHROPIC_MODEL=deepseek-v4-pro
 *     ANTHROPIC_SMALL_FAST_MODEL=deepseek-v4-flash
 *   DeepSeek Harness:
 *     DEEPSEEK_BASE_URL=http://127.0.0.1:8080
 *
 * 另兼容 `/anthropic/v1/messages` 前缀（有些客户端会把 baseURL 写成 .../anthropic）
 */

import Router from '@koa/router'
import type { Context } from 'koa'
import { PassThrough } from 'stream'
import { runCompletion } from '../completion'
import { iterateOpenAIStream } from '../convert/openaiStream'
import {
  anthropicError,
  anthropicRequestToOpenAI,
  AnthropicStreamEncoder,
  estimateInputTokens,
  openAIToAnthropicMessage,
  type AnthropicRequest,
} from '../convert/anthropic'

const router = new Router()

function badRequest(ctx: Context, message: string): void {
  ctx.status = 400
  ctx.body = anthropicError(message, 'invalid_request_error')
}

function setSseHeaders(ctx: Context): void {
  ctx.set('Content-Type', 'text/event-stream; charset=utf-8')
  ctx.set('Cache-Control', 'no-cache')
  ctx.set('Connection', 'keep-alive')
  ctx.set('X-Accel-Buffering', 'no')
}

router.post('/v1/messages', async (ctx: Context) => {
  const body = (ctx.request.body || {}) as AnthropicRequest

  if (!body.model) return badRequest(ctx, 'Missing required field: model')
  if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
    return badRequest(ctx, 'Missing required field: messages')
  }

  const stream = body.stream === true
  const inputTokens = estimateInputTokens(body)
  const openaiRequest = anthropicRequestToOpenAI({ ...body, stream })

  const outcome = await runCompletion(openaiRequest)

  if (!outcome.ok || (!outcome.stream && !outcome.body)) {
    ctx.status = outcome.status && outcome.status >= 400 && outcome.status < 600 ? outcome.status : 502
    ctx.body = anthropicError(outcome.error || 'Upstream request failed')
    return
  }

  // ---- 非流式 ----
  if (!stream) {
    ctx.body = openAIToAnthropicMessage(outcome.body, body.model, inputTokens)
    return
  }

  // ---- 流式 ----
  setSseHeaders(ctx)
  const encoder = new AnthropicStreamEncoder(body.model, { inputTokens })
  const output = new PassThrough()
  ctx.body = output

  const upstream = outcome.stream!
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

/**
 * Claude Code 会调用 `/v1/messages/count_tokens` 估算上下文占用。
 * 网页版模型没有真实 tokenizer，这里按字符数粗略估算（4 字符 ≈ 1 token）。
 */
router.post('/v1/messages/count_tokens', async (ctx: Context) => {
  const body = (ctx.request.body || {}) as AnthropicRequest
  if (!body.messages) return badRequest(ctx, 'Missing required field: messages')
  ctx.body = { input_tokens: estimateInputTokens(body) }
})

export default router
