/**
 * DeepSeek 网页端 PoW（Proof of Work）解算器 —— Cloudflare Workers 版
 *
 * 移植自 Node 版 `src/main/lib/challenge.ts`：
 * - 唯一的差异是 wasm 的加载方式：Workers 里不能用 fs 读文件，
 *   而是通过 wrangler 的 CompiledWasm 规则把 .wasm 作为模块 import 进来，
 *   再用 WebAssembly.instantiate() 实例化。
 * - 其余（字符串写入 wasm 线性内存、调用 wasm_solve、读取返回值）逻辑保持一致。
 *
 * 支持的算法：DeepSeekHashV1（wasm 内实现了 SHA3 相关计算）
 */

// Workers 的 CompiledWasm 规则会把该文件编译成 WebAssembly.Module，
// 类型声明见 src/wasm.d.ts。
import wasmModule from '../../../assets/sha3_wasm_bg.7b9ca65ddd.wasm'

/** create_pow_challenge 返回的 challenge 结构 */
export interface DeepSeekChallenge {
  algorithm: string
  challenge: string
  salt: string
  difficulty: number
  expire_at: number
  signature: string
}

export class DeepSeekHash {
  /** wasm 实例的导出对象（memory / wasm_solve / __wbindgen_*） */
  private wasmInstance: any = null
  /** 最近一次 encodeString 写入的长度（对应原实现的 this.offset） */
  private offset = 0
  /** 缓存的线性内存视图，内存增长/换 buffer 后会重建 */
  private cachedUint8Memory: Uint8Array | null = null
  private cachedTextEncoder: TextEncoder = new TextEncoder()

  /**
   * 把 JS 字符串写进 wasm 线性内存，返回指针；写入的字节数记录在 this.offset。
   * 纯 ASCII 走快速路径，含非 ASCII 时先按 charCode 写入再 reallocate 扩容为 UTF-8。
   */
  private encodeString(
    text: string,
    allocate: (size: number, align: number) => number,
    reallocate?: (ptr: number, oldSize: number, newSize: number, align: number) => number,
  ): number {
    // 没有 reallocate 时只能用 UTF-8 字节长度分配（原实现的另一条分支，保留以保持行为一致）
    if (!reallocate) {
      const encoded = this.cachedTextEncoder.encode(text)
      const ptr = allocate(encoded.length, 1) >>> 0
      const memory = this.getCachedUint8Memory()
      memory.subarray(ptr, ptr + encoded.length).set(encoded)
      this.offset = encoded.length
      return ptr
    }

    const strLength = text.length
    let ptr = allocate(strLength, 1) >>> 0
    const memory = this.getCachedUint8Memory()
    let asciiLength = 0

    // 先按字节逐个写 ASCII 字符，遇到第一个非 ASCII 字符就停下
    for (; asciiLength < strLength; asciiLength++) {
      const charCode = text.charCodeAt(asciiLength)
      if (charCode > 127) break
      memory[ptr + asciiLength] = charCode
    }

    if (asciiLength !== strLength) {
      if (asciiLength > 0) {
        text = text.slice(asciiLength)
      }

      // 预留 3 字节/字符（UTF-8 最坏情况），encodeInto 之后再把多余空间缩回去
      ptr = reallocate(ptr, strLength, asciiLength + text.length * 3, 1) >>> 0

      const result = this.cachedTextEncoder.encodeInto(
        text,
        this.getCachedUint8Memory().subarray(ptr + asciiLength, ptr + asciiLength + text.length * 3),
      )
      asciiLength += result.written

      ptr = reallocate(ptr, asciiLength + text.length * 3, asciiLength, 1) >>> 0
    }

    this.offset = asciiLength
    return ptr
  }

  /** 取 wasm 线性内存视图；wasm 扩容会使旧视图 detach（byteLength 变 0）或换 buffer */
  private getCachedUint8Memory(): Uint8Array {
    const buffer = this.wasmInstance.memory.buffer
    if (
      this.cachedUint8Memory === null ||
      this.cachedUint8Memory.byteLength === 0 ||
      this.cachedUint8Memory.buffer !== buffer
    ) {
      this.cachedUint8Memory = new Uint8Array(buffer)
    }
    return this.cachedUint8Memory
  }

  /**
   * 计算 PoW 答案（CPU 密集，同步执行）。
   * 返回 undefined 表示未在难度要求内找到答案。
   */
  public calculateHash(
    algorithm: string,
    challenge: string,
    salt: string,
    difficulty: number,
    expireAt: number,
  ): number | undefined {
    if (algorithm !== 'DeepSeekHashV1') {
      throw new Error('Unsupported algorithm: ' + algorithm)
    }

    // 前缀格式与原实现一致：`${salt}_${expireAt}_`
    const prefix = `${salt}_${expireAt}_`

    try {
      // 在 wasm 栈上留 16 字节存放返回值（前 4 字节 status，偏移 8 处是 float64 答案）
      const retptr = this.wasmInstance.__wbindgen_add_to_stack_pointer(-16)

      const ptr0 = this.encodeString(
        challenge,
        this.wasmInstance.__wbindgen_export_0,
        this.wasmInstance.__wbindgen_export_1,
      )
      const len0 = this.offset

      const ptr1 = this.encodeString(
        prefix,
        this.wasmInstance.__wbindgen_export_0,
        this.wasmInstance.__wbindgen_export_1,
      )
      const len1 = this.offset

      this.wasmInstance.wasm_solve(retptr, ptr0, len0, ptr1, len1, difficulty)

      const dataView = new DataView(this.wasmInstance.memory.buffer)
      const status = dataView.getInt32(retptr + 0, true)
      const value = dataView.getFloat64(retptr + 8, true)

      if (status === 0) return undefined

      return value
    } finally {
      // 恢复栈指针
      this.wasmInstance.__wbindgen_add_to_stack_pointer(16)
    }
  }

  /** 实例化 wasm 模块（wbg 命名空间留空即可，该 wasm 没有实际 import） */
  public async init(): Promise<any> {
    const imports = { wbg: {} }
    const instantiated: any = await WebAssembly.instantiate(wasmModule as any, imports)
    // 传 Module 时返回 Instance；传 bytes 时返回 { instance, module }。这里两种都兼容。
    const instance: WebAssembly.Instance = (instantiated?.instance ?? instantiated) as WebAssembly.Instance
    this.wasmInstance = instance.exports
    return this.wasmInstance
  }
}

/** 模块级单例：每个 isolate 内只实例化一次 wasm */
let deepSeekHashInstance: Promise<DeepSeekHash> | null = null

/** 获取（惰性初始化）PoW 解算器 */
export function getDeepSeekHash(): Promise<DeepSeekHash> {
  if (!deepSeekHashInstance) {
    deepSeekHashInstance = (async () => {
      const hash = new DeepSeekHash()
      await hash.init()
      return hash
    })().catch((error) => {
      // 初始化失败时清空单例，下次调用可以重试
      deepSeekHashInstance = null
      throw error
    })
  }
  return deepSeekHashInstance
}

export default DeepSeekHash
