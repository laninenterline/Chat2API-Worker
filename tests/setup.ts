/**
 * 测试环境补丁（Node 里跑 Worker 代码）：
 * - Node 的 WebCrypto 不支持 MD5，用 node:crypto 补上（Workers 原生支持 MD5）
 * - 补一个最小 caches 实现（GLM legacy 用它缓存 access token）
 */
import { createHash } from 'node:crypto'

const subtle: any = (globalThis as any).crypto?.subtle
if (subtle && !(subtle as any).__md5Patched) {
  const original = subtle.digest.bind(subtle)
  subtle.digest = async (algorithm: any, data: any) => {
    const name = typeof algorithm === 'string' ? algorithm : algorithm?.name
    if (String(name).toUpperCase() === 'MD5') {
      const bytes =
        data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      const digest = createHash('md5').update(bytes).digest()
      return digest.buffer.slice(digest.byteOffset, digest.byteOffset + digest.byteLength)
    }
    return original(algorithm, data)
  }
  ;(subtle as any).__md5Patched = true
}

;(globalThis as any).caches = (globalThis as any).caches || {
  default: {
    match: async () => undefined,
    put: async () => {},
    delete: async () => {},
  },
}
