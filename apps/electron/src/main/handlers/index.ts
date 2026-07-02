/**
 * handlers/index.ts —— Electron 主进程 RPC handler 的注册入口。
 *
 * RPC（Remote Procedure Call）在这里表现为：渲染进程 / 远端服务器通过 WebSocket 或 IPC
 * 调用主进程的函数。server-core 提供核心 handler（会话、文件等），本文件再注册 Electron
 * 专属 handler（窗口、系统菜单、浏览器、设置）。
 */
import type { HandlerDeps } from './handler-deps'
import type { RpcServer } from '@craft-agent/server-core/transport'
import { registerCoreRpcHandlers, type ServerHandlerContext } from '@craft-agent/server-core/handlers/rpc'
export { registerCoreRpcHandlers }

// GUI-only handlers 留在 Electron 主进程内部（依赖 Electron API）
import { registerSystemGuiHandlers } from './system'
import { registerWorkspaceGuiHandlers } from './workspace'
import { registerBrowserHandlers } from './browser'
import { registerSettingsGuiHandlers } from './settings'

// 注册 Electron 图形界面相关的 handler
export function registerGuiRpcHandlers(server: RpcServer, deps: HandlerDeps): void {
  registerSystemGuiHandlers(server, deps)
  registerWorkspaceGuiHandlers(server, deps)
  registerBrowserHandlers(server, deps)
  registerSettingsGuiHandlers(server, deps)
}

// 一次性注册全部 handler：server-core 核心 + Electron GUI
export function registerAllRpcHandlers(server: RpcServer, deps: HandlerDeps, serverCtx?: ServerHandlerContext): void {
  registerCoreRpcHandlers(server, deps, serverCtx)
  registerGuiRpcHandlers(server, deps)
}
