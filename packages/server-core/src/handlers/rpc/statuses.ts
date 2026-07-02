import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { getWorkspaceByNameOrId } from '@craft-agent/shared/config'
import type { RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'

// 本文件属于 Statuses RPC 模块，负责：workspace 内会话状态（status）的列表与排序。
// Agent 概念：status 表示 session 当前所处阶段（如进行中、等待中、已完成等），
// 与 label 不同，status 更强调工作流状态机。

// 本 handler 负责注册的 status channel 列表
export const HANDLED_CHANNELS = [
  RPC_CHANNELS.statuses.LIST,
  RPC_CHANNELS.statuses.REORDER,
] as const

// registerStatusesHandlers：注册会话状态相关 RPC 路由。
export function registerStatusesHandlers(server: RpcServer, _deps: HandlerDeps): void {
  // 列出 workspace 下所有 status
  server.handle(RPC_CHANNELS.statuses.LIST, async (_ctx, workspaceId: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error('Workspace not found')

    const { listStatuses } = await import('@craft-agent/shared/statuses')
    return listStatuses(workspace.rootPath)
  })

  // 拖拽排序 status：接收排序后的 id 数组，写回配置文件。
  // ConfigWatcher 会检测文件变化并广播 STATUSES_CHANGED，UI 随后自动刷新。
  server.handle(RPC_CHANNELS.statuses.REORDER, async (_ctx, workspaceId: string, orderedIds: string[]) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error('Workspace not found')

    const { reorderStatuses } = await import('@craft-agent/shared/statuses')
    reorderStatuses(workspace.rootPath, orderedIds)
  })
}
