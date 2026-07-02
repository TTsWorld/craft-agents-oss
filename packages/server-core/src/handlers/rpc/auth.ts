import { unlink } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { getCredentialManager } from '@craft-agent/shared/credentials'
import type { RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import { requestClientConfirmDialog } from '@craft-agent/server-core/transport'

// 本文件属于 Auth RPC 模块，负责：登录态注销、客户端确认对话框代理、凭证存储健康检查。
// 类比 Golang：相当于一个 gin/grpc handler 文件，注册到 RpcServer（路由总线）上，
// 每个 server.handle 对应一条 RPC 路由，ctx 类似 context.Context，携带 clientId/workspaceId 等元数据。

// 本 handler 负责注册的认证相关 channel 列表
export const HANDLED_CHANNELS = [
  RPC_CHANNELS.auth.LOGOUT,
  RPC_CHANNELS.auth.SHOW_LOGOUT_CONFIRMATION,
  RPC_CHANNELS.auth.SHOW_DELETE_SESSION_CONFIRMATION,
  RPC_CHANNELS.credentials.HEALTH_CHECK,
] as const

// registerAuthHandlers：将认证相关 RPC 路由注册到 RpcServer。
// TS 提示：void 表示函数无返回值，与 Golang 的 func(...)(...) 对应，只是省略返回类型。
export function registerAuthHandlers(server: RpcServer, deps: HandlerDeps): void {
  // 弹出“确认注销”对话框。这里把请求转发给客户端（renderer）渲染原生弹窗，
  // 等待用户点击后再把结果传回主进程，属于典型的请求-响应式 RPC。
  server.handle(RPC_CHANNELS.auth.SHOW_LOGOUT_CONFIRMATION, async (ctx) => {
    const result = await requestClientConfirmDialog(server, ctx.clientId, {
      type: 'warning',
      buttons: ['Cancel', 'Log Out'],
      defaultId: 0,
      cancelId: 0,
      title: 'Log Out',
      message: 'Are you sure you want to log out?',
      detail: 'All conversations will be deleted. This action cannot be undone.',
    })
    // result.response 是被点击按钮的索引：0=Cancel，1=Log Out
    return result.response === 1
  })

  // 弹出“确认删除会话”对话框，返回用户是否确认删除。
  server.handle(RPC_CHANNELS.auth.SHOW_DELETE_SESSION_CONFIRMATION, async (ctx, name: string) => {
    const result = await requestClientConfirmDialog(server, ctx.clientId, {
      type: 'warning',
      buttons: ['Cancel', 'Delete'],
      defaultId: 0,
      cancelId: 0,
      title: 'Delete Conversation',
      message: `Are you sure you want to delete: "${name}"?`,
      detail: 'This action cannot be undone.',
    })
    return result.response === 1
  })

  // 注销：清空所有凭证（credential）和本地配置文件。
  // 对应 Agent 概念：CredentialManager 是统一凭证仓库，类似 Golang 里的某个 CredentialStore interface 实现。
  server.handle(RPC_CHANNELS.auth.LOGOUT, async () => {
    try {
      const manager = getCredentialManager()

      // 遍历并删除所有已存储凭证
      const allCredentials = await manager.list()
      for (const credId of allCredentials) {
        await manager.delete(credId)
      }

      // 删除主配置文件
      const configPath = join(homedir(), '.craft-agent', 'config.json')
      await unlink(configPath).catch(() => {
        // 文件不存在时忽略错误
      })

      deps.platform.logger.info('Logout complete - cleared all credentials and config')
    } catch (error) {
      deps.platform.logger.error('Logout error:', error)
      throw error
    }
  })

  // 凭证仓库健康检查：启动时调用，检测凭证文件是否可读、是否损坏或机器迁移后失效。
  server.handle(RPC_CHANNELS.credentials.HEALTH_CHECK, async () => {
    const manager = getCredentialManager()
    return manager.checkHealth()
  })
}
