/**
 * 内置供应商注册表（slim 单供应商版：只有 glm）
 * 上游：Chat2API src/main/providers/builtin/index.ts
 */
import glmConfig from './glm.ts'
import type { BuiltinProviderConfig } from '../../store/types.ts'

export const builtinProviders: BuiltinProviderConfig[] = [
  glmConfig,
]

export const builtinProviderMap: Record<string, BuiltinProviderConfig> = {
  glm: glmConfig,
}

export function getBuiltinProvider(id: string): BuiltinProviderConfig | undefined {
  return builtinProviderMap[id]
}

export function getBuiltinProviders(): BuiltinProviderConfig[] {
  return builtinProviders
}

export { glmConfig }

export default builtinProviders
