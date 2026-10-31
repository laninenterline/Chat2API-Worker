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
  assert.ok(!matchModelPattern('claude-*', 'gpt-4o'))
})

test('账号增删 + round-robin', async () => {
  const store = new Store({ KV: fakeKV() } as any)
  await store.addAccount({ provider: 'deepseek', credentials: { token: 'a' }, name: 'a' })
  await store.addAccount({ provider: 'deepseek', credentials: { token: 'b' }, name: 'b' })
  const list = await store.accounts()
  assert.equal(list.length, 2)

  const first = await store.pickAccount('deepseek')
  const second = await store.pickAccount('deepseek')
  assert.notEqual(first!.id, second!.id)

  assert.equal(await store.removeAccount(first!.id), true)
  assert.equal((await store.accounts()).length, 1)
})

test('resolveModel：模型直连 / 映射 / 通配符', async () => {
  const store = new Store({ KV: fakeKV() } as any)
  const direct = await store.resolveModel('deepseek-v4.1-flash')
  assert.equal(direct!.provider.id, 'deepseek')
  assert.equal(direct!.actualModel, 'deepseek-v4.1-flash')

  await (store.env.KV as any).put('config', JSON.stringify({ modelMappings: { 'claude-*': 'deepseek-v4.1-flash' } }))
  store.invalidate()
  const alias = await store.resolveModel('claude-3-5-sonnet')
  assert.equal(alias!.provider.id, 'deepseek')
  assert.equal(alias!.actualModel, 'deepseek-v4.1-flash')

  await store.addAccount({ provider: 'deepseek', credentials: { token: 't' } })
  const unknown = await store.resolveModel('some-unknown-model')
  assert.equal(unknown!.provider.id, 'deepseek')
})
