import type { OpenAIChunk } from './types.ts'
import type { Store } from './store.ts'
import { runCompletion } from './completion.ts'
import { collectToBody } from './tools.ts'
import { PROVIDER_CATALOG } from './providers/catalog.ts'
import { unixTimestamp } from './helpers.ts'
import {
  anthropicError,
  anthropicRequestToOpenAI,
  AnthropicStreamEncoder,
  estimateInputTokens,
  openAIToAnthropicMessage,
  type AnthropicRequest,
} from '../main/proxy/convert/anthropic.ts'
import {
  estimateResponsesInputTokens,
  openAIToResponsesResponse,
  responsesError,
  responsesRequestToOpenAI,
  ResponsesStreamEncoder,
  type ResponsesRequest,
} from '../main/proxy/convert/responses.ts'

export const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key, anthropic-version, anthropic-beta, x-goog-api-key',
}

export function json(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS },
  })
}

function sseHeaders(): Record<string, string> {
  return {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    ...CORS_HEADERS,
  }
}

/** OpenAI 原生 SSE：把 chunk 流转成 `data: {...}` */
function openAISseResponse(chunks: AsyncIterable<OpenAIChunk>): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const chunk of chunks) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
        }
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: { message } })}\n\n`))
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      } finally {
        controller.close()
      }
    },
  })
  return new Response(stream, { headers: sseHeaders() })
}

/** Anthropic SSE：交给复用自 Node 版的编码器 */
function anthropicSseResponse(
  chunks: AsyncIterable<OpenAIChunk>,
  model: string,
  inputTokens: number,
): Response {
  const encoder = new TextEncoder()
  const anthropicEncoder = new AnthropicStreamEncoder(model, { inputTokens })
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const chunk of chunks) {
          const output = anthropicEncoder.handleChunk(chunk as any)
          if (output) controller.enqueue(encoder.encode(output))
        }
        const tail = anthropicEncoder.finish()
        if (tail) controller.enqueue(encoder.encode(tail))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const output = anthropicEncoder.error(message)
        if (output) controller.enqueue(encoder.encode(output))
      } finally {
        controller.close()
      }
    },
  })
  return new Response(stream, { headers: sseHeaders() })
}

/** OpenAI Responses SSE */
function responsesSseResponse(
  chunks: AsyncIterable<OpenAIChunk>,
  buildOptions: any,
): Response {
  const encoder = new TextEncoder()
  const responsesEncoder = new ResponsesStreamEncoder(buildOptions)
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const chunk of chunks) {
          const output = responsesEncoder.handleChunk(chunk as any)
          if (output) controller.enqueue(encoder.encode(output))
        }
        const tail = responsesEncoder.finish()
        if (tail) controller.enqueue(encoder.encode(tail))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const output = responsesEncoder.error(message)
        if (output) controller.enqueue(encoder.encode(output))
      } finally {
        controller.close()
      }
    },
  })
  return new Response(stream, { headers: sseHeaders() })
}

// ---------------------------------------------------------------------------
// OpenAI: POST /v1/chat/completions
// ---------------------------------------------------------------------------

export async function handleChatCompletions(request: Request, store: Store): Promise<Response> {
  let body: any
  try {
    body = await request.json()
  } catch {
    return json({ error: { message: 'Invalid JSON body', type: 'invalid_request_error' } }, 400)
  }
  if (!body?.model) return json({ error: { message: 'Missing required field: model', type: 'invalid_request_error' } }, 400)
  if (!Array.isArray(body?.messages) || body.messages.length === 0) {
    return json({ error: { message: 'Missing required field: messages', type: 'invalid_request_error' } }, 400)
  }

  const outcome = await runCompletion(body, store)
  if (!outcome.ok) {
    return json({ error: { message: outcome.error || 'Request failed', type: 'api_error' } }, outcome.status || 502)
  }

  const stream = body.stream === true
  if (stream) return openAISseResponse(outcome.chunks!)

  const responseBody = await collectToBody(outcome.chunks!, body.model)
  return json(responseBody)
}

// ---------------------------------------------------------------------------
// Anthropic: POST /v1/messages  (+ /v1/messages/count_tokens)
// ---------------------------------------------------------------------------

export async function handleAnthropicMessages(request: Request, store: Store): Promise<Response> {
  let body: AnthropicRequest
  try {
    body = (await request.json()) as AnthropicRequest
  } catch {
    return json(anthropicError('Invalid JSON body', 'invalid_request_error'), 400)
  }
  if (!body?.model) return json(anthropicError('Missing required field: model', 'invalid_request_error'), 400)
  if (!Array.isArray(body?.messages) || body.messages.length === 0) {
    return json(anthropicError('Missing required field: messages', 'invalid_request_error'), 400)
  }

  const stream = body.stream === true
  const inputTokens = estimateInputTokens(body)
  const openaiRequest = anthropicRequestToOpenAI({ ...body, stream })

  const outcome = await runCompletion(openaiRequest, store)
  if (!outcome.ok) {
    return json(anthropicError(outcome.error || 'Upstream request failed'), outcome.status || 502)
  }

  if (!stream) {
    const responseBody = await collectToBody(outcome.chunks!, body.model)
    return json(openAIToAnthropicMessage(responseBody, body.model, inputTokens))
  }

  return anthropicSseResponse(outcome.chunks!, body.model, inputTokens)
}

export async function handleAnthropicCountTokens(request: Request): Promise<Response> {
  let body: AnthropicRequest
  try {
    body = (await request.json()) as AnthropicRequest
  } catch {
    return json(anthropicError('Invalid JSON body', 'invalid_request_error'), 400)
  }
  if (!body?.messages) return json(anthropicError('Missing required field: messages', 'invalid_request_error'), 400)
  return json({ input_tokens: estimateInputTokens(body) })
}

// ---------------------------------------------------------------------------
// OpenAI Responses: POST /v1/responses
// ---------------------------------------------------------------------------

export async function handleResponses(request: Request, store: Store): Promise<Response> {
  let body: ResponsesRequest
  try {
    body = (await request.json()) as ResponsesRequest
  } catch {
    return json(responsesError('Invalid JSON body', 'invalid_request_error'), 400)
  }
  if (!body?.model) return json(responsesError('Missing required field: model', 'invalid_request_error'), 400)
  if (!body?.input) return json(responsesError('Missing required field: input', 'invalid_request_error'), 400)

  const stream = body.stream === true
  const inputTokens = estimateResponsesInputTokens(body)
  const openaiRequest = responsesRequestToOpenAI({ ...body, stream })

  const outcome = await runCompletion(openaiRequest, store)
  if (!outcome.ok) {
    return json(responsesError(outcome.error || 'Upstream request failed', 'upstream_error'), outcome.status || 502)
  }

  const buildOptions = {
    responseId: `resp_${crypto.randomUUID().replace(/-/g, '')}`,
    inputTokens,
    requestedModel: body.model,
    tools: body.tools,
    instructions: body.instructions,
    toolChoice: body.tool_choice,
  }

  if (!stream) {
    const responseBody = await collectToBody(outcome.chunks!, body.model)
    return json(openAIToResponsesResponse(responseBody, buildOptions))
  }

  return responsesSseResponse(outcome.chunks!, buildOptions)
}

// ---------------------------------------------------------------------------
// GET /v1/models
// ---------------------------------------------------------------------------

export function handleModels(store: Store): Response {
  const modelIds = new Set<string>()
  for (const provider of PROVIDER_CATALOG) {
    for (const model of provider.models) modelIds.add(model)
  }
  return json({
    object: 'list',
    data: [...modelIds].map((id) => ({
      id,
      object: 'model',
      created: unixTimestamp(),
      owned_by: 'chat2api-worker',
    })),
  })
}

export function handleHealth(store: Store): Response {
  return json({ status: 'ok', service: 'chat2api-worker', version: '1.0.0', time: new Date().toISOString() })
}

export const ALL_MODELS = () => PROVIDER_CATALOG.flatMap((p) => p.models)
