/**
 * slim 版存储层
 *
 * 上游对应：Chat2API `src/main/store/store.ts`（Electron + electron-store，1764 行）
 *
 * 剥离思路：
 * - 上游把账号/供应商/配置/会话/统计都塞进 electron-store（带加密），并依赖 IPC 与渲染进程通信；
 * - slim 版只保留 HTTP 服务真正用到的那部分，用一个 `config.json` + 内存 Session 表实现；
 * - 对外 API 名称与上游保持一致（getConfig / getAccountsByProviderId / getEffectiveModels /
 *   getSessionById ...），这样 adapter、forwarder、sessionManager 可以几乎零改动复用。
 *
 * 与上游的差异：
 * - 不做凭据加密（上游用 electron-store + safeStorage 混淆）；自用场景请自行限制 config.json 权限；
 * - Session 只在内存中，进程重启即失效（上游会持久化）；
 * - 新增 `mode` 字段（single/multi），供 MiniMax adapter 判断是否需要清会话。
 */

import fs from 'fs'
import type {
  Account,
  AccountStatus,
  AppConfig,
  BuiltinProviderConfig,
  LoadBalanceStrategy,
  ModelMapping,
  Provider,
  SessionConfig,
  SessionRecord,
} from './types'
import { BUILTIN_PROVIDERS, DEFAULT_CONFIG } from './types'

/** config.json 里的账号条目（比 Account 少一些运行时字段） */
export interface SlimAccountConfig {
  /** 不填会自动生成，如 acc-deepseek-1 */
  id?: string
  name?: string
  /** providerId：deepseek / glm / minimax */
  provider: string
  /** 凭据：deepseek -> { token }；glm -> { refresh_token }；minimax -> { token, realUserID? } */
  credentials: Record<string, string>
  status?: AccountStatus
  email?: string
}

/** 单个供应商的覆盖配置（可选） */
export interface SlimProviderOverride {
  enabled?: boolean
  /** 覆盖上游地址（例如把 openai 指到本地 mock/中转） */
  apiEndpoint?: string
  /** 覆盖 chat 路径 */
  chatPath?: string
  /** 额外加的模型：{ displayName, actualModelId } */
  extraModels?: Array<{ displayName: string; actualModelId: string }>
  /** 隐藏内置模型 */
  excludedModels?: string[]
  /** 覆盖内置模型映射 */
  modelMappings?: Record<string, string>
}

/** config.json 的结构 */
export interface SlimConfigFile {
  /** 监听地址，默认 127.0.0.1 */
  host?: string
  port?: number
  /** 客户端调用本服务时用的 key 列表；为空表示不校验 */
  apiKeys?: string[]
  /** 管理接口 /v0/management 的 key；为空表示管理接口关闭 */
  adminKey?: string
  /** 负载均衡策略：round-robin / fill-first / failover */
  loadBalanceStrategy?: LoadBalanceStrategy
  /** 会话模式：single（每次请求后清理上游会话）/ multi（保留上下文） */
  mode?: 'single' | 'multi'
  retryCount?: number
  requestTimeout?: number
  /** 模型映射：'claude-3-5-sonnet' -> 'deepseek-v4-pro' 或带首选供应商的对象 */
  modelMappings?: Record<string, string | ModelMapping>
  /** 供应商级覆盖 */
  providers?: Record<string, SlimProviderOverride>
  /** 账号列表 */
  accounts?: SlimAccountConfig[]
  /** 上下文管理（滑窗 / token 上限 / 摘要） */
  contextManagement?: Partial<AppConfig['contextManagement']>
}

/**
 * electron-store 的最小替身
 * 上游 modelMapper 会调用 storeManager.getStore()?.set('config', config) 落盘，
 * 这里映射成“写回 config.json”。
 */
class StoreShim {
  constructor(private readonly owner: StoreManager) {}

  get(key: string): any {
    if (key === 'config') return this.owner.getConfig()
    return undefined
  }

  set(key: string, value: any): void {
    if (key === 'config') {
      this.owner.replaceConfig(value)
    }
  }
}

/** 请求日志条目（slime 版只放内存，最多保留 MAX_LOGS 条） */
export interface SlimRequestLog {
  id: string
  timestamp: number
  status: 'success' | 'error'
  statusCode: number
  method: string
  url: string
  model: string
  actualModel?: string
  providerId: string
  providerName?: string
  accountId: string
  accountName?: string
  requestBody?: string
  userInput?: string
  webSearch?: boolean
  reasoningEffort?: string
  responseStatus?: number
  responseBody?: string
  latency: number
  isStream: boolean
  errorMessage?: string
  errorStack?: string
}

