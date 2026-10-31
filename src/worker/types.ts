/** Worker 版共享类型（核心层与 provider 适配器之间唯一的契约） */

export type ProviderId = 'deepseek' | 'glm' | 'minimax'

export interface Account {
  id: string
  provider: ProviderId
  name?: string
  credentials: Record<string, string>
  status?: 'active' | 'error'
  lastUsed?: number
  errorMessage?: string
}

export interface OpenAIToolCall {
  index?: number
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: any
  tool_call_id?: string
  tool_calls?: OpenAIToolCall[]
}

export interface OpenAIChunk {
  id?: string
  object?: string
  created?: number
  model?: string
  choices?: Array<{
    index?: number
    delta?: {
      role?: string
      content?: string | null
      reasoning_content?: string | null
      tool_calls?: OpenAIToolCall[]
    }
    message?: any
    finish_reason?: string | null
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  } | null
}

export interface ProviderChatRequest {
  account: Account
  /** 实际发给上游的模型名 */
  model: string
  /** 客户端请求的模型名（用于特性开关，如 search/think） */
  originalModel: string
  messages: ChatMessage[]
  stream: boolean
  temperature?: number
  max_tokens?: number
  web_search?: boolean
  reasoning_effort?: string
}

export interface ProviderAdapter {
  id: ProviderId
  name: string
  /** 该 provider 支持的模型 ID */
  models: string[]
  /** 额外可作为别名匹配的模型名（用于负载均衡/路由） */
  aliases?: string[]
  /** 只产出文本内容的 OpenAI 格式 chunk；工具调用由核心层统一处理 */
  chat(req: ProviderChatRequest): AsyncIterable<OpenAIChunk>
}

export interface Env {
  KV: KVNamespace
  ADMIN_KEY?: string
  API_KEYS?: string
  SIGN_SECRET?: string
  LOAD_BALANCE_STRATEGY?: string
}
