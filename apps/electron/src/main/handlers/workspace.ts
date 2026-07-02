/**
 * workspace.ts —— 工作区与窗口相关 RPC handler。
 *
 * 处理远程连接测试、打开工作区、在新窗口打开会话、关闭窗口、
 * 控制 macOS 交通灯按钮等请求。
 */
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import type { RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from './handler-deps'

export const GUI_HANDLED_CHANNELS = [
  RPC_CHANNELS.remote.TEST_CONNECTION,
  RPC_CHANNELS.window.OPEN_WORKSPACE,
  RPC_CHANNELS.window.OPEN_SESSION_IN_NEW_WINDOW,
  RPC_CHANNELS.window.CLOSE,
  RPC_CHANNELS.window.CONFIRM_CLOSE,
  RPC_CHANNELS.window.CANCEL_CLOSE,
  RPC_CHANNELS.window.SET_TRAFFIC_LIGHTS,
] as const

/**
 * 连接远程服务器并等待握手完成。
 *
 * 如果提供 workspaceId，握手会限定在该工作区上下文，这样像 sessions:export 这类
 * 需要 workspace 上下文的 handler 才能正确解析。
 * 返回 { client, error }，连接失败时 client 为 null。
 */
export async function connectToRemote(url: string, token: string, workspaceId?: string) {
  const { WsRpcClient } = await import('../../transport/client')
  const client = new WsRpcClient(url, {
    token,
    workspaceId,
    autoReconnect: false,
    tlsRejectUnauthorized: false,
  })

  const connected = await new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => resolve(false), 10_000)
    const unsub = client.onConnectionStateChanged((state) => {
      if (state.status === 'connected') {
        clearTimeout(timeout)
        unsub()
        resolve(true)
      } else if (state.status === 'failed') {
        clearTimeout(timeout)
        unsub()
        resolve(false)
      }
    })
    client.connect()
  })

  if (!connected) {
    const error = client.getConnectionState().lastError?.message ?? 'Connection failed'
    client.destroy()
    return { client: null, error }
  }

  return { client, error: null }
}

export function registerWorkspaceGuiHandlers(server: RpcServer, deps: HandlerDeps): void {
  const windowManager = deps.windowManager

  // 测试与远程 Craft Agent Server 的连接。
  // 纯探测：返回已有工作区列表或 needsWorkspace 标记；创建工作区走单独的 invokeOnServer。
  server.handle(RPC_CHANNELS.remote.TEST_CONNECTION, async (_ctx, url: string, token: string) => {
    const { client, error } = await connectToRemote(url, token)
    if (!client) return { ok: false, error }

    // 从 handshake_ack 读取服务器版本（旧服务器为 null）
    const serverVersion = client.getServerVersion() ?? undefined

    try {
      console.log(`[TEST_CONNECTION] invoking ${RPC_CHANNELS.server.GET_WORKSPACES} on remote server...`)
      const workspaces = await client.invoke(RPC_CHANNELS.server.GET_WORKSPACES) as Array<{ id: string; name: string }>
      console.log(`[TEST_CONNECTION] remote returned ${workspaces?.length ?? 'null'} workspaces:`, JSON.stringify(workspaces?.map(w => ({ id: w.id, name: w.name }))))

      if (workspaces.length === 0) {
        console.log('[TEST_CONNECTION] → returning needsWorkspace=true')
        return { ok: true, needsWorkspace: true, serverVersion }
      }

      const result = {
        ok: true,
        serverVersion,
        remoteWorkspaces: workspaces,
        // 只有一个工作区时自动选中，省去用户再点一次
        remoteWorkspaceId: workspaces.length === 1 ? workspaces[0].id : undefined,
        remoteWorkspaceName: workspaces.length === 1 ? workspaces[0].name : undefined,
      }
      console.log(`[TEST_CONNECTION] → returning ${workspaces.length} workspaces`)
      return result
    } catch (err) {
      console.error('[TEST_CONNECTION] error:', err)
      return { ok: false, error: err instanceof Error ? err.message : 'Unknown error' }
    } finally {
      client.destroy()
    }
  })

  // 打开工作区：聚焦已有窗口或创建新窗口
  server.handle(RPC_CHANNELS.window.OPEN_WORKSPACE, async (_ctx, workspaceId: string) => {
    if (!windowManager) return
    windowManager.focusOrCreateWindow(workspaceId)
  })

  // 在新窗口打开某个会话
  server.handle(RPC_CHANNELS.window.OPEN_SESSION_IN_NEW_WINDOW, async (_ctx, workspaceId: string, sessionId: string) => {
    if (!windowManager) return
    const deepLink = `craftagents://allSessions/session/${sessionId}`
    windowManager.createWindow({
      workspaceId,
      focused: true,
      initialDeepLink: deepLink,
    })
  })

  // 关闭调用窗口（会触发 close 事件，可能被渲染进程拦截）
  server.handle(RPC_CHANNELS.window.CLOSE, (ctx) => {
    if (!windowManager) return
    windowManager.closeWindow(ctx.webContentsId!)
  })

  // 确认关闭：强制关闭窗口，绕过拦截逻辑
  server.handle(RPC_CHANNELS.window.CONFIRM_CLOSE, (ctx) => {
    if (!windowManager) return
    windowManager.forceCloseWindow(ctx.webContentsId!)
  })

  // 取消关闭：渲染进程已处理（例如关掉了弹窗/面板），清除兜底超时
  server.handle(RPC_CHANNELS.window.CANCEL_CLOSE, (ctx) => {
    if (!windowManager) return
    windowManager.cancelPendingClose(ctx.webContentsId!)
  })

  // 显示/隐藏 macOS 交通灯按钮（用于全屏浮层，防止误点）
  server.handle(RPC_CHANNELS.window.SET_TRAFFIC_LIGHTS, (ctx, visible: boolean) => {
    if (!windowManager) return
    windowManager.setTrafficLightsVisible(ctx.webContentsId!, visible)
  })
}