/** 运行统计（管理接口 /v0/management/stats 用） */
export interface SlimRuntimeStats {
  totalRequests: number
  successRequests: number
  failedRequests: number
  latencySum: number
  modelUsage: Record<string, number>
  providerUsage: Record<string, number>
  accountUsage: Record<string, number>
}

function now(): number {
  return Date.now()
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value))
}

export class StoreManager {
  private config: AppConfig = clone(DEFAULT_CONFIG)
  private providers = new Map<string, Provider>()
  private accounts = new Map<string, Account>()
  private sessions = new Map<string, SessionRecord>()
  private slimFile: SlimConfigFile = {}
  private configPath = ''
  private shim = new StoreShim(this)
  private counter = 0
  private logs: SlimRequestLog[] = []
  private stats: SlimRuntimeStats = {
    totalRequests: 0,
    successRequests: 0,
    failedRequests: 0,
    latencySum: 0,
    modelUsage: {},
    providerUsage: {},
    accountUsage: {},
  }
  private readonly MAX_LOGS = 500
  private readonly MAX_DEBUG_LOGS = 500
  private debugLogs: Array<{ level: string; message: string; meta?: any; timestamp: number }> = []

  /** 启动时调用一次：加载配置、初始化供应商与账号 */
  init(configPath: string): void {
    this.configPath = configPath
    this.loadFile()
    this.initProviders()
    this.initAccounts()
    console.log(`[Store] 已加载配置: ${configPath}`)
    console.log(`[Store] 供应商: ${[...this.providers.keys()].join(', ')}`)
    console.log(`[Store] 账号数: ${this.accounts.size}`)
  }

  // -------------------------------------------------------------------------
  // 配置
  // -------------------------------------------------------------------------

  getConfig(): AppConfig {
    // mode 不在 AppConfig 类型里，但 MiniMax adapter 会读 (global as any).storeManager.getConfig().mode
    return { ...this.config, mode: this.slimFile.mode || 'single' } as AppConfig
  }

  replaceConfig(next: AppConfig): void {
    this.config = { ...this.config, ...next }
    this.persist()
  }

  updateConfig(patch: Partial<AppConfig>): AppConfig {
    this.config = { ...this.config, ...patch }
    this.persist()
    return this.config
  }

  getStore(): StoreShim {
    return this.shim
  }

  getSlimConfig(): SlimConfigFile {
    return this.slimFile
  }

  // -------------------------------------------------------------------------
  // 供应商
  // -------------------------------------------------------------------------

  getProviders(): Provider[] {
    return [...this.providers.values()]
  }

  getProviderById(id: string): Provider | undefined {
    return this.providers.get(id)
  }

  /** 供应商下所有可用模型（内置 + 额外 - 排除），带实际模型 ID */
  getEffectiveModels(providerId: string): Array<{
    displayName: string
    actualModelId: string
    isCustom: boolean
  }> {
    const provider = this.providers.get(providerId)
    if (!provider) return []

    const override = this.slimFile.providers?.[providerId]
    const excluded = new Set(override?.excludedModels || [])
    const mappings = { ...(provider.modelMappings || {}), ...(override?.modelMappings || {}) }

    const models: Array<{ displayName: string; actualModelId: string; isCustom: boolean }> = []
    for (const displayName of provider.supportedModels || []) {
      if (excluded.has(displayName)) continue
      models.push({
        displayName,
        actualModelId: mappings[displayName] || displayName,
        isCustom: false,
      })
    }
    for (const extra of override?.extraModels || []) {
      models.push({ ...extra, isCustom: true })
    }
    return models
  }

  // -------------------------------------------------------------------------
  // 账号
  // -------------------------------------------------------------------------

  getAccounts(): Account[] {
    return [...this.accounts.values()]
  }

  getAccountById(id: string): Account | undefined {
    return this.accounts.get(id)
  }

  /**
   * @param providerId 供应商 ID
   * @param activeOnly 只返回 status === 'active' 的账号（loadbalancer 会这样调用）
   */
  getAccountsByProviderId(providerId: string, activeOnly = false): Account[] {
    const list = [...this.accounts.values()].filter((a) => a.providerId === providerId)
    return activeOnly ? list.filter((a) => a.status === 'active') : list
  }

  addAccount(input: SlimAccountConfig): Account {
    const provider = this.providers.get(input.provider)
    if (!provider) {
      throw new Error(`未知供应商: ${input.provider}`)
    }
    const id = input.id || `acc-${input.provider}-${++this.counter}`
    if (this.accounts.has(id)) {
      throw new Error(`账号 ID 已存在: ${id}`)
    }
    const ts = now()
    const account: Account = {
      id,
      providerId: input.provider,
      name: input.name || `${provider.name} 账号 ${this.accounts.size + 1}`,
      email: input.email,
      credentials: { ...input.credentials },
      status: input.status || 'active',
      createdAt: ts,
      updatedAt: ts,
    }
    this.accounts.set(id, account)
    this.syncAccountsToFile()
    return account
  }

