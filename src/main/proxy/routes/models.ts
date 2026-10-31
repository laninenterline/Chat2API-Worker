/**
 * Proxy Service Module - Models Route
 * Implements /v1/models route
 */

import Router from '@koa/router'
import type { Context } from 'koa'
import { ModelsResponse, ModelInfo } from '../types'
import { loadBalancer } from '../loadbalancer'
import { storeManager } from '../../store/store'
import { modelMapper } from '../modelMapper'

const router = new Router({ prefix: '/v1' })

/**
 * Get all available models
 */
router.get('/models', async (ctx: Context) => {
  const providers = storeManager.getProviders().filter(p => p.enabled)
  const models: ModelInfo[] = []
  const addedModels = new Set<string>()

  for (const provider of providers) {
    const accounts = storeManager.getAccountsByProviderId(provider.id)
      .filter(account => account.status === 'active')

    if (accounts.length === 0) {
      continue
    }

    const effectiveModels = storeManager.getEffectiveModels(provider.id)
    for (const model of effectiveModels) {
      if (model.displayName === '*' || model.displayName.endsWith('*')) continue
      if (!addedModels.has(model.displayName)) {
        addedModels.add(model.displayName)
        models.push({
          id: model.displayName,
          object: 'model',
          created: Math.floor(provider.createdAt / 1000),
          owned_by: provider.name,
        })
      }
    }
  }

  const config = storeManager.getConfig()
  const mappings = config.modelMappings || {}
  for (const [requestModel, mapping] of Object.entries(mappings)) {
    if (!addedModels.has(requestModel)) {
      addedModels.add(requestModel)
      models.push({
        id: requestModel,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'model-mapping',
      })
    }
  }

  // Anthropic 客户端（Claude Code / DSH）用 anthropic-version 头，返回 Anthropic 形状的模型列表
  if (ctx.headers['anthropic-version']) {
    const data = models.map((model) => ({
      type: 'model' as const,
      id: model.id,
      display_name: model.id,
      created_at: new Date((model.created || Math.floor(Date.now() / 1000)) * 1000).toISOString(),
    }))
    ctx.body = {
      data,
      has_more: false,
      first_id: data[0]?.id ?? null,
      last_id: data[data.length - 1]?.id ?? null,
    }
    return
  }

  const response: ModelsResponse = {
    object: 'list',
    data: models,
  }

  ctx.set('Content-Type', 'application/json')
  ctx.body = response
})

/**
 * Get specified model info
 */
router.get('/models/:model', async (ctx: Context) => {
  const modelId = ctx.params.model

  const config = storeManager.getConfig()
  const mappings = config.modelMappings || {}
  if (mappings[modelId]) {
    ctx.set('Content-Type', 'application/json')
    ctx.body = {
      id: modelId,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'model-mapping',
    }
    return
  }

  const providers = storeManager.getProviders().filter(p => p.enabled)

  for (const provider of providers) {
    const accounts = storeManager.getAccountsByProviderId(provider.id)
      .filter(account => account.status === 'active')

    if (accounts.length === 0) {
      continue
    }

    const effectiveModels = storeManager.getEffectiveModels(provider.id)
    const normalizedModelId = modelId.toLowerCase()
    const found = effectiveModels.some(m => {
      const normalizedSupported = m.displayName.toLowerCase()
      if (normalizedSupported.endsWith('*')) {
        return normalizedModelId.startsWith(normalizedSupported.slice(0, -1))
      }
      return normalizedSupported === normalizedModelId
    })

    if (found) {
      ctx.set('Content-Type', 'application/json')
      ctx.body = {
        id: modelId,
        object: 'model',
        created: Math.floor(provider.createdAt / 1000),
        owned_by: provider.name,
      }
      return
    }
  }

  ctx.status = 404
  ctx.body = {
    error: {
      message: `Model '${modelId}' not found`,
      type: 'invalid_request_error',
      param: 'model',
      code: 'model_not_found',
    },
  }
})

export default router
