/**
 * Proxy Service Module - Request Forwarder
 * Forwards requests to corresponding API based on provider configuration
 */

import axios, { AxiosRequestConfig, AxiosResponse, AxiosError } from 'axios'
import http2 from 'http2'
import { PassThrough } from 'stream'
import { Account, Provider } from '../store/types'
import { ForwardResult, ChatCompletionRequest, ProxyContext } from './types'
import { proxyStatusManager } from './status'
import { storeManager } from '../store/store'
import { GLMAdapter, GLMStreamHandler } from './adapters/glm'
import { ToolCallingEngine } from './toolCalling/ToolCallingEngine'
import type { ToolCallingTransformResult } from './toolCalling/types'
import { sessionManager } from './sessionManager'
import {
  createContextManagementService,
  SummaryGenerator,
} from './services/contextManagementService'
import type { ChatMessage as ContextChatMessage } from './types'

function shouldDeleteSession(): boolean {
  return sessionManager.shouldDeleteAfterChat()
}

type ProviderForwarder = {
  name: string
  matches: (provider: Provider) => boolean
  forward: (
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    startTime: number
  ) => Promise<ForwardResult>
}

/**
 * Request Forwarder
 */
export class RequestForwarder {
  private axiosInstance = axios.create({
    timeout: 120000,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  })

  private readonly providerForwarders: ProviderForwarder[] = [
    {
      name: 'glm',
      matches: GLMAdapter.isGLMProvider,
      forward: (request, account, provider, actualModel, startTime) =>
        this.forwardGLM(request, account, provider, actualModel, startTime),
    },
  ]

  /**
   * Transform request for prompt-based tool calling
   * For models that don't support native function calling
   * Delegates tool normalization, prompt injection, and parser planning to ToolCallingEngine.
   */
  private transformRequestForPromptToolUse(
    request: ChatCompletionRequest,
    provider?: Provider
  ): ToolCallingTransformResult {
    const config = storeManager.getConfig().toolCallingConfig
    const engine = new ToolCallingEngine(config)

    return engine.transformRequest({
      request,
      provider: provider ?? {
        id: 'custom',
        name: 'Custom',
        type: 'custom',
        authType: 'token',
        apiEndpoint: '',
        headers: {},
        enabled: true,
        createdAt: 0,
        updatedAt: 0,
      },
      actualModel: request.model,
    })
  }

  private applyToolCallsToResponse(result: any, transformed: ToolCallingTransformResult): void {
    const engine = new ToolCallingEngine(storeManager.getConfig().toolCallingConfig)
    engine.applyNonStreamResponse(result, transformed.plan)
  }

  /**
   * Create summary generator function for context management
   * Uses the current provider and account to generate summaries
   */
  private createSummaryGenerator(
    account: Account,
    provider: Provider,
    actualModel: string,
    context: ProxyContext
  ): SummaryGenerator {
    return async (messages: ContextChatMessage[], prompt?: string): Promise<string> => {
      try {
        console.log('[SummaryGenerator] Generating summary for', messages.length, 'messages')

        const summaryPrompt = prompt || 'Please summarize the following conversation concisely, keeping key information and context:'

        const conversationText = messages
          .map(msg => {
            const role = msg.role.toUpperCase()
            const content = typeof msg.content === 'string'
              ? msg.content
              : Array.isArray(msg.content)
                ? msg.content
                    .filter(part => part.type === 'text' && part.text)
                    .map(part => part.text)
                    .join('\n')
                : ''
            return `${role}: ${content}`
          })
          .join('\n\n')

        const summaryRequest: ChatCompletionRequest = {
          model: actualModel,
          messages: [
            {
              role: 'system',
              content: summaryPrompt,
            },
            {
              role: 'user',
              content: conversationText,
            },
          ],
          stream: false,
          temperature: 0.3,
        }

        const result = await this.doForward(
          summaryRequest,
          account,
          provider,
          actualModel,
          context
        )

        if (result.success && result.body) {
          const summaryContent = result.body.choices?.[0]?.message?.content || ''
          console.log('[SummaryGenerator] Summary generated successfully, length:', summaryContent.length)
          return summaryContent
        }

        console.warn('[SummaryGenerator] Failed to generate summary:', result.error)
        return 'Failed to generate conversation summary.'
      } catch (error) {
        console.error('[SummaryGenerator] Error generating summary:', error)
        return 'Failed to generate conversation summary due to an error.'
      }
    }
  }