  /** 局部更新账号（GLM adapter 刷新 refresh_token 后会调用） */
  updateAccount(id: string, patch: Partial<Account>): Account {
    const current = this.accounts.get(id)
    if (!current) {
      throw new Error(`账号不存在: ${id}`)
    }
    const next: Account = { ...current, ...patch, updatedAt: now() }
    this.accounts.set(id, next)
    this.syncAccountsToFile()
    return next
  }

  deleteAccount(id: string): boolean {
    const ok = this.accounts.delete(id)
    if (ok) {
      for (const [sessionId, session] of this.sessions) {
        if (session.accountId === id) this.sessions.delete(sessionId)
      }
      this.syncAccountsToFile()
    }
    return ok
  }

  // -------------------------------------------------------------------------
  // 会话（对应上游 sessionManager 用到的 store 方法）
  // -------------------------------------------------------------------------

  getSessionConfig(): SessionConfig {
    return this.config.sessionConfig
  }

  updateSessionConfig(updates: Partial<SessionConfig>): SessionConfig {
    this.config.sessionConfig = { ...this.config.sessionConfig, ...updates }
    this.persist()
    return this.config.sessionConfig
  }

  addSession(session: SessionRecord): void {
    this.sessions.set(session.id, session)
  }

  getSessionById(id: string): SessionRecord | undefined {
    return this.sessions.get(id)
  }

  getSessions(): SessionRecord[] {
    return [...this.sessions.values()]
  }

  getActiveSessions(): SessionRecord[] {
    return this.getSessions().filter((s) => s.status === 'active')
  }

  getSessionsByProviderId(providerId: string): SessionRecord[] {
    return this.getSessions().filter((s) => s.providerId === providerId)
  }

  getSessionsByAccountId(accountId: string): SessionRecord[] {
    return this.getSessions().filter((s) => s.accountId === accountId)
  }

  deleteSession(id: string): boolean {
    return this.sessions.delete(id)
  }

  cleanExpiredSessions(): number {
    const timeoutMs = this.config.sessionConfig.sessionTimeout * 60 * 1000
    const deadline = now() - timeoutMs
    let removed = 0
    for (const [id, session] of this.sessions) {
      if (session.lastActiveAt < deadline) {
        this.sessions.delete(id)
        removed++
      }
    }
    return removed
  }

  clearAllSessions(): void {
    this.sessions.clear()
  }

  // -------------------------------------------------------------------------
  // 日志 / 统计（chat 路由会调用，上游由 requestLogs/appLogs 模块承担）
  // -------------------------------------------------------------------------

  addLog(level: string, message: string, meta?: any): void {
    this.debugLogs.push({ level, message, meta, timestamp: now() })
    if (this.debugLogs.length > this.MAX_DEBUG_LOGS) {
      this.debugLogs.splice(0, this.debugLogs.length - this.MAX_DEBUG_LOGS)
    }
  }

  getLogs(limit = 100): Array<{ level: string; message: string; meta?: any; timestamp: number }> {
    return this.debugLogs.slice(-limit)
  }

  addRequestLog(entry: Omit<SlimRequestLog, 'id'>): SlimRequestLog {
    const record: SlimRequestLog = { ...entry, id: `log-${now()}-${++this.counter}` }
    this.logs.push(record)
    if (this.logs.length > this.MAX_LOGS) {
      this.logs.splice(0, this.logs.length - this.MAX_LOGS)
    }
    return record
  }

  updateRequestLog(id: string, patch: Partial<SlimRequestLog>): void {
    const record = this.logs.find((item) => item.id === id)
    if (record) Object.assign(record, patch)
  }

  getRequestLogs(limit = 50): SlimRequestLog[] {
    return this.logs.slice(-limit)
  }

  recordRequestInStats(
    success: boolean,
    latency: number,
    model: string,
    providerId: string,
    accountId: string
  ): void {
    this.stats.totalRequests++
    if (success) this.stats.successRequests++
    else this.stats.failedRequests++
    this.stats.latencySum += latency
    this.stats.modelUsage[model] = (this.stats.modelUsage[model] || 0) + 1
    this.stats.providerUsage[providerId] = (this.stats.providerUsage[providerId] || 0) + 1
    this.stats.accountUsage[accountId] = (this.stats.accountUsage[accountId] || 0) + 1
  }

