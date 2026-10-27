/** Worker 通用工具：只使用 Web API（Workers 运行时可用） */

export function uuid(separator = true): string {
  const id = crypto.randomUUID()
  return separator ? id : id.replace(/-/g, '')
}

/** 随机 hex 字符串 */
export function randomString(length: number): string {
  const bytes = new Uint8Array(Math.ceil(length / 2))
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('').slice(0, length)
}

export function unixTimestamp(): number {
  return Math.floor(Date.now() / 1000)
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** MD5（Cloudflare Workers 的 crypto.subtle 支持 MD5） */
export async function md5(text: string): Promise<string> {
  const data = new TextEncoder().encode(text)
  const buf = await crypto.subtle.digest('MD5', data)
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('')
}

export function base64Decode(input: string): string {
  return decodeURIComponent(
    Array.from(atob(input), (c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0')).join(''),
  )
}

export function base64Encode(input: string): string {
  return btoa(input)
}

/** 解析 JWT payload（不校验签名） */
export function decodeJwtPayload(token: string): any {
  const parts = token.split('.')
  if (parts.length < 2) return null
  try {
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4)
    return JSON.parse(base64Decode(padded))
  } catch {
    return null
  }
}

/** 把 OpenAI 消息里的 content 压平成字符串（图片等非文本部分忽略或转文字） */
export function contentToText(content: any): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return content == null ? '' : String(content)
  return content
    .map((part: any) => {
      if (part?.type === 'text') return part.text || ''
      if (part?.type === 'image_url') return '[图片]'
      return ''
    })
    .join('')
}
