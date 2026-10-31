/**
 * 内置供应商注册表（slim 单供应商版：只有 deepseek）
 * 上游：Chat2API src/main/providers/builtin/index.ts
 */
import deepseekConfig from './deepseek.ts'
import type { BuiltinProviderConfig } from '../../store/types.ts'

export const builtinProviders: BuiltinProviderConfig[] = [
  deepseekConfig,
]

export const builtinProviderMap: Record<string, BuiltinProviderConfig> = {
  deepseek: deepseekConfig,
}

export function getBuiltinProvider(id: string): BuiltinProviderConfig | undefined {
  return builtinProviderMap[id]
}

export function getBuiltinProviders(): BuiltinProviderConfig[] {
  return builtinProviders
}

export { deepseekConfig }

export default builtinProviders