  /**
   * Forward Chat Completions Request
   */
  async forwardChatCompletion(
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    context: ProxyContext
  ): Promise<ForwardResult> {
    const startTime = Date.now()
    const config = storeManager.getConfig()
    const maxRetries = config.retryCount

    let lastError: string | undefined

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        await this.delay(5000)
      }

      let modifiedRequest = request

      if (config.contextManagement?.enabled && modifiedRequest.messages && modifiedRequest.messages.length > 0) {
        try {
          const summaryGenerator = this.createSummaryGenerator(
            account,
            provider,
            actualModel,
            context
          )

          const contextService = createContextManagementService(
            config.contextManagement || {},
            summaryGenerator
          )

          const originalCount = modifiedRequest.messages.length
          const contextMessages: ContextChatMessage[] = modifiedRequest.messages.map(msg => ({
            role: msg.role as 'user' | 'assistant' | 'system' | 'tool',
            content: msg.content,
            timestamp: Date.now(),
          }))

          const processResult = await contextService.process(contextMessages)

          if (processResult.finalCount !== originalCount) {
            console.log(
              `[Forwarder] Context management applied: ${originalCount} -> ${processResult.finalCount} messages`
            )

            processResult.strategyResults.forEach(result => {
              if (result.trimmed) {
                console.log(
                  `[Forwarder] Strategy ${result.strategyName}: ${result.originalCount} -> ${result.processedCount} messages`
                )
              }
            })

            modifiedRequest = {
              ...modifiedRequest,
              messages: processResult.messages.map(msg => ({
                role: msg.role,
                content: msg.content,
              })),
            }
          }
        } catch (error) {
          console.error('[Forwarder] Context management failed:', error)
        }
      }

      try {
        const result = await this.doForward(modifiedRequest, account, provider, actualModel, context)

        if (result.success) {
          return result
        }

        lastError = result.error

        if (result.status && result.status < 500 && result.status !== 429) {
          break
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : 'Unknown error'
      }
    }

