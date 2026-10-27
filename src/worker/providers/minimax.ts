/**
 * MiniMax（海螺 Agent，https://agent.minimax.cn）Workers 适配器
 *
 * 移植自 Node 版 `chat2api-slim/src/main/proxy/adapters/minimax.ts`：
 * - 原版用 HTTP/2 长连接 + SSE 增量推送；Workers 里改为普通 fetch，
 *   先 send_msg 建会话，再轮询 get_chat_detail 做增量 diff。
 * - 只使用 Web API：fetch / TextEncoder / AbortController / crypto.subtle（md5 走 helpers）。
 * - 只产出文本 chunk（工具调用由核心层统一解析，本文件不做工具解析）。
 */

import type {
  Account,
  ChatMessage,
  OpenAIChunk,
  ProviderAdapter,
  ProviderChatRequest,
} from '../types.ts'
import { contentToText, decodeJwtPayload, md5, sleep, unixTimestamp, uuid } from '../helpers.ts'

/** 上游基址（与 Node 版一致） */
const BASE_URL = 'https://agent.minimax.cn'

/** 设备注册接口 */
const DEVICE_REGISTER_PATH = '/v1/api/user/device/register'
/** 发送消息接口 */
const SEND_MSG_PATH = '/matrix/api/v1/chat/send_msg'
/** 轮询会话详情接口 */
const CHAT_DETAIL_PATH = '/matrix/api/v1/chat/get_chat_detail'
/** 删除会话接口 */
const DELETE_CHAT_PATH = '/matrix/api/v1/chat/delete_chat'

/** 轮询上限与间隔：约 120 次 × 1s，超过即视为超时 */
const MAX_POLLS = 120
const POLL_INTERVAL_MS = 1000
/** 单个 HTTP 请求超时（毫秒） */
const REQUEST_TIMEOUT_MS = 15000
/** 设备信息缓存有效期（秒），与 Node 版一致 */
const DEVICE_INFO_EXPIRES = 10800
/** 删除会话重试次数与间隔 */
const DELETE_MAX_RETRIES = 3
const DELETE_RETRY_DELAY_MS = 2000

/**
 * 伪装浏览器请求头（与 Node 版 FAKE_HEADERS 一致）。
 * 注意：`Accept-Encoding` 是 fetch 的受限请求头，Workers 不允许手动设置，
 * 压缩协商交给运行时处理，因此这里去掉了它，其余保持一致。
 */
const FAKE_HEADERS: Record<string, string> = {
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  'Cache-Control': 'no-cache',
  Origin: 'https://agent.minimax.cn',
  Pragma: 'no-cache',
  'Sec-Ch-Ua': '"Chromium";v="142", "Google Chrome";v="142", "Not_A Brand";v="99"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"macOS"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
}

/**
 * 上游要求的伪用户数据（全部拼进 query string）。
 * uuid / device_id / user_id / unix / token 是动态字段，调用处按源码逻辑覆盖：
 * - 注册设备：uuid = 随机 UUID（device_id 保持 null，源码会原样拼成 device_id=null）
 * - 其它请求：uuid = user_id = realUserID，device_id = 注册得到的 deviceIDStr
 */
const FAKE_USER_DATA: Record<string, any> = {
  device_platform: 'web',
  biz_id: '3',
  app_id: '3001',
  version_code: '22201',
  uuid: null,
  device_id: null,
  os_name: 'Mac',
  browser_name: 'chrome',
  device_memory: 8,
  cpu_core_num: 11,
  browser_language: 'zh-CN',
  browser_platform: 'MacIntel',
  user_id: null,
  screen_width: 1920,
  screen_height: 1080,
  unix: null,
  lang: 'zh',
  token: null,
  timezone_offset: 28800,
  sys_language: 'zh',
  client: 'web',
}

/** 设备注册结果 */
interface DeviceInfo {
  deviceId: string
  userId: string
  realUserID: string
  jwtToken: string
  refreshTime: number
  uuid: string
}

interface ApiResponse {
  status: number
  data: any
}

/**
 * 设备信息按账号（rawToken）做 isolate 内缓存，避免每次请求都 register。
 * Node 版用 Map + 3 小时过期，这里保持一致。
 */
const deviceInfoCache = new Map<string, DeviceInfo>()

/** 按源码规则把 userData 拼成 query string：只跳过 undefined，null 会变成字面量 "null" */
function buildQuery(userData: Record<string, any>): string {
  let queryStr = ''
  for (const key in userData) {
    const value = userData[key]
    if (value === undefined) continue
    queryStr += `&${key}=${value}`
  }
  return queryStr.substring(1)
}

