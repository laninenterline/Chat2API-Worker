import type { Account, Env, ProviderId } from './types.ts'
import { PROVIDER_CATALOG, findProviderMetaByModel, getProviderMeta, type ProviderMeta } from './providers/catalog.ts'

export interface WorkerConfig {
  apiKeys: string[]
  adminKey: string
  strategy: 'round-robin' | 'fill-first' | 'failover'
  modelMappings: Record<string, string>
}

const ACCOUNTS_KEY = 'accounts'
const CONFIG_KEY = 'config'
const FAILURE_COOLDOWN_MS = 60_000
const CACHE_TTL_MS = 3_000

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** `*` 通配符匹配（大小写不敏感） */
export function matchModelPattern(pattern: string, model: string): boolean {
  const p = pattern.trim().toLowerCase()
  const m = model.trim().toLowerCase()
  if (!p) return false
  if (!p.includes('*')) return p === m
  const re = new RegExp('^' + p.split('*').map(escapeRegExp).join('.*') + '$')
  return re.test(m)
}

export class Store {
  private accountsCache?: { at: number; value: Account[] }
  private configCache?: { at: number; value: WorkerConfig }
  private cursors = new Map<string, number>()
  private failures = new Map<string, number>()
  private lastUsed = new Map<string, number>()
  private stats = { total: 0, success: 0, failed: 0, lastError: '' }

  constructor(readonly env: Env) {}

  // ---------------- 配置 ----------------

  async config(): Promise<WorkerConfig> {
    if (this.configCache && Date.now() - this.configCache.at < CACHE_TTL_MS) return this.configCache.value
    let stored: any = {}
    try {
      if (this.env.KV) stored = (await this.env.KV.get(CONFIG_KEY, 'json')) || {}
    } catch {}
    const envKeys = (this.env.API_KEYS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    const value: WorkerConfig = {
      apiKeys: envKeys.length > 0 ? envKeys : Array.isArray(stored.apiKeys) ? stored.apiKeys : [],
      adminKey: this.env.ADMIN_KEY || stored.adminKey || '',
      strategy: ((this.env.LOAD_BALANCE_STRATEGY as any) || stored.strategy || 'round-robin') as any,
      modelMappings: { ...(stored.modelMappings || {}) },
    }
    this.configCache = { at: Date.now(), value }
    return value
  }

  invalidate(): void {
    this.accountsCache = undefined
    this.configCache = undefined
  }

  // ---------------- 账号 ----------------

  async accounts(): Promise<Account[]> {
    if (this.accountsCache && Date.now() - this.accountsCache.at < CACHE_TTL_MS) return [...this.accountsCache.value]
    let list: Account[] = []
    try {
      list = ((await this.env.KV?.get(ACCOUNTS_KEY, 'json')) as Account[]) || []
    } catch {}
    this.accountsCache = { at: Date.now(), value: list }
    return [...list]
  }

  private async saveAccounts(list: Account[]): Promise<void> {
    await this.env.KV.put(ACCOUNTS_KEY, JSON.stringify(list))
    this.accountsCache = { at: Date.now(), value: list }
  }

  async addAccount(input: { provider: ProviderId; credentials: Record<string, string>; name?: string; id?: string }): Promise<Account> {
    const list = await this.accounts()
    const account: Account = {
      id: input.id || `${input.provider}-${crypto.randomUUID().slice(0, 8)}`,
      provider: input.provider,
      name: input.name,
      credentials: input.credentials,
      status: 'active',
      lastUsed: 0,
    }
    list.push(account)
    await this.saveAccounts(list)
    return account
  }

  async updateAccount(id: string, patch: Partial<Account>): Promise<Account | null> {
    const list = await this.accounts()
    const idx = list.findIndex((a) => a.id === id)
    if (idx < 0) return null
    list[idx] = { ...list[idx], ...patch, id }
    await this.saveAccounts(list)
    return list[idx]
  }

  async removeAccount(id: string): Promise<boolean> {
    const list = await this.accounts()
    const next = list.filter((a) => a.id !== id)
    if (next.length === list.length) return false
    await this.saveAccounts(next)
    return true
  }

  /** 选一个可用账号（round-robin / fill-first / failover + 60s 失败冷却） */
  async pickAccount(providerId: ProviderId): Promise<Account | null> {
    const cfg = await this.config()
    const list = (await this.accounts()).filter((a) => a.provider === providerId && a.status !== 'error')
    if (list.length === 0) return null

    const now = Date.now()
    const healthy = list.filter((a) => {
      const failedAt = this.failures.get(a.id)
      return !failedAt || now - failedAt > FAILURE_COOLDOWN_MS
    })
    const pool = healthy.length > 0 ? healthy : list

    if (cfg.strategy === 'fill-first' || cfg.strategy === 'failover') {
      const account = pool[0]
      this.lastUsed.set(account.id, now)
      return account
    }
    const cursor = this.cursors.get(providerId) ?? 0
    const account = pool[cursor % pool.length]
    this.cursors.set(providerId, cursor + 1)
    this.lastUsed.set(account.id, now)
    return account
  }

  markAccountFailed(id: string, reason: string): void {
    this.failures.set(id, Date.now())
    this.stats.lastError = reason
  }

  clearAccountFailure(id: string): void {
    this.failures.delete(id)
  }

  // ---------------- 模型映射 ----------------

  /** 把客户端模型名解析成 provider + 实际模型名 */
  async resolveModel(requested: string): Promise<{ provider: ProviderMeta; actualModel: string } | null> {
    const cfg = await this.config()
    const mappings = cfg.modelMappings

    // 精确匹配优先，其次通配符（取最长 pattern）
    let actual: string | undefined
    if (mappings[requested] !== undefined) {
      actual = mappings[requested]
    } else {
      const candidates = Object.keys(mappings)
        .filter((k) => k.includes('*') && matchModelPattern(k, requested))
        .sort((a, b) => b.length - a.length)
      if (candidates.length > 0) actual = mappings[candidates[0]]
    }

    const modelToResolve = actual || requested
    let provider = findProviderMetaByModel(modelToResolve) || findProviderMetaByModel(requested)

    if (!provider) {
      const accounts = await this.accounts()
      const candidate = accounts.find((a) => a.status !== 'error')
      if (candidate) provider = getProviderMeta(candidate.provider)
    }

    if (!provider) return null
    return { provider, actualModel: modelToResolve }
  }

  // ---------------- 统计 ----------------

  record(success: boolean, error?: string): void {
    this.stats.total++
    if (success) this.stats.success++
    else {
      this.stats.failed++
      if (error) this.stats.lastError = error
    }
  }

  snapshot() {
    const accountsByProvider: Record<string, number> = {}
    for (const p of PROVIDER_CATALOG) accountsByProvider[p.id] = 0
    return {
      stats: { ...this.stats },
      accountsByProvider,
      lastUsed: Object.fromEntries(this.lastUsed),
      failingAccounts: [...this.failures.keys()],
    }
  }

  accountsSnapshot() {
    return this.accounts().then(async (list) => {
      const byProvider: Record<string, number> = {}
      for (const a of list) byProvider[a.provider] = (byProvider[a.provider] || 0) + 1
      return { total: list.length, byProvider, accounts: list.map(maskAccount) }
    })
  }
}

export function maskAccount(account: Account): any {
  const credentials: Record<string, string> = {}
  for (const [k, v] of Object.entries(account.credentials || {})) {
    credentials[k] = typeof v === 'string' && v.length > 4 ? `${v.slice(0, 2)}***${v.slice(-2)}(${v.length})` : '***'
  }
  return { ...account, credentials }
}
