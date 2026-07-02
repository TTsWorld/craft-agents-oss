import { existsSync } from 'node:fs'
import { join } from 'path'
import { homedir } from 'os'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { addWorkspace, setActiveWorkspace } from '@craft-agent/shared/config'
import { getDefaultWorkspacesDir, ensureDefaultWorkspacesDir } from '@craft-agent/shared/workspaces'
import type { ServerStatus, ServerHealth } from '@craft-agent/core/types'
import type { RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import type { ServerHandlerContext } from '../../bootstrap/headless-start'

// 本文件属于 Server RPC 模块，负责：server 级别的 workspace 发现/创建、服务器状态/健康检查、活动 session 发现、home 目录查询。
// 与 workspace.ts 不同：server.ts 中的 handler 不依赖当前窗口的 workspace context，属于全局/服务器视角。
// TS 提示：type 关键字导入的类型在编译后会被擦除，不影响打包体积。

// 本 handler 负责注册的服务器级 channel 列表
export const HANDLED_CHANNELS = [
  RPC_CHANNELS.server.GET_WORKSPACES,
  RPC_CHANNELS.server.CREATE_WORKSPACE,
  RPC_CHANNELS.server.GET_STATUS,
  RPC_CHANNELS.server.GET_HEALTH,
  RPC_CHANNELS.server.GET_ACTIVE_SESSIONS,
  RPC_CHANNELS.server.HOME_DIR,
] as const

// registerServerHandlers：注册 server 级 RPC 路由。
// 第三个参数 ctx 来自 headless-start，包含 serverId、启动时间、客户端连接数等运行时信息。
export function registerServerHandlers(
  server: RpcServer,
  deps: HandlerDeps,
  ctx: ServerHandlerContext,
): void {
  const { sessionManager } = deps

  // -----------------------------------------------------------------------
  // Workspace 发现（从 workspace.ts 移过来：server 级别，无 workspace 上下文）
  // -----------------------------------------------------------------------

  // 获取所有 workspace 摘要信息
  server.handle(RPC_CHANNELS.server.GET_WORKSPACES, async () => {
    const workspaces = sessionManager.getWorkspacesInfo()
    deps.platform.logger.info(`[server:getWorkspaces] returning ${workspaces.length} workspaces: ${JSON.stringify(workspaces.map(w => ({ id: w.id, name: w.name })))}`)
    return workspaces
  })

  // 创建新 workspace，自动生成唯一 slug 和目录，设为当前活跃 workspace
  server.handle(RPC_CHANNELS.server.CREATE_WORKSPACE, async (_ctx, name: string) => {
    if (!name?.trim()) throw new Error('Workspace name is required')
    const trimmed = name.trim()

    const slug = trimmed
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      || 'workspace'

    ensureDefaultWorkspacesDir()
    const baseDir = getDefaultWorkspacesDir()
    let rootPath = join(baseDir, slug)
    let uniqueSlug = slug
    let counter = 1
    while (existsSync(rootPath)) {
      uniqueSlug = `${slug}-${counter++}`
      rootPath = join(baseDir, uniqueSlug)
    }

    const workspace = addWorkspace({ name: trimmed, rootPath })
    setActiveWorkspace(workspace.id)
    deps.platform.logger.info(`Created workspace "${trimmed}" at ${rootPath} (server:createWorkspace)`)

    // 返回 workspace 信息，但排除 rootPath/createdAt（server 接口不需要暴露路径）
    const { rootPath: _rp, createdAt: _ca, ...info } = workspace
    return info
  })

  // -----------------------------------------------------------------------
  // 服务器状态
  // -----------------------------------------------------------------------

  // 获取服务器运行状态，包括每个 workspace 的 session 数、automation 数、调度器状态、内存使用等。
  server.handle(RPC_CHANNELS.server.GET_STATUS, async () => {
    const workspaces = sessionManager.getWorkspacesInfo()
    const workspaceStatuses = workspaces.map(ws => {
      const summary = sessionManager.getWorkspaceAutomationSummary(ws.id)
      return {
        id: ws.id,
        name: ws.name,
        slug: ws.slug,
        activeSessions: sessionManager.getActiveSessionCount(ws.id),
        automationCount: summary.automationCount,
        schedulerRunning: summary.schedulerRunning,
      }
    })

    const mem = process.memoryUsage()
    const status: ServerStatus = {
      serverId: ctx.serverId,
      version: deps.platform.appVersion,
      uptime: Math.round((Date.now() - ctx.startedAt) / 1000),
      connectedClients: ctx.getConnectedClientCount(),
      workspaces: workspaceStatuses,
      memory: {
        heapUsed: mem.heapUsed,
        heapTotal: mem.heapTotal,
        rss: mem.rss,
      },
    }

    return status
  })

  // -----------------------------------------------------------------------
  // 服务器健康检查
  // -----------------------------------------------------------------------

  // 健康检查：同时被 RPC handler 和 HTTP endpoint 使用
  server.handle(RPC_CHANNELS.server.GET_HEALTH, async () => {
    return getHealthCheck(deps)
  })

  // -----------------------------------------------------------------------
  // 活跃会话发现
  // -----------------------------------------------------------------------

  // 获取当前所有活动 session 摘要
  server.handle(RPC_CHANNELS.server.GET_ACTIVE_SESSIONS, async () => {
    return sessionManager.getActiveSessionsInfo()
  })

  // -----------------------------------------------------------------------
  // 服务器 Home 目录（REMOTE_ELIGIBLE — 返回当前 server 的 home 目录）
  // -----------------------------------------------------------------------

  server.handle(RPC_CHANNELS.server.HOME_DIR, async () => {
    return homedir()
  })
}

// ---------------------------------------------------------------------------
// 健康检查逻辑（被 RPC handler 和 HTTP endpoint 复用）
// ---------------------------------------------------------------------------

// getHealthCheck：执行健康检查并聚合状态。
// TS 提示：Pick<T, K> 从 HandlerDeps 中挑选部分字段，类似 Golang 里只依赖接口的子集。
export function getHealthCheck(deps: Pick<HandlerDeps, 'sessionManager'>): ServerHealth {
  const checks: ServerHealth['checks'] = []

  // 检查 1：SessionManager 是否已初始化并加载 workspace
  try {
    const workspaces = deps.sessionManager.getWorkspaces()
    checks.push({
      name: 'session_manager',
      status: 'pass',
      message: `${workspaces.length} workspace(s) loaded`,
    })
  } catch {
    checks.push({
      name: 'session_manager',
      status: 'fail',
      message: 'SessionManager not initialized',
    })
  }

  // 检查 2：内存使用（heap 超过 1.5GB 视为异常）
  const mem = process.memoryUsage()
  const heapGB = mem.heapUsed / (1024 * 1024 * 1024)
  checks.push({
    name: 'memory',
    status: heapGB < 1.5 ? 'pass' : 'fail',
    message: `Heap: ${Math.round(heapGB * 100) / 100} GB`,
  })

  // 聚合状态
  const allPass = checks.every(c => c.status === 'pass')
  const anyFail = checks.some(c => c.status === 'fail')

  return {
    status: allPass ? 'ok' : anyFail ? 'unhealthy' : 'degraded',
    checks,
  }
}
