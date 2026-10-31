/**
 * 内置供应商注册表（slim 单供应商版：只有 minimax）
 * 上游：Chat2API src/main/providers/builtin/index.ts
 */
import minimaxConfig from './minimax.ts'
import type { BuiltinProviderConfig } from '../../store/types.ts'

export const builtinProviders: BuiltinProviderConfig[] = [
  minimaxConfig,
]

export const builtinProviderMap: Record<string, BuiltinProviderConfig> = {
  minimax: minimaxConfig,
}

export function getBuiltinProvider(id: string): BuiltinProviderConfig | undefined {
  return builtinProviderMap[id]
}

export function getBuiltinProviders(): BuiltinProviderConfig[] {
  return builtinProviders
}

export { minimaxConfig }

export default builtinProviders
