/**
 * DeepSeek 网页端 provider 适配器 —— Cloudflare Workers 版
 *
 * 移植自 Node 版：
 * - src/main/proxy/adapters/deepseek.ts（token / 会话 / PoW / completion 请求体）
 * - src/main/proxy/adapters/deepseek-stream.ts（DeepSeek 原生 SSE -> 文本增量）
 * - src/main/proxy/adapters/providerModelOptions.ts（model_type / search / thinking 开关）
 *
 * 只使用 Workers/Web API：fetch、ReadableStream、TextEncoder/TextDecoder、
 * crypto（经 helpers 的 uuid）、WebAssembly。不含任何 Node 内置模块。
 *
 * 注意：本适配器 **不做** 工具调用解析（由核心层统一处理），
 * req.messages 里已经可能带有核心层注入的工具提示；
 * 历史里的 assistant tool_calls / role=tool 只用于把上下文重新拼成 prompt 文本。
 */

import type { ChatMessage, OpenAIChunk, ProviderAdapter, ProviderChatRequest } from '../types.ts'
import { unixTimestamp, uuid } from '../helpers.ts'
import { getDeepSeekHash, type DeepSeekChallenge } from './deepseek-challenge.ts'

const API_BASE = 'https://chat.deepseek.com/api'

/** 伪造浏览器请求头（来自 Node 版 deepseek 适配器 / 内置 provider 配置） */
const FAKE_HEADERS: Record<string, string> = {
  Accept: '*/*',
  'Accept-Encoding': 'gzip, deflate, br, zstd',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6',
  Origin: 'https://chat.deepseek.com',
  Referer: 'https://chat.deepseek.com/',
  'Sec-Ch-Ua': '"Not/A)Brand";v="99", "Chromium";v="148"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"macOS"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
  'X-App-Version': '2.0.0',
  'X-Client-Locale': 'zh_CN',
  'X-Client-Platform': 'web',
  'x-Client-Timezone-Offset': '28800',
  'X-Client-Version': '2.0.0',
}

/** 上游 completion 路径，同时也用于 PoW 的 target_path */
const COMPLETION_PATH = '/api/v0/chat/completion'

/** access token 缓存：key 是账号里保存的 userToken，有效期 1 小时 */
const tokenCache = new Map<string, { accessToken: string; expiresAt: number }>()