/**
 * 计算签名（与源码完全一致）：
 * - yy        = md5(encodeURIComponent(带 query 的完整路径) + "_" + dataJson + md5(unix) + "ooui")
 * - signature = md5(timestamp + jwtToken + dataJson)
 * 注意：dataJson 必须与真正发送的 body 字符串逐字节相同。
 */
async function signHeaders(
  fullUri: string,
  dataJson: string,
  unix: string,
  timestamp: number,
  jwtToken: string,
): Promise<{ yy: string; signature: string }> {
  const yy = await md5(`${encodeURIComponent(fullUri)}_${dataJson}${await md5(unix)}ooui`)
  const signature = await md5(`${timestamp}${jwtToken}${dataJson}`)
  return { yy, signature }
}

/** 组装带签名与 token 的请求头 */
function buildHeaders(
  jwtToken: string,
  timestamp: number,
  signature: string,
  yy: string,
): Record<string, string> {
  return {
    ...FAKE_HEADERS,
    'Content-Type': 'application/json',
    Referer: `${BASE_URL}/`,
    token: jwtToken,
    'x-timestamp': String(timestamp),
    'x-signature': signature,
    yy,
  }
}

/** POST JSON 并按状态码/JSON 返回（非 JSON 响应把原文放进 data，方便报错） */
async function postJson(
  url: string,
  dataJson: string,
  headers: Record<string, string>,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<ApiResponse> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: dataJson,
      signal: controller.signal,
    })
    const text = await res.text()
    let data: any = null
    if (text) {
      try {
        data = JSON.parse(text)
      } catch {
        data = text
      }
    }
    return { status: res.status, data }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 单个 MiniMax 账号会话：负责解析凭证、设备注册、签名请求、轮询、删会话。
 * 对应 Node 版 MiniMaxAdapter 里与本适配器相关的部分。
 */
class MiniMaxClient {
  readonly rawToken: string
  readonly jwtToken: string
  readonly realUserID: string
  readonly model: string

  constructor(account: Account, model: string) {
    this.model = model || 'MiniMax-M3.1-Flash'

    // 去掉可能存在的 "Bearer " 前缀（兼容 OpenAI 风格调用）
    this.rawToken = String(account.credentials?.token || '')
      .trim()
      .replace(/^Bearer\s+/i, '')

    const providedRealUserID = String(account.credentials?.realUserID || '').trim()

    if (providedRealUserID) {
      // 1) 显式提供 realUserID 时优先使用
      this.realUserID = providedRealUserID
      this.jwtToken = this.rawToken
    } else if (this.rawToken.includes('+')) {
      // 2) 兼容 "realUserID+JWTtoken" 组合格式
      const plusIndex = this.rawToken.indexOf('+')
      this.realUserID = this.rawToken.slice(0, plusIndex)
      this.jwtToken = this.rawToken.slice(plusIndex + 1)
    } else {
      // 3) 纯 JWT：从 payload.user.id 解析 realUserID
      this.jwtToken = this.rawToken
      this.realUserID = String(decodeJwtPayload(this.jwtToken)?.user?.id || '')
    }

    if (!this.jwtToken) {
      throw new Error('MiniMax 账号缺少 token：请在凭证中配置 token')
    }
    if (!this.realUserID) {
      throw new Error('MiniMax 无法确定 realUserID：请配置 realUserID，或使用包含 user.id 的 JWT')
    }
  }

  /** 设备注册（带缓存），对应源码 requestDeviceInfo() */
  async getDeviceInfo(): Promise<DeviceInfo> {
    const cached = deviceInfoCache.get(this.rawToken)
    if (cached && cached.refreshTime > unixTimestamp()) return cached

    const randomUuid = uuid()
    const unix = `${Date.now()}`
    const timestamp = unixTimestamp()

    // 注册时 uuid 用随机值，user_id 用 realUserID；device_id 保持 null（与源码一致）
    const userData: Record<string, any> = {
      ...FAKE_USER_DATA,
      uuid: randomUuid,
      user_id: this.realUserID,
      unix,
      token: this.jwtToken,
    }
    const queryStr = buildQuery(userData)
    const dataJson = JSON.stringify({ uuid: randomUuid })
    const fullUri = `${DEVICE_REGISTER_PATH}?${queryStr}`
    const { yy, signature } = await signHeaders(fullUri, dataJson, unix, timestamp, this.jwtToken)

    const res = await postJson(
      `${BASE_URL}${fullUri}`,
      dataJson,
      buildHeaders(this.jwtToken, timestamp, signature, yy),
    )

    if (res.status !== 200 || res.data?.statusInfo?.code !== 0) {
      const message = res.data?.statusInfo?.message || `HTTP ${res.status}`
      throw new Error(`MiniMax 设备注册失败: ${message}`)
    }

    const data = res.data?.data || {}
    const info: DeviceInfo = {
      deviceId: data.deviceIDStr || '',
      userId: this.realUserID,
      realUserID: data.realUserID || this.realUserID,
      jwtToken: this.jwtToken,
      refreshTime: unixTimestamp() + DEVICE_INFO_EXPIRES,
      uuid: randomUuid,
    }

    deviceInfoCache.set(this.rawToken, info)
    return info
  }

