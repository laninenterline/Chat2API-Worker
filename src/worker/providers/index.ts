import type { ProviderAdapter, ProviderId } from '../types.ts'
import { minimax } from './minimax.ts'
import { PROVIDER_CATALOG, findProviderMetaByModel } from './catalog.ts'

export const allProviders: ProviderAdapter[] = [minimax]

export function getProvider(id: ProviderId): ProviderAdapter | undefined {
  return allProviders.find((p) => p.id === id)
}

export function findProviderByModel(model: string): ProviderAdapter | undefined {
  const meta = findProviderMetaByModel(model)
  return meta ? getProvider(meta.id) : undefined
}

export function allModelIds(): string[] {
  return PROVIDER_CATALOG.flatMap((p) => p.models)
}

export { PROVIDER_CATALOG }
export type { ProviderAdapter }