/** 生成访客 cookie（UUID 走 helpers，随机 hex 走 crypto.getRandomValues） */
function generateCookie(): string {
  const timestamp = Date.now()
  const seconds = Math.floor(timestamp / 1000)
  // 18 位 hex，等价于 Node 版的 generateRandomString(18, 'hex')
  const sessionId = Array.from(crypto.getRandomValues(new Uint8Array(9)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
  return [
    `intercom-HWWAFSESTIME=${timestamp}`,
    `HWWAFSESID=${sessionId}`,
    `Hm_lvt_${uuid(false)}=${seconds},${seconds},${seconds}`,
    `Hm_lpvt_${uuid(false)}=${seconds}`,
    `_frid=${uuid(false)}`,
    `_fr_ssid=${uuid(false)}`,
    `_fr_pvid=${uuid(false)}`,
  ].join('; ')
}

/** UTF-8 安全的 base64 编码（PoW header 需要 base64 JSON） */
function base64EncodeUtf8(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

/** 统一构造请求头：FAKE_HEADERS + JSON + Authorization + 额外项 */
function buildHeaders(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...FAKE_HEADERS,
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    ...extra,
  }
}

/** 读取上游错误响应体（截断，避免超长） */
async function readErrorDetail(res: Response): Promise<string> {
  try {
    const text = await res.text()
    return text.length > 800 ? `${text.slice(0, 800)}…` : text
  } catch {
    return ''
  }
}

/**
 * 获取 access token：GET /v0/users/current，Bearer 的是账号里的 userToken。
 * 响应结构：{ code: 0, data: { biz_code: 0, biz_data: { token: "..." } } }
 */
async function acquireToken(userToken: string): Promise<string> {
  const cached = tokenCache.get(userToken)
  if (cached && cached.expiresAt > unixTimestamp()) {
    return cached.accessToken
  }

  const res = await fetch(`${API_BASE}/v0/users/current`, {
    method: 'GET',
    headers: buildHeaders(userToken),
  })

  if (res.status === 401 || res.status === 403) {
    throw new Error('DeepSeek Token 无效或已过期，请重新获取 User Token')
  }
  if (!res.ok) {
    const detail = await readErrorDetail(res)
    throw new Error(`DeepSeek 获取 access token 失败: HTTP ${res.status}${detail ? `: ${detail}` : ''}`)
  }

  const payload: any = await res.json().catch(() => null)
  const bizData = payload?.data?.biz_data ?? payload?.biz_data
  const accessToken: string | undefined = bizData?.token
  if (!accessToken) {
    const message = payload?.msg || payload?.data?.biz_msg || 'Unknown error'
    throw new Error(`DeepSeek 获取 access token 失败: ${message}`)
  }

  tokenCache.set(userToken, { accessToken, expiresAt: unixTimestamp() + 3600 })
  return accessToken
}

/**
 * 创建会话：POST /v0/chat_session/create
 * 响应结构：{ code: 0, data: { biz_code: 0, biz_data: { chat_session: { id } } } }
 */
async function createSession(accessToken: string): Promise<string> {
  const res = await fetch(`${API_BASE}/v0/chat_session/create`, {
    method: 'POST',
    headers: buildHeaders(accessToken, { Cookie: generateCookie() }),
    body: '{}',
  })

  const payload: any = await res.json().catch(() => null)
  const bizData = payload?.data?.biz_data ?? payload?.biz_data
  const sessionId: string | undefined = bizData?.chat_session?.id
  if (!res.ok || !sessionId) {
    const message = payload?.msg || payload?.data?.biz_msg || `HTTP ${res.status}`
    throw new Error(`DeepSeek 创建会话失败: ${message}`)
  }
  return sessionId
}

/** 删除会话：POST /v0/chat_session/delete（清理动作，失败不抛错） */
async function deleteSession(accessToken: string, sessionId: string): Promise<void> {
  try {
    await fetch(`${API_BASE}/v0/chat_session/delete`, {
      method: 'POST',
      headers: buildHeaders(accessToken),
      body: JSON.stringify({ chat_session_id: sessionId }),
    })
  } catch {
    // 忽略：会话删除失败不影响已经产出/将要产出的内容
  }
}

/** 获取 PoW challenge：POST /v0/chat/create_pow_challenge */
async function getChallenge(accessToken: string, targetPath: string): Promise<DeepSeekChallenge> {
  const res = await fetch(`${API_BASE}/v0/chat/create_pow_challenge`, {
    method: 'POST',
    headers: buildHeaders(accessToken),
    body: JSON.stringify({ target_path: targetPath }),
  })

  const payload: any = await res.json().catch(() => null)
  const bizData = payload?.data?.biz_data ?? payload?.biz_data
  const challenge: DeepSeekChallenge | undefined = bizData?.challenge
  if (!res.ok || !challenge) {
    const message = payload?.msg || payload?.data?.biz_msg || `HTTP ${res.status}`
    throw new Error(`DeepSeek 获取 PoW challenge 失败: ${message}`)
  }
  return challenge
}

/**
 * 解算 PoW 并把结果编码成 `X-Ds-Pow-Response` 的值。
 * header 内容是 base64(JSON.stringify({ algorithm, challenge, salt, answer, signature, target_path }))
 */
async function calculateChallengeAnswer(challenge: DeepSeekChallenge, targetPath: string): Promise<string> {
  const { algorithm, challenge: challengeStr, salt, difficulty, expire_at, signature } = challenge

  if (algorithm !== 'DeepSeekHashV1') {
    throw new Error(`不支持的 PoW 算法: ${algorithm}`)
  }

  const deepSeekHash = await getDeepSeekHash()
  const answer = deepSeekHash.calculateHash(algorithm, challengeStr, salt, difficulty, expire_at)
  if (answer === undefined) {
    throw new Error('DeepSeek PoW 计算失败（未找到满足难度的答案）')
  }

  return base64EncodeUtf8(
    JSON.stringify({
      algorithm,
      challenge: challengeStr,
      salt,
      answer,
      signature,
      target_path: targetPath,
    }),
  )
}

/** 转义 XML 属性（与核心层 managed_xml 协议保持一致） */
function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

const TOOL_CALLS_START = '<|CHAT2API|tool_calls>'
const TOOL_CALLS_END = '</|CHAT2API|tool_calls>'

/**
 * 把历史 assistant.tool_calls 还原成核心层注入的那套 Chat2API XML 文本，
 * 保证多轮上下文和工具提示一致。这里只做“文本拼装”，不解析模型输出。
 */
function formatAssistantToolCalls(toolCalls: NonNullable<ChatMessage['tool_calls']>): string {
  const invokes = toolCalls
    .map((call) => {
      let args: Record<string, unknown> = {}
      try {
        const parsed = JSON.parse(call.function?.arguments || '{}')
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          args = parsed as Record<string, unknown>
        }
      } catch {
        // arguments 不是合法 JSON 时按空参数处理
      }
      const params = Object.entries(args)
        .map(([name, value]) => {
          const text = typeof value === 'string' ? value : JSON.stringify(value)
          return `<|CHAT2API|parameter name="${escapeXmlAttribute(name)}"><![CDATA[${text}]]></|CHAT2API|parameter>`
        })
        .join('')
      return `<|CHAT2API|invoke name="${escapeXmlAttribute(call.function?.name || '')}">${params}</|CHAT2API|invoke>`
    })
    .join('')
  return `${TOOL_CALLS_START}${invokes}${TOOL_CALLS_END}`
}

/** role=tool 的历史消息按核心层协议格式化成工具结果文本 */
function formatToolResult(toolCallId: string, content: string): string {
  return `<|CHAT2API|tool_result tool_call_id="${escapeXmlAttribute(toolCallId)}"><![CDATA[${content}]]></|CHAT2API|tool_result>`
}

/**
 * 把 OpenAI 消息数组拼成 DeepSeek 网页端需要的单个 prompt。
 * 逻辑与 Node 版 messagesToPrompt 一致：相邻同角色消息合并，
 * assistant 用 <｜Assistant｜>…<｜end of sentence｜> 包裹，user/system/tool 用 <｜User｜> 前缀。
 */
function messagesToPrompt(messages: ChatMessage[], isMultiTurn = false): string {
  const processedMessages = messages.map((message) => {
    let text: string

    // 历史里的 assistant 工具调用：还原成文本
    if (message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      text = formatAssistantToolCalls(message.tool_calls)
    }
    // 工具结果：按用户文本拼接（核心层负责真正的工具调用流程）
    else if (message.role === 'tool' && message.tool_call_id) {
      text = formatToolResult(message.tool_call_id, String(message.content ?? ''))
    }
    // 多模态 content：只取 text part（与 Node 版一致，图片等忽略）
    else if (Array.isArray(message.content)) {
      text = message.content
        .filter((item: any) => item?.type === 'text')
        .map((item: any) => item?.text ?? '')
        .join('\n')
    } else {
      text = String(message.content ?? '')
    }

    return { role: message.role, text }
  })

  if (processedMessages.length === 0) return ''

  // 多轮模式：只发最后一条 user 消息，并把它后面的 tool 结果附上（当前固定走单轮，保留分支）
  if (isMultiTurn) {
    let lastUserIdx = -1
    for (let i = processedMessages.length - 1; i >= 0; i--) {
      if (processedMessages[i].role === 'user') {
        lastUserIdx = i
        break
      }
    }

    if (lastUserIdx !== -1) {
      let text = processedMessages[lastUserIdx].text
      for (let i = lastUserIdx + 1; i < processedMessages.length; i++) {
        if (processedMessages[i].role === 'tool') {
          text += `\n\n${processedMessages[i].text}`
        }
      }
      return `<｜User｜>${text}`
    }
  }

  // 合并相邻的同角色消息
  const mergedBlocks: { role: string; text: string }[] = []
  let currentBlock = { ...processedMessages[0] }

  for (let i = 1; i < processedMessages.length; i++) {
    const msg = processedMessages[i]
    if (msg.role === currentBlock.role) {
      currentBlock.text += `\n\n${msg.text}`
    } else {
      mergedBlocks.push(currentBlock)
      currentBlock = { ...msg }
    }
  }
  mergedBlocks.push(currentBlock)

  return mergedBlocks
    .map((block, index) => {
      if (block.role === 'assistant') {
        return `<｜Assistant｜>${block.text}<｜end of sentence｜>`
      }
      if (block.role === 'user' || block.role === 'system') {
        return index > 0 ? `<｜User｜>${block.text}` : block.text
      }
      if (block.role === 'tool') {
        return `<｜User｜>${block.text}`
      }
      return block.text
    })
    .join('')
    .replace(/!\[.+\]\(.+\)/g, '')
}

/** 依据模型名/请求参数决定 model_type、是否开启联网搜索、是否开启深度思考 */
function resolveChatOptions(modelName: string, req: ProviderChatRequest): {
  modelType: 'default' | 'expert'
  searchEnabled: boolean
  thinkingEnabled: boolean
} {
  const model = (modelName || '').toLowerCase()
  // 与 Node 版 resolveDeepSeekChatOptions 保持一致
  const isProModel = model.includes('deepseek-v4-pro') || model.includes('expert')
  const isSearchAlias = model.includes('search')
  const isThinkingAlias = model.includes('think') || model.includes('r1') || model.includes('reasoner')

  return {
    modelType: isProModel ? 'expert' : 'default',
    searchEnabled: Boolean(req.web_search) || isSearchAlias,
    thinkingEnabled: Boolean(req.reasoning_effort) || isThinkingAlias,
  }
}

/** DeepSeek SSE 解析过程中的可变状态 */
interface StreamState {
  /** 当前文本落在思考区还是回答区 */
  path: '' | 'thinking' | 'content'
  messageId: string
  /** 深度思考模型：未显式标记路径时默认当作 thinking */
  thinkingModel: boolean
  /** 联网搜索时，上游会在正文前插入 SEARCH 控制标记，需要去掉 */
  stripSearchMarker: boolean
  /** search-silent 模型：去掉 [citation:n] 引用标记 */
  searchSilent: boolean
}

interface TextPiece {
  text: string
  kind: 'content' | 'thinking'
}

const SEARCH_CONTROL_MARKER_PATTERN = /^(SEARCH|WEB_SEARCH|SEARCHING)(?:\s+|$)/i

/** 清理上游文本：去掉 FINISHED 结束标记、搜索控制标记，并统一 citation 写法 */
function cleanPieceText(text: string, state: StreamState): string {
  let out = text.replace(/FINISHED/g, '')
  if (state.stripSearchMarker) {
    out = out.replace(SEARCH_CONTROL_MARKER_PATTERN, '')
  }
  out = state.searchSilent
    ? out.replace(/\[citation:(\d+)\]/g, '')
    : out.replace(/\[citation:(\d+)\]/g, '[$1]')
  return out
}

/** 处理单个 fragment（{ type: 'THINK'|'ANSWER'|'RESPONSE', content }） */
function appendFragment(fragment: any, state: StreamState, pieces: TextPiece[]): void {
  if (!fragment || typeof fragment.content !== 'string' || fragment.content.length === 0) return
  if (fragment.type === 'THINK') {
    state.path = 'thinking'
    pieces.push({ text: fragment.content, kind: 'thinking' })
  } else if (fragment.type === 'ANSWER' || fragment.type === 'RESPONSE') {
    state.path = 'content'
    pieces.push({ text: fragment.content, kind: 'content' })
  }
}

/**
 * 从单个 SSE payload 中提取文本片段。DeepSeek 原生事件形态（参考 Node 版 deepseek-stream.ts）：
 * 1. { v: { response: { thinking_enabled, fragments: [...] } } }   首包/快照
 * 2. { p: 'response/fragments', v: [{ type, content }] }          增量片段
 * 3. { p: 'response', v: [...] }                                  批量事件（含 thinking_enabled）
 * 4. { v: '文本' }                                                纯文本增量
 * 5. { v: [{ v: [{ content }] }] }                                嵌套批量的文本
 */
function extractPieces(chunk: any, state: StreamState): TextPiece[] {
  const pieces: TextPiece[] = []
  if (!chunk || typeof chunk !== 'object') return pieces

  if (chunk.response_message_id && !state.messageId) {
    state.messageId = String(chunk.response_message_id)
  }

  // 形态 1：带 response 的快照对象；这个分支之后没有额外通用文本，直接返回
  if (chunk.v && typeof chunk.v === 'object' && !Array.isArray(chunk.v) && chunk.v.response) {
    const response = chunk.v.response
    if (response.thinking_enabled !== undefined) {
      state.path = response.thinking_enabled ? 'thinking' : 'content'
    }
    if (Array.isArray(response.fragments)) {
      for (const fragment of response.fragments) {
        appendFragment(fragment, state, pieces)
      }
    }
    return pieces
  }

  // 形态 2：增量 fragment 数组
  if (chunk.p === 'response/fragments' && Array.isArray(chunk.v)) {
    for (const fragment of chunk.v) {
      appendFragment(fragment, state, pieces)
    }
  } else if (chunk.p === 'response' && Array.isArray(chunk.v)) {
    // 形态 3：批量事件里可能带 thinking_enabled 开关
    const hasThinking = chunk.v.some(
      (entry: any) =>
        entry?.p === 'response' &&
        entry?.v &&
        typeof entry.v === 'object' &&
        entry.v.thinking_enabled === true,
    )
    if (hasThinking) state.path = 'thinking'
  }

  // 搜索状态事件没有正文
  if (chunk.p === 'response/search_status') return pieces

  // 通用文本提取
  let content = ''
  if (typeof chunk.v === 'string') {
    content = chunk.v
  } else if (Array.isArray(chunk.v)) {
    content = chunk.v
      .map((entry: any) => {
        if (Array.isArray(entry?.v)) {
          return entry.v.map((item: any) => (typeof item?.content === 'string' ? item.content : '')).join('')
        }
        return ''
      })
      .join('')
  }

  if (!content) return pieces

  const path = state.path || (state.thinkingModel ? 'thinking' : '')
  pieces.push({ text: content, kind: path === 'thinking' ? 'thinking' : 'content' })
  return pieces
}

/** 解析一行 SSE（只关心 data: 行） */
function parseSSELine(line: string): { done: boolean; payload?: any } | null {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith(':') || !trimmed.startsWith('data:')) return null
  const data = trimmed.slice(5).trim()
  if (!data) return null
  if (data === '[DONE]') return { done: true }
  try {
    return { done: false, payload: JSON.parse(data) }
  } catch {
    return null
  }
}