  /**
   * 带签名的 POST 请求，对应源码 request()：
   * uuid / user_id 都用 realUserID，device_id 用注册得到的设备 ID。
   */
  async request(deviceInfo: DeviceInfo, uri: string, body: any): Promise<ApiResponse> {
    const unix = `${Date.now()}`
    const timestamp = unixTimestamp()

    const realUserID = deviceInfo.realUserID || deviceInfo.userId
    const userData: Record<string, any> = {
      ...FAKE_USER_DATA,
      uuid: realUserID,
      device_id: deviceInfo.deviceId || undefined,
      user_id: realUserID,
      unix,
      token: this.jwtToken,
    }

    const queryStr = buildQuery(userData)
    const fullUri = `${uri}${uri.includes('?') ? '&' : '?'}${queryStr}`
    const dataJson = JSON.stringify(body ?? {})
    const { yy, signature } = await signHeaders(fullUri, dataJson, unix, timestamp, this.jwtToken)

    return postJson(
      `${BASE_URL}${fullUri}`,
      dataJson,
      buildHeaders(this.jwtToken, timestamp, signature, yy),
    )
  }

  /** 删除会话（对应源码 deleteChat）：失败只重试 "chat is running"，其余情况静默失败 */
  async deleteChat(deviceInfo: DeviceInfo, chatId: string | number): Promise<boolean> {
    const numericChatId = parseInt(String(chatId), 10)
    if (!Number.isFinite(numericChatId)) return false

    for (let attempt = 1; attempt <= DELETE_MAX_RETRIES; attempt++) {
      try {
        const res = await this.request(deviceInfo, DELETE_CHAT_PATH, { chat_id: numericChatId })

        if (res.status === 200 && res.data?.base_resp?.status_code === 0) {
          return true
        }

        const message = String(res.data?.base_resp?.status_msg || '')
        // 会话仍在生成时上游会拒绝删除，稍后重试
        if (message.includes('chat is running') && attempt < DELETE_MAX_RETRIES) {
          await sleep(DELETE_RETRY_DELAY_MS)
          continue
        }
        return false
      } catch {
        if (attempt < DELETE_MAX_RETRIES) {
          await sleep(DELETE_RETRY_DELAY_MS)
          continue
        }
        return false
      }
    }
    return false
  }
}

/**
 * 把 OpenAI 消息拼成海螺需要的单段文本（对应源码 messagesPrepare 的单轮分支）。
 * - assistant 的 tool_calls → `[function_calls]...[function_calls]` 文本
 * - role === 'tool' 的消息 → 转成 user 文本（核心层不做工具解析，这里仅拼接）
 * - system 抽取到最前面，其余按 `role:content` 逐行拼接
 */
function messagesPrepare(messages: ChatMessage[]): Record<string, any> {
  const processed = messages.map((msg) => {
    if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
      const toolCallsText = msg.tool_calls
        .map((tc) => `[call:${tc.function?.name}]${tc.function?.arguments}[/call]`)
        .join('\n')
      return { role: msg.role, content: `[function_calls]\n${toolCallsText}\n[/function_calls]` }
    }
    if (msg.role === 'tool') {
      return {
        role: 'user',
        content: `[TOOL_RESULT for ${msg.tool_call_id || ''}] ${contentToText(msg.content)}`,
      }
    }
    return { role: msg.role, content: contentToText(msg.content) }
  })

  // system 单独提到最前面（海螺只接受一段 text）
  let systemContent = ''
  const otherMessages = processed.filter((msg) => {
    if (msg.role === 'system') {
      systemContent = msg.content
      return false
    }
    return true
  })

  let content = systemContent ? `system:${systemContent}\n` : ''

  // 最新一条是文件/图片时，补一句提示（与源码 hasFileOrImage 分支一致）
  const latestContent = messages.length > 0 ? messages[messages.length - 1].content : undefined
  const hasFileOrImage =
    Array.isArray(latestContent) &&
    latestContent.some(
      (v: any) => v && typeof v === 'object' && (v.type === 'file' || v.type === 'image_url'),
    )

  if (otherMessages.length < 2) {
    content += otherMessages.reduce((acc, msg) => acc + `${msg.role}:${msg.content}\n`, '')
  } else {
    if (hasFileOrImage) {
      otherMessages.push({ role: 'system', content: '关注用户最新发送文件和消息' })
    }
    content +=
      otherMessages.reduce((acc, msg) => acc + `${msg.role}:${msg.content}\n`, '') + 'assistant:\n'
    // 去掉 markdown 图片链接，避免把图片 URL 当正文发给上游
    content = content.trim().replace(/!\[.+\]\(.+\)/g, '')
  }

  return {
    msg_type: 1,
    text: content,
    chat_type: 1,
    attachments: [],
    selected_mcp_tools: [],
    backend_config: {},
    sub_agent_ids: [],
  }
}