    return {
      success: false,
      error: lastError || 'Request failed after retries',
      latency: Date.now() - startTime,
    }
  }

  /**
   * Execute Forward
   */
  private async doForward(
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    context: ProxyContext
  ): Promise<ForwardResult> {
    const startTime = Date.now()

    const dedicatedForwarder = this.providerForwarders.find(forwarder => forwarder.matches(provider))
    if (dedicatedForwarder) {
      return dedicatedForwarder.forward(request, account, provider, actualModel, startTime)
    }

    try {
      const chatPath = provider.chatPath || '/chat/completions'
      const url = this.buildUrl(provider, chatPath)
      const headers = this.buildHeaders(provider, account)
      const body = this.buildRequestBody(request, actualModel, account)

      const axiosConfig: AxiosRequestConfig = {
        method: 'POST',
        url,
        headers,
        data: body,
        timeout: proxyStatusManager.getConfig().timeout,
        responseType: request.stream ? 'stream' : 'json',
        validateStatus: () => true,
      }

      const response: AxiosResponse = await this.axiosInstance.request(axiosConfig)
      const latency = Date.now() - startTime

      if (response.status >= 400) {
        return {
          success: false,
          status: response.status,
          error: this.extractErrorMessage(response),
          latency,
        }
      }

      if (request.stream) {
        return {
          success: true,
          status: response.status,
          headers: this.extractHeaders(response.headers),
          stream: response.data,
          latency,
        }
      }

      return {
        success: true,
        status: response.status,
        headers: this.extractHeaders(response.headers),
        body: response.data,
        latency,
      }
    } catch (error) {
      const latency = Date.now() - startTime

      if (error instanceof AxiosError) {
        return {
          success: false,
          status: error.response?.status,
          error: error.message,
          latency,
        }
      }

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        latency,
      }
    }
  }

  /**
   * DeepSeek Dedicated Forward
   */  private async forwardGLM(
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    startTime: number
  ): Promise<ForwardResult> {
    try {
      const transformed = this.transformRequestForPromptToolUse(request, provider)
      const transformedRequest = {
        ...request,
        messages: transformed.messages,
        tools: transformed.tools,
      }

      const adapter = new GLMAdapter(provider, account)
      const { response, conversationId } = await adapter.chatCompletion({
        model: actualModel,
        originalModel: request.model,
        messages: transformedRequest.messages,
        stream: transformedRequest.stream,
        temperature: transformedRequest.temperature,
        web_search: transformedRequest.web_search,
        reasoning_effort: transformedRequest.reasoning_effort,
        deep_research: transformedRequest.deep_research,
      })

      const latency = Date.now() - startTime

      if (response.status >= 400) {
        let errorMessage = `HTTP ${response.status}`
        if (response.data) {
          if (typeof response.data === 'string') {
            errorMessage = response.data
          } else if (response.data.msg) {
            errorMessage = response.data.msg
          } else if (response.data.message) {
            errorMessage = response.data.message
          } else if (response.data.error?.message) {
            errorMessage = response.data.error.message
          }
        }
        return {
          success: false,
          status: response.status,
          error: errorMessage,
          latency,
        }
      }

      const handler = new GLMStreamHandler(actualModel, undefined, undefined, transformed.plan)
      
      if (request.stream) {
        const transformedStream = await handler.handleStream(response.data)
        
        // If delete session after chat is enabled, we need to handle it after stream ends
        if (shouldDeleteSession()) {
          const originalEnd = transformedStream.end.bind(transformedStream)
          transformedStream.end = function(chunk?: any, encoding?: any, callback?: any) {
            const convId = handler.getConversationId()
            if (convId) {
              adapter.deleteConversation(convId).catch(err => {
                console.error('[GLM] Failed to delete session:', err)
              })
            }
            return originalEnd(chunk, encoding, callback)
          }
        }
        
        return {
          success: true,
          status: response.status,
          headers: this.extractHeaders(response.headers),
          stream: transformedStream,
          skipTransform: true,
          latency,
          providerSessionId: handler.getConversationId(),
        }
      }

      const result = await handler.handleNonStream(response.data)
      
      this.applyToolCallsToResponse(result, transformed)
      
      if (shouldDeleteSession()) {
        const convId = handler.getConversationId()
        if (convId) {
          await adapter.deleteConversation(convId)
        }
      }

      return {
        success: true,
        status: response.status,
        headers: this.extractHeaders(response.headers),
        body: result,
        latency,
        providerSessionId: handler.getConversationId() ?? undefined,
      }
    } catch (error) {
      const latency = Date.now() - startTime
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        latency,
      }
    }
  }

  private buildUrl(provider: Provider, path: string): string {
    let baseUrl = provider.apiEndpoint

    if (baseUrl.endsWith('/')) {
      baseUrl = baseUrl.slice(0, -1)
    }

    if (!path.startsWith('/')) {
      path = '/' + path
    }

    if (baseUrl.includes('/v1') && path.startsWith('/v1')) {
      path = path.slice(3)
    }

    return `${baseUrl}${path}`
  }

  /**
   * Build Request Headers
   */
  private buildHeaders(provider: Provider, account: Account): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...provider.headers,
    }

    const credentials = account.credentials

    if (credentials.token) {
      headers['Authorization'] = `Bearer ${credentials.token}`
    } else if (credentials.apiKey) {
      headers['Authorization'] = `Bearer ${credentials.apiKey}`
    } else if (credentials.accessToken) {
      headers['Authorization'] = `Bearer ${credentials.accessToken}`
    } else if (credentials.refreshToken) {
      headers['Authorization'] = `Bearer ${credentials.refreshToken}`
    }

    if (credentials.cookie) {
      headers['Cookie'] = credentials.cookie
    }

    if (credentials.sessionKey) {
      headers['X-Session-Key'] = credentials.sessionKey
    }

    return headers
  }

  /**
   * Build Request Body
   */
  private buildRequestBody(
    request: ChatCompletionRequest,
    actualModel: string,
    account: Account
  ): any {
    const body: any = {
      model: actualModel,
      messages: request.messages,
      stream: request.stream || false,
    }

    if (request.temperature !== undefined) {
      body.temperature = request.temperature
    }

    if (request.top_p !== undefined) {
      body.top_p = request.top_p
    }

    if (request.n !== undefined) {
      body.n = request.n
    }

    if (request.stop !== undefined) {
      body.stop = request.stop
    }

    if (request.max_tokens !== undefined) {
      body.max_tokens = request.max_tokens
    }

    // 通用 OpenAI 兼容上游：工具调用直接用原生 tools 字段（网页端 provider 走 prompt 注入，不需要这段）
    if ((request as any).tools) {
      body.tools = (request as any).tools
    }
    if ((request as any).tool_choice) {
      body.tool_choice = (request as any).tool_choice
    }

    if (request.presence_penalty !== undefined) {
      body.presence_penalty = request.presence_penalty
    }

    if (request.frequency_penalty !== undefined) {
      body.frequency_penalty = request.frequency_penalty
    }

    if (request.logit_bias !== undefined) {
      body.logit_bias = request.logit_bias
    }

    if (request.user !== undefined) {
      body.user = request.user
    }

    return body
  }

  /**
   * Extract Response Headers
   */
  private extractHeaders(headers: any): Record<string, string> {
    const result: Record<string, string> = {}

    for (const [key, value] of Object.entries(headers)) {
      if (typeof value === 'string') {
        result[key] = value
      } else if (Array.isArray(value)) {
        result[key] = value.join(', ')
      }
    }

    return result
  }

  /**
   * Extract Error Message
   */
  private extractErrorMessage(response: AxiosResponse): string {
    if (response.data) {
      if (typeof response.data === 'string') {
        return response.data
      }

      if (response.data.error?.message) {
        return response.data.error.message
      }

      if (response.data.message) {
        return response.data.message
      }

      if (response.data.msg) {
        return response.data.msg
      }

      try {
        return JSON.stringify(response.data)
      } catch {
        return 'Unknown error'
      }
    }

    return `HTTP ${response.status}`
  }

  /**
   * Delay
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  /**
   * Forward Request to Specified URL
   */
  async forwardToUrl(
    url: string,
    method: string,
    headers: Record<string, string>,
    body: any,
    isStream: boolean = false
  ): Promise<ForwardResult> {
    const startTime = Date.now()

    try {
      const config: AxiosRequestConfig = {
        method,
        url,
        headers,
        data: body,
        timeout: proxyStatusManager.getConfig().timeout,
        responseType: isStream ? 'stream' : 'json',
        validateStatus: () => true,
      }

      const response: AxiosResponse = await this.axiosInstance.request(config)
      const latency = Date.now() - startTime

      if (response.status >= 400) {
        return {
          success: false,
          status: response.status,
          error: this.extractErrorMessage(response),
          latency,
        }
      }

      if (isStream) {
        return {
          success: true,
          status: response.status,
          headers: this.extractHeaders(response.headers),
          stream: response.data,
          latency,
        }
      }

      return {
        success: true,
        status: response.status,
        headers: this.extractHeaders(response.headers),
        body: response.data,
        latency,
      }
    } catch (error) {
      const latency = Date.now() - startTime

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        latency,
      }
    }
  }
}

export const requestForwarder = new RequestForwarder()
export default requestForwarder
