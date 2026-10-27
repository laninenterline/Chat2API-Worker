import './setup.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Store, matchModelPattern } from '../src/worker/store.ts'

function fakeKV() {
  const map = new Map<string, string>()
  return {
    async get(key: string, type?: string) {
      const value = map.get(key)
      if (value === undefined) return null
      return type === 'json' ? JSON.parse(value) : value
    },
    async put(key: string, value: string) {
      map.set(key, value)
    },
    async delete(key: string) {
      map.delete(key)
    },
  }
}

test('matchModelPattern 通配符', () => {
  assert.ok(matchModelPattern('claude-*', 'claude-3-5-sonnet'))
  assert.ok(matchModelPattern('*flash*', 'GLM-5.3-Flash'))
  assert.ok(!matchModelPattern('claude-*', 'gpt-4o'))
})

test('账号增删 + round-robin', async () => {
  const store = new Store({ KV: fakeKV() } as any)
  await store.addAccount({ provider: 'glm', credentials: { refresh_token: 'a' }, name: 'a' })
  await store.addAccount({ provider: 'glm', credentials: { refresh_token: 'b' }, name: 'b' })
  const list = await store.accounts()
  assert.equal(list.length, 2)

  const first = await store.pickAccount('glm')
  const second = await store.pickAccount('glm')
  assert.notEqual(first!.id, second!.id)

  assert.equal(await store.removeAccount(first!.id), true)
  assert.equal((await store.accounts()).length, 1)
})

test('resolveModel：模型直连 / 映射 / 通配符', async () => {
  const store = new Store({ KV: fakeKV() } as any)
  // 内置模型名直接匹配
  const direct = await store.resolveModel('GLM-5.3')
  assert.equal(direct!.provider.id, 'glm')
  assert.equal(direct!.actualModel, 'GLM-5.3')

  // 配置映射 + 通配符
  await (store.env.KV as any).put('config', JSON.stringify({ modelMappings: { 'claude-*': 'GLM-5.3', 'ds': 'deepseek-v4.1-flash' } }))
  store.invalidate()
  const alias = await store.resolveModel('claude-3-5-sonnet')
  assert.equal(alias!.provider.id, 'glm')
  assert.equal(alias!.actualModel, 'GLM-5.3')

  const ds = await store.resolveModel('ds')
  assert.equal(ds!.provider.id, 'deepseek')
  assert.equal(ds!.actualModel, 'deepseek-v4.1-flash')

  // 未知模型：有 deepseek 账号时回退到第一个账号的 provider
  await store.addAccount({ provider: 'deepseek', credentials: { token: 't' } })
  const unknown = await store.resolveModel('some-unknown-model')
  assert.equal(unknown!.provider.id, 'deepseek')
})
