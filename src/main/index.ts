/**
 * slim 版入口
 *
 * 上游对应：Chat2API `src/main/index.ts`（Electron 主进程入口：创建窗口、托盘、IPC、自动更新...）
 * slim 版去掉所有 GUI/Electron 逻辑，只做：
 *   1. 读取 config.json
 *   2. 初始化 store（账号池 + 负载均衡配置）
 *   3. 启动 Koa 服务
 */

import path from 'path'
import { storeManager } from './store/store'
import { sessionManager } from './proxy/sessionManager'
import { startServer } from './proxy/server'

async function main(): Promise<void> {
  const configPath = process.env.CONFIG_PATH || path.resolve(process.cwd(), 'config.json')

  // 初始化存储（账号、供应商、模型映射、上下文管理配置）
  storeManager.init(configPath)

  // MiniMax adapter 内部通过 global.storeManager 读取 mode 配置，上游就是这么用的
  ;(global as any).storeManager = storeManager

  // 会话清理定时器
  sessionManager.initialize()

  const { server } = await startServer()

  const shutdown = (signal: string): void => {
    console.log(`\n[App] 收到 ${signal}，正在关闭...`)
    sessionManager.destroy()
    server.close(() => process.exit(0))
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

main().catch((error) => {
  console.error('[App] 启动失败:', error)
  process.exit(1)
})