/** 把一个 payload 转成 0..N 个 OpenAI 文本增量 chunk */
function* piecesToChunks(payload: any, state: StreamState): Generator<OpenAIChunk> {
  // 上游有时在 200 的流里塞 JSON 错误
  if (payload && typeof payload.code === 'number' && payload.code !== 0) {
    throw new Error(`DeepSeek 上游返回错误: ${payload.msg || payload.code}`)
  }

  for (const piece of extractPieces(payload, state)) {
    const text = cleanPieceText(piece.text, state)
    if (!text) continue
    if (piece.kind === 'thinking') {
      yield { choices: [{ index: 0, delta: { reasoning_content: text } }] }
    } else {
      yield { choices: [{ index: 0, delta: { content: text } }] }
    }
  }
}

export const deepseek: ProviderAdapter = {
  id: 'deepseek',
  name: 'DeepSeek',
  models: ['deepseek-v4.1-flash'],

  /**
   * 发起一次对话并流式产出文本增量。
   * 失败时抛 Error（message 里带上游返回信息），由核心层统一转成 OpenAI 错误。
   */
  async *chat(req: ProviderChatRequest): AsyncIterable<OpenAIChunk> {
    // 1. 取账号里的 userToken（兼容 snake_case / camelCase 几种常见字段名）
    const credentials = req.account?.credentials || {}
    const userToken =
      credentials.token ||
      credentials.apiKey ||
      credentials.refreshToken ||
      credentials.refresh_token ||
      credentials.userToken ||
      credentials.user_token ||
      ''
    if (!userToken) {
      throw new Error('DeepSeek Token 未配置，请在账号设置里填入 User Token')
    }

    // 2. 用 userToken 换取 access token（模块级缓存 1 小时）
    const accessToken = await acquireToken(userToken)

    // 3. 每次请求单独创建一个会话，结束后删除
    const sessionId = await createSession(accessToken)

    try {
      // 4. PoW challenge -> wasm 解算 -> X-Ds-Pow-Response
      const challenge = await getChallenge(accessToken, COMPLETION_PATH)
      const powResponse = await calculateChallengeAnswer(challenge, COMPLETION_PATH)

      // 5. 把消息拼成单个 prompt（工具提示由核心层注入，这里原样拼进去）
      const prompt = messagesToPrompt(req.messages)
      const modelName = req.originalModel || req.model
      const options = resolveChatOptions(modelName, req)

      const res = await fetch(`${API_BASE}/v0/chat/completion`, {
        method: 'POST',
        headers: buildHeaders(accessToken, {
          Referer: `https://chat.deepseek.com/a/chat/s/${sessionId}`,
          Cookie: generateCookie(),
          'X-Ds-Pow-Response': powResponse,
        }),
        body: JSON.stringify({
          chat_session_id: sessionId,
          parent_message_id: null,
          prompt,
          model_type: options.modelType,
          ref_file_ids: [],
          search_enabled: options.searchEnabled,
          thinking_enabled: options.thinkingEnabled,
          preempt: false,
        }),
      })

      if (!res.ok) {
        const detail = await readErrorDetail(res)
        throw new Error(`DeepSeek 上游返回 HTTP ${res.status}${detail ? `: ${detail}` : ''}`)
      }
      if (!res.body) {
        throw new Error('DeepSeek 上游没有返回流式响应体')
      }

      // 上游偶尔在 HTTP 200 下直接返回 JSON 错误（例如 PoW 校验失败）
      const contentType = res.headers.get('content-type') || ''
      if (contentType.includes('application/json')) {
        const detail = await readErrorDetail(res)
        throw new Error(`DeepSeek 上游返回错误: ${detail}`)
      }

      const state: StreamState = {
        path: '',
        messageId: '',
        thinkingModel: options.thinkingEnabled,
        stripSearchMarker: options.searchEnabled,
        searchSilent: /search-silent/i.test(modelName || ''),
      }

      const decoder = new TextDecoder()
      const reader = res.body.getReader()
      let buffer = ''
      let finished = false

      try {
        while (!finished) {
          const { done: streamDone, value } = await reader.read()
          if (streamDone) break

          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() || ''

          for (const line of lines) {
            const event = parseSSELine(line)
            if (!event) continue
            if (event.done) {
              finished = true
              break
            }
            for (const chunk of piecesToChunks(event.payload, state)) {
              yield chunk
            }
          }
        }

        // 流结束时最后一行可能没有换行符，补处理一次
        if (!finished && buffer.trim()) {
          const event = parseSSELine(buffer)
          if (event?.done) finished = true
          else if (event?.payload) {
            for (const chunk of piecesToChunks(event.payload, state)) {
              yield chunk
            }
          }
        }
      } finally {
        // 无论正常结束还是消费方提前中断，都释放上游连接
        try {
          await reader.cancel()
        } catch {
          // 忽略取消失败
        }
        try {
          reader.releaseLock()
        } catch {
          // 忽略锁状态异常
        }
      }

      // 6. 正常结束：只给 finish_reason，不带任何文本
      yield { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
    } finally {
      // 7. 清理会话，避免账号里堆积无用的 chat_session
      await deleteSession(accessToken, sessionId)
    }
  },
}

export default deepseek