export const minimax: ProviderAdapter = {
  id: 'minimax',
  name: 'MiniMax',
  models: ['MiniMax-M3.1-Flash'],

  /**
   * 只产出文本 chunk 的异步生成器：
   * 1. 设备注册（带缓存）→ send_msg 建会话
   * 2. 轮询 get_chat_detail，对 msg_type === 2 的 msg_content 做增量 diff 并 yield
   * 3. chat_status === 2 视为完成，yield finish_reason: 'stop'
   * 4. 无论成功失败，最后删除会话（源码 deleteChat）
   */
  async *chat(req: ProviderChatRequest): AsyncIterable<OpenAIChunk> {
    const client = new MiniMaxClient(req.account, req.model)
    const deviceInfo = await client.getDeviceInfo()

    // 1) 发送消息（新会话，不带 chat_id）
    const requestBody = messagesPrepare(req.messages)
    const sendRes = await client.request(deviceInfo, SEND_MSG_PATH, requestBody)

    if (sendRes.status !== 200) {
      throw new Error(`MiniMax 发送消息失败: HTTP ${sendRes.status}`)
    }

    const baseResp = sendRes.data?.base_resp
    if (baseResp?.status_code !== 0) {
      throw new Error(`MiniMax 发送消息失败: ${baseResp?.status_msg || '未知错误'}`)
    }

    const chatId = sendRes.data?.chat_id
    if (chatId === undefined || chatId === null || chatId === '') {
      throw new Error('MiniMax 发送消息失败: 响应缺少 chat_id')
    }

    let lastMsgId = ''
    let lastContent = ''
    let lastError = ''
    let completed = false

    try {
      // 2) 轮询会话详情，增量产出文本
      for (let pollCount = 1; pollCount <= MAX_POLLS; pollCount++) {
        await sleep(POLL_INTERVAL_MS)

        let detail: ApiResponse
        try {
          detail = await client.request(deviceInfo, CHAT_DETAIL_PATH, { chat_id: chatId })
        } catch (err) {
          // 单次网络错误不算失败，继续轮询（超时后才报错）
          lastError = err instanceof Error ? err.message : String(err)
          continue
        }

        if (detail.status !== 200) {
          lastError = `HTTP ${detail.status}`
          continue
        }

        const data = detail.data || {}
        const detailBaseResp = data.base_resp
        if (detailBaseResp?.status_code !== 0) {
          lastError = detailBaseResp?.status_msg || `status_code=${detailBaseResp?.status_code}`
          continue
        }

        const messages: any[] = Array.isArray(data.messages) ? data.messages : []
        // 只取 AI 消息（msg_type === 2），多段时取最后一条
        const aiMessages = messages.filter((msg) => msg?.msg_type === 2)
        const aiMessage = aiMessages.length > 0 ? aiMessages[aiMessages.length - 1] : null

        if (aiMessage && aiMessage.msg_content) {
          const currentContent = String(aiMessage.msg_content)
          const currentMsgId = String(aiMessage.msg_id || '')

          // msg_id 变化说明换了一条 AI 消息，diff 基线需要重置
          if (currentMsgId && lastMsgId && currentMsgId !== lastMsgId) {
            lastContent = ''
          }

          if (currentContent.length > lastContent.length) {
            const delta = currentContent.substring(lastContent.length)
            lastContent = currentContent
            if (delta) {
              yield { choices: [{ index: 0, delta: { content: delta } }] }
            }
          }

          if (currentMsgId) lastMsgId = currentMsgId

          // chat_status === 2 表示本轮回复结束
          const chatStatus = Number(data.chat?.chat_status ?? 0)
          if (chatStatus === 2) {
            completed = true
            break
          }
        }
      }

      if (!completed) {
        throw new Error(
          `MiniMax 响应超时: 轮询 ${MAX_POLLS} 次仍未获取完整回复${
            lastError ? `（最近一次错误: ${lastError}）` : ''
          }`,
        )
      }

      // 3) 结束 chunk
      yield { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
    } finally {
      // 4) 结束后删除会话（失败不影响已产出的内容）
      await client.deleteChat(deviceInfo, chatId).catch(() => false)
    }
  },
}