  getStats(): SlimRuntimeStats & { avgLatency: number } {
    return {
      ...this.stats,
      avgLatency: this.stats.totalRequests > 0 ? this.stats.latencySum / this.stats.totalRequests : 0,
    }
  }

  // -------------------------------------------------------------------------
  // 初始化 / 持久化
  // -------------------------------------------------------------------------

  private loadFile(): void {
    if (!fs.existsSync(this.configPath)) {
      this.slimFile = {}
      return
    }
    const raw = fs.readFileSync(this.configPath, 'utf8')
    this.slimFile = JSON.parse(raw) as SlimConfigFile

    // 配置项合并进 AppConfig
    this.config = {
      ...this.config,
      proxyHost: this.slimFile.host || this.config.proxyHost,
      proxyPort: this.slimFile.port || this.config.proxyPort,
      loadBalanceStrategy: this.slimFile.loadBalanceStrategy || this.config.loadBalanceStrategy,
      retryCount: this.slimFile.retryCount ?? this.config.retryCount,
      requestTimeout: this.slimFile.requestTimeout ?? this.config.requestTimeout,
      modelMappings: this.normalizeMappings(this.slimFile.modelMappings || {}),
      contextManagement: {
        ...this.config.contextManagement,
        ...(this.slimFile.contextManagement || {}),
      },
    }
  }

  private normalizeMappings(
    input: Record<string, string | ModelMapping>
  ): Record<string, ModelMapping> {
    const out: Record<string, ModelMapping> = {}
    for (const [requestModel, value] of Object.entries(input)) {
      out[requestModel] =
        typeof value === 'string'
          ? { requestModel, actualModel: value }
          : { ...value, requestModel }
    }
    return out
  }

  private initProviders(): void {
    const ts = now()
    for (const builtin of BUILTIN_PROVIDERS) {
      this.providers.set(
        builtin.id,
        this.materializeProvider(builtin, this.slimFile.providers?.[builtin.id], ts)
      )
    }
  }

  private materializeProvider(
    builtin: BuiltinProviderConfig,
    override: SlimProviderOverride | undefined,
    ts: number
  ): Provider {
    const { credentialFields: _credentialFields, ...rest } = builtin
    return {
      ...rest,
      apiEndpoint: override?.apiEndpoint ?? rest.apiEndpoint,
      chatPath: override?.chatPath ?? rest.chatPath,
      enabled: override?.enabled ?? builtin.enabled,
      createdAt: ts,
      updatedAt: ts,
    }
  }

  private initAccounts(): void {
    for (const item of this.slimFile.accounts || []) {
      try {
        this.addAccount(item)
      } catch (error) {
        console.error('[Store] 账号加载失败:', item, error)
      }
    }
  }

  /** 把内存里的账号写回 config.json（token 刷新后需要落盘） */
  private syncAccountsToFile(): void {
    this.slimFile.accounts = this.getAccounts().map((account) => ({
      id: account.id,
      name: account.name,
      provider: account.providerId,
      credentials: account.credentials,
      status: account.status,
      email: account.email,
    }))
    this.persist()
  }

  /** 把内存状态写回 config.json（账号 token 刷新、管理接口改配置都会触发） */
  private persist(): void {
    if (!this.configPath) return

    // ModelMapping -> config.json 里的紧凑写法（只保留关键字段）
    const modelMappings: Record<string, ModelMapping> = {}
    for (const [requestModel, mapping] of Object.entries(this.config.modelMappings)) {
      const compact: ModelMapping = {
        requestModel,
        actualModel: mapping.actualModel,
      }
      if (mapping.preferredProviderId) compact.preferredProviderId = mapping.preferredProviderId
      if (mapping.preferredAccountId) compact.preferredAccountId = mapping.preferredAccountId
      modelMappings[requestModel] = compact
    }

    const data: SlimConfigFile = {
      ...this.slimFile,
      host: this.config.proxyHost,
      port: this.config.proxyPort,
      apiKeys: this.slimFile.apiKeys,
      adminKey: this.slimFile.adminKey,
      loadBalanceStrategy: this.config.loadBalanceStrategy,
      mode: this.slimFile.mode || 'single',
      retryCount: this.config.retryCount,
      requestTimeout: this.config.requestTimeout,
      modelMappings,
      providers: this.slimFile.providers,
      contextManagement: this.config.contextManagement,
      accounts: this.slimFile.accounts || [],
    }
    fs.writeFileSync(this.configPath, JSON.stringify(data, null, 2), 'utf8')
  }
}

export const storeManager = new StoreManager()
export default storeManager
