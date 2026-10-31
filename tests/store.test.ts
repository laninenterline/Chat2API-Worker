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
  await store.addAccount({ provider: 'minimax', credentials: { token: 'a' }, name: 'a' })
  await store.addAccount({ provider: 'minimax', credentials: { token: 'b' }, name: 'b' })
  const list = await store.accounts()
  assert.equal(list.length, 2)

  const first = await store.pickAccount('minimax')
  const second = await store.pickAccount('minimax')
  assert.notEqual(first!.id, second!.id)

  assert.equal(await store.removeAccount(first!.id), true)
  assert.equal((await store.accounts()).length, 1)
})

test('resolveModel：模型直连 / 映射 / 通配符', async () => {
  const store = new Store({ KV: fakeKV() } as any)
  const direct = await store.resolveModel('MiniMax-M3.1-Flash')
  assert.equal(direct!.provider.id, 'minimax')
  assert.equal(direct!.actualModel, 'MiniMax-M3.1-Flash')

  await (store.env.KV as any).put('config', JSON.stringify({ modelMappings: { 'claude-*': 'MiniMax-M3.1-Flash' } }))
  store.invalidate()
  const alias = await store.resolveModel('claude-3-5-sonnet')
  assert.equal(alias!.provider.id, 'minimax')
  assert.equal(alias!.actualModel, 'MiniMax-M3.1-Flash')

  await store.addAccount({ provider: 'minimax', credentials: { token: 't' } })
  const unknown = await store.resolveModel('some-unknown-model')
  assert.equal(unknown!.provider.id, 'minimax')
})
