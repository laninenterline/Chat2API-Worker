/**
 * Provider 元数据目录（不引入具体实现，避免测试/工具链加载 wasm 等运行时依赖）
 */
import type { ProviderId } from '../types.ts'

export interface ProviderMeta {
  id: ProviderId
  name: string
  models: string[]
  aliases: string[]
}

export const PROVIDER_CATALOG: ProviderMeta[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    models: ['deepseek-v4.1-flash'],
    aliases: ['deepseek-v4-flash', 'deepseek-v4-pro'],
  },
  {
    id: 'glm',
    name: 'GLM',
    models: ['GLM-5.3-Flash', 'GLM-5.3'],
    aliases: ['GLM-5.1', 'glm-4', 'glm-4-flash'],
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    models: ['MiniMax-M3.1-Flash'],
    aliases: ['MiniMax-M2.7'],
  },
]

export function findProviderMetaByModel(model: string): ProviderMeta | undefined {
  const target = model.trim().toLowerCase()
  return PROVIDER_CATALOG.find((p) =>
    [...p.models, ...p.aliases].some((m) => m.trim().toLowerCase() === target),
  )
}

export function getProviderMeta(id: ProviderId): ProviderMeta | undefined {
  return PROVIDER_CATALOG.find((p) => p.id === id)
}

export function allCatalogModelIds(): string[] {
  return PROVIDER_CATALOG.flatMap((p) => p.models)
}
