/**
 * Provider 元数据目录（单供应商版：MiniMax）
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
    id: 'minimax',
    name: 'MiniMax',
    models: ["MiniMax-M3.1-Flash"],
    aliases: ["MiniMax-M2.7"],
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
