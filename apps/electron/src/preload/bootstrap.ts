/**
 * WS 模式 preload 脚本 —— 替代完整的 IPC preload（index.ts）。
 *
 * 可以把 preload 理解成 Electron 渲染进程（Renderer）和主进程（Main）之间的“胶水层”：
 * 它在页面加载前执行，拥有 Node.js 与部分 Electron API 的访问权限，
 * 再通过 contextBridge 把安全裁剪后的 API 暴露给前端 React 使用。
 *
 * 普通模式（本地服务器）：
 *   创建 RoutedClient，把 LOCAL_ONLY 通道路由到本地 Electron 服务器，
 *   REMOTE_ELIGIBLE 通道则路由到拥有当前工作区的服务器（本地或远程）。
 *   切换工作区时会透明地切换底层工作区连接。
 *
 * 瘦客户端模式（CRAFT_SERVER_URL）：
 *   只创建一个 WsRpcClient，直接连接远程服务器。
 *   所有通道都发往远程服务器。
 *
 * 在 localhost 上 WS 握手 <1ms 即可完成；React 应用初始化需要 >100ms，
 * 因此当组件第一次调用 API 时，连接已经建立好了。
 */

import '@sentry/electron/preload' // Sentry 错误追踪的 preload 集成
import { contextBridge, ipcRenderer, shell, webUtils } from 'electron'
// contextBridge：安全地把 API 暴露给渲染进程
// ipcRenderer：渲染进程向主进程发 IPC 消息
// shell：调用系统能力（打开浏览器、打开文件等）
// webUtils：Electron 提供的 Web 相关工具
import { WsRpcClient, type TransportConnectionState } from '../transport/client'
// `type` 前缀表示只导入类型，编译后会被擦除，不影响运行时。
import { RoutedClient } from '../transport/routed-client'
import { buildClientApi } from '../transport/build-api'
import { CHANNEL_MAP } from '../transport/channel-map'
import { createCallbackServer } from '@craft-agent/shared/auth/callback-server'
import { CHATGPT_OAUTH_CONFIG } from '@craft-agent/shared/auth/chatgpt-oauth-config'
import {
  CLIENT_OPEN_EXTERNAL,
  CLIENT_OPEN_PATH,
  CLIENT_SHOW_IN_FOLDER,
  CLIENT_CONFIRM_DIALOG,
  CLIENT_OPEN_FILE_DIALOG,
  CLIENT_BROWSER_INVOKE,
  LOCAL_CLIENT_CAPABILITIES,
} from '@craft-agent/server-core/transport'
import type { ConfirmDialogSpec, FileDialogSpec, BrowserCapabilityRequest } from '@craft-agent/server-core/transport'
import type { RpcClient } from '@craft-agent/server-core/transport'
import type { RemoteServerConfig } from '@craft-agent/core/types'
import type { ElectronAPI } from '../shared/types'

// ---------------------------------------------------------------------------
// TransportClient 接口 —— RoutedClient 和 WsRpcClient 的公共抽象
// ---------------------------------------------------------------------------

/**
 * 传输层客户端接口。
 *
 * 这里用 interface 定义对象“形状”（类似 Go 的 interface，但 TS 是结构化的，
 * 只要对象实现了这些属性/方法就满足该接口，不需要显式声明实现）。
 * 它同时继承自 RpcClient，并额外提供连接状态相关能力。
 */
interface TransportClient extends RpcClient {
  isChannelAvailable(channel: string): boolean
  getConnectionState(): TransportConnectionState
  onConnectionStateChanged(callback: (state: TransportConnectionState) => void): () => void
  reconnectNow(): void
}

// ---------------------------------------------------------------------------
// 连接初始化
// ---------------------------------------------------------------------------

/**
 * 通过同步 IPC 获取当前 WebContents 的唯一 ID。
 * sendSync 会阻塞渲染进程，直到主进程返回结果，适合 preload 阶段一次性读取配置。
 */
const webContentsId: number = ipcRenderer.sendSync('__get-web-contents-id')

/**
 * 判断是否处于瘦客户端模式：只要环境变量 CRAFT_SERVER_URL 存在即为 true。
 * `!!` 是惯用法，把 truthy/falsy 值强制转成 boolean（类似 Go 的 `!= ""`）。
 */
const isClientOnly = !!process.env.CRAFT_SERVER_URL

let client: TransportClient

if (isClientOnly) {
  // ── 瘦客户端模式 ─────────────────────────────────────────────────────────
  // 单个 WsRpcClient 直连远程服务器；没有本地服务器，也不做路由，全部通道走远程。

  const wsUrl = process.env.CRAFT_SERVER_URL!
  const wsToken = process.env.CRAFT_SERVER_TOKEN ?? ''

  // 禁止向非 localhost 服务器使用未加密的 ws://，否则 token 会以明文传输
  const parsed = new URL(wsUrl)
  const isLocalhost = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1'
  if (parsed.protocol === 'ws:' && !isLocalhost) {
    throw new Error(
      `Refusing to connect to remote server over unencrypted ws://. ` +
      `Use wss:// (TLS) for non-localhost connections. ` +
      `Set CRAFT_RPC_TLS_CERT/KEY on the server to enable TLS.`
    )
  }

  // workspaceId 可选；缺失时渲染层会显示工作区选择器
  const workspaceId = process.env.CRAFT_WORKSPACE_ID || ipcRenderer.sendSync('__get-workspace-id') || undefined

  const wsClient = new WsRpcClient(wsUrl, {
    token: wsToken,
    workspaceId,
    webContentsId,
    autoReconnect: true,
    mode: 'remote',
    clientCapabilities: [...LOCAL_CLIENT_CAPABILITIES],
  })
  wsClient.connect()
  client = wsClient

} else {
  // ── 普通模式 ─────────────────────────────────────────────────────────────
  // RoutedClient 把 LOCAL_ONLY 路由到本地服务器，REMOTE_ELIGIBLE 路由到
  // 拥有该工作区的服务器（本地或远程）。

  const wsPort: number = ipcRenderer.sendSync('__get-ws-port')
  const wsToken: string = ipcRenderer.sendSync('__get-ws-token')
  const workspaceId: string = ipcRenderer.sendSync('__get-workspace-id')

  const localClient = new WsRpcClient(`ws://127.0.0.1:${wsPort}`, {
    token: wsToken,
    workspaceId,
    webContentsId,
    autoReconnect: true,
    mode: 'local',
    clientCapabilities: [...LOCAL_CLIENT_CAPABILITIES],
  })

  // 在 preload 执行期间通过同步 IPC 判断当前工作区是否为远程
  const remoteConfig: RemoteServerConfig | null = ipcRenderer.sendSync('__get-workspace-remote-config')

  let initialWorkspaceClient: WsRpcClient
  if (remoteConfig && typeof remoteConfig.url === 'string') {
    // 工作区在远程服务器 —— 创建一个直达该远程服务器的连接
    initialWorkspaceClient = new WsRpcClient(remoteConfig.url, {
      token: remoteConfig.token,
      workspaceId: remoteConfig.remoteWorkspaceId,
      webContentsId,
      autoReconnect: true,
      mode: 'remote',
      clientCapabilities: [...LOCAL_CLIENT_CAPABILITIES],
      tlsRejectUnauthorized: false,
    })
    initialWorkspaceClient.connect()
  } else {
    // 工作区在本地 —— 工作区客户端就是本地客户端
    initialWorkspaceClient = localClient
  }

  const routedClient = new RoutedClient(localClient, initialWorkspaceClient)

  // 如果初始工作区就是远程的，设置本地 workspaceId 到远程 remoteWorkspaceId 的映射
  if (remoteConfig) {
    routedClient.setWorkspaceMapping(workspaceId, remoteConfig.remoteWorkspaceId)
  }

  // 工厂函数：切换工作区时按需创建新的远程连接
  routedClient.setClientFactory((remoteServer: RemoteServerConfig) => {
    return new WsRpcClient(remoteServer.url, {
      token: remoteServer.token,
      workspaceId: remoteServer.remoteWorkspaceId,
      webContentsId,
      autoReconnect: true,
      mode: 'remote',
      clientCapabilities: [...LOCAL_CLIENT_CAPABILITIES],
      tlsRejectUnauthorized: false,
    })
  })

  localClient.connect()
  client = routedClient
}

// ---------------------------------------------------------------------------
// 注册客户端能力（服务器可以反向调用这些方法）
// ---------------------------------------------------------------------------

// shell.openExternal 用系统默认浏览器打开 URL（例如打开外部授权页）。
client.handleCapability(CLIENT_OPEN_EXTERNAL, (url: string) => shell.openExternal(url))

client.handleCapability(CLIENT_OPEN_PATH, async (path: string) => {
  const error = await shell.openPath(path)
  return { error: error || undefined }
})

client.handleCapability(CLIENT_SHOW_IN_FOLDER, (path: string) => {
  shell.showItemInFolder(path)
})

client.handleCapability(CLIENT_CONFIRM_DIALOG, async (spec: ConfirmDialogSpec) => {
  return await ipcRenderer.invoke('__dialog:showMessageBox', spec)
})

client.handleCapability(CLIENT_OPEN_FILE_DIALOG, async (spec: FileDialogSpec) => {
  return await ipcRenderer.invoke('__dialog:showOpenDialog', spec)
})

// 浏览器面板调用。远程服务器把 IBrowserPaneManager 的方法调用封装成 BrowserCapabilityRequest；
// 我们通过 __browser:invoke IPC 通道派发给本地的 BrowserPaneManager
//（对应 apps/electron/src/main/browser-pane-manager.ts:registerCapabilityIpc()）。
client.handleCapability(CLIENT_BROWSER_INVOKE, async (req: BrowserCapabilityRequest) => {
  return await ipcRenderer.invoke('__browser:invoke', req)
})

// ---------------------------------------------------------------------------
// 构建暴露给渲染进程的 ElectronAPI 代理
// ---------------------------------------------------------------------------

const api = buildClientApi(client, CHANNEL_MAP, (ch) => client.isChannelAvailable(ch))

// 用 `as any` 临时绕过类型检查，给 api 对象动态附加属性。
// 实际项目中应尽量避免 as any，这里是为了在不改变 ElectronAPI 声明的前提下扩展 API。
;(api as any).getRuntimeEnvironment = (): 'electron' | 'web' => 'electron'

// ---------------------------------------------------------------------------
// 远程连接状态日志格式化
// ---------------------------------------------------------------------------

/**
 * 把 TransportConnectionState 里的错误/关闭原因格式化成可读字符串。
 */
function formatTransportReason(state: TransportConnectionState): string {
  const err = state.lastError
  if (err) {
    const codePart = err.code ? ` [${err.code}]` : ''
    return `${err.kind}${codePart}: ${err.message}`
  }

  // `?.` 是可选链：如果 lastClose 为 null/undefined 则整个表达式短路为 undefined。
  if (state.lastClose?.code != null) {
    const reason = state.lastClose.reason ? ` (${state.lastClose.reason})` : ''
    return `close ${state.lastClose.code}${reason}`
  }

  return 'no additional details'
}

// 当工作区连接是远程时（瘦客户端或远程工作区），把连接状态变化回传给主进程，
// 这样终端和 main.log 里都能看到。
client.onConnectionStateChanged((state) => {
  if (state.mode !== 'remote') return

  const emitToMain = (level: 'info' | 'warn' | 'error', message: string) => {
    ipcRenderer.send('__transport:status', {
      level,
      message,
      status: state.status,
      attempt: state.attempt,
      nextRetryInMs: state.nextRetryInMs,
      error: state.lastError,
      close: state.lastClose,
      url: state.url,
    })
  }

  if (state.status === 'connected') {
    const message = `[transport] connected to ${state.url}`
    console.info(message)
    emitToMain('info', message)
    return
  }

  if (state.status === 'reconnecting') {
    const retry = state.nextRetryInMs != null ? ` retry in ${state.nextRetryInMs}ms` : ''
    const message = `[transport] reconnecting (attempt ${state.attempt})${retry} — ${formatTransportReason(state)}`
    console.warn(message)
    emitToMain('warn', message)
    return
  }

  if (state.status === 'failed' || state.status === 'disconnected') {
    const message = `[transport] ${state.status} — ${formatTransportReason(state)}`
    console.error(message)
    emitToMain('error', message)
  }
})

// ---------------------------------------------------------------------------
// 传输层状态 API（暴露给渲染进程）
// ---------------------------------------------------------------------------

// 获取当前连接状态
;(api as any).getTransportConnectionState = async () => client.getConnectionState()

// 订阅连接状态变化；返回的函数用于取消订阅。
;(api as any).onTransportConnectionStateChanged = (callback: (state: TransportConnectionState) => void) => {
  return client.onConnectionStateChanged(callback)
}

// 手动触发重连
;(api as any).reconnectTransport = async () => {
  client.reconnectNow()
}

// ── performOAuth ─────────────────────────────────────────────────────────
// 多步编排：本地回调服务器 → oauth:start（服务器准备）→ 打开浏览器 →
// 等待回调 → oauth:complete（服务器换 token 并存储凭证）。
// 必须在客户端跑，因为回调服务器需要接收 OAuth 提供方的 redirect。
;(api as any).performOAuth = async (args: {
  sourceSlug: string
  sessionId?: string
  authRequestId?: string
}): Promise<{ success: boolean; error?: string; email?: string }> => {
  // Awaited<ReturnType<typeof createCallbackServer>> 表示
  // “createCallbackServer 返回的 Promise 被 await 后的实际类型”。
  let callbackServer: Awaited<ReturnType<typeof createCallbackServer>> | null = null
  let flowId: string | undefined
  let state: string | undefined

  try {
    // 1. 启动本地回调服务器，接收 OAuth 提供方的重定向
    callbackServer = await createCallbackServer({ appType: 'electron' })
    const callbackUrl = `${callbackServer.url}/callback`

    // 2. 让服务器准备 PKCE、auth URL 并把 flow 存起来
    const startResult = await client.invoke('oauth:start', {
      sourceSlug: args.sourceSlug,
      callbackUrl,
      sessionId: args.sessionId,
      authRequestId: args.authRequestId,
    })
    flowId = startResult.flowId
    state = startResult.state

    // 3. 在本地打开浏览器让用户授权（必须是用户本机，不能是远程服务器）
    await shell.openExternal(startResult.authUrl)

    // 4. 等待 OAuth 提供方重定向回我们的回调服务器
    const callback = await callbackServer.promise

    // 5. 检查提供方是否返回错误
    if (callback.query.error) {
      const error = callback.query.error_description || callback.query.error
      await client.invoke('oauth:cancel', { flowId, state })
      return { success: false, error }
    }

    const code = callback.query.code
    if (!code) {
      await client.invoke('oauth:cancel', { flowId, state })
      return { success: false, error: 'No authorization code received' }
    }

    // 6. 把授权码交给服务器换取 token 并保存凭据
    const result = await client.invoke('oauth:complete', { flowId, code, state })
    return { success: result.success, error: result.error, email: result.email }
  } catch (err) {
    // 出错时通知服务器清理本次 flow；.catch(() => {}) 避免清理请求本身抛错影响流程。
    if (flowId && state) {
      client.invoke('oauth:cancel', { flowId, state }).catch(() => {})
    }
    return {
      success: false,
      error: err instanceof Error ? err.message : 'OAuth flow failed',
    }
  } finally {
    callbackServer?.close()
  }
}

// ── startClaudeOAuth ─────────────────────────────────────────────────────
// 覆盖 channel-map 里的占位实现：服务器现在只返回 authUrl，不再自己打开浏览器。
// 我们在本地打开，这样远程模式下也能正常工作。
// Claude OAuth 是两步式：浏览器打开 → 用户复制 code → 粘贴回 UI。
;(api as any).startClaudeOAuth = async (): Promise<{
  success: boolean
  authUrl?: string
  error?: string
}> => {
  try {
    const result = await client.invoke('onboarding:startClaudeOAuth')
    if (result.success && result.authUrl) {
      await shell.openExternal(result.authUrl)
    }
    return result
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Claude OAuth failed',
    }
  }
}

// ── performChatGptOAuth ──────────────────────────────────────────────────
// 流程与 performOAuth 相同：回调服务器（端口 1455）→ chatgpt:startOAuth →
// 浏览器 → 回调 → chatgpt:completeOAuth。
// 覆盖 startChatGptOAuth API 方法，渲染层调用方式保持不变。
;(api as any).startChatGptOAuth = async (
  connectionSlug: string,
): Promise<{ success: boolean; error?: string }> => {
  let callbackServer: Awaited<ReturnType<typeof createCallbackServer>> | null = null
  let flowId: string | undefined
  let state: string | undefined

  try {
    // 1. 在 ChatGPT 固定端口启动回调服务器，并指定 /auth/callback 路径
    callbackServer = await createCallbackServer({
      appType: 'electron',
      port: CHATGPT_OAUTH_CONFIG.CALLBACK_PORT,
      callbackPaths: ['/auth/callback'],
    })

    // 2. 让服务器准备 PKCE、auth URL 并把 pending flow 存起来
    const startResult = await client.invoke('chatgpt:startOAuth', connectionSlug)
    flowId = startResult.flowId
    state = startResult.state

    // 3. 在本地打开浏览器让用户授权
    await shell.openExternal(startResult.authUrl)

    // 4. 等待 OpenAI 重定向回我们的回调服务器
    const callback = await callbackServer.promise

    // 5. 检查 OpenAI 是否返回错误
    if (callback.query.error) {
      const error = callback.query.error_description || callback.query.error
      await client.invoke('chatgpt:cancelOAuth', { state })
      return { success: false, error }
    }

    const code = callback.query.code
    if (!code) {
      await client.invoke('chatgpt:cancelOAuth', { state })
      return { success: false, error: 'No authorization code received' }
    }

    // 6. 把授权码交给服务器换取 token 并保存凭据
    const result = await client.invoke('chatgpt:completeOAuth', { flowId, code, state })
    return { success: result.success, error: result.error }
  } catch (err) {
    if (state) {
      client.invoke('chatgpt:cancelOAuth', { state }).catch(() => {})
    }
    return {
      success: false,
      error: err instanceof Error ? err.message : 'ChatGPT OAuth flow failed',
    }
  } finally {
    callbackServer?.close()
  }
}

// 应用生命周期 —— 直接使用 IPC（不是 WS RPC），因为这些操作会重启服务器本身，
// WS 连接会因此断开，不能用 WS 发命令。
;(api as ElectronAPI).relaunchApp = () => ipcRenderer.invoke('app:relaunch')
;(api as ElectronAPI).removeWorkspace = (workspaceId: string) => ipcRenderer.invoke('workspace:remove', workspaceId)
;(api as ElectronAPI).invokeOnServer = (url: string, token: string, channel: string, ...args: any[]) =>
  ipcRenderer.invoke('server:invokeOnServer', url, token, channel, ...args)
;(api as ElectronAPI).transferSessionToWorkspace = (sessionId: string, targetWorkspaceId: string, sessionIndex?: number, sessionCount?: number) =>
  ipcRenderer.invoke('session:transferToRemoteWorkspace', sessionId, targetWorkspaceId, sessionIndex, sessionCount)
;(api as ElectronAPI).onTransferProgress = (cb: (progress: { sessionIndex: number; sessionCount: number; chunkSent: number; chunkTotal: number }) => void) => {
  const handler = (_e: any, progress: { sessionIndex: number; sessionCount: number; chunkSent: number; chunkTotal: number }) => cb(progress)
  ipcRenderer.on('transfer:progress', handler)
  return () => { ipcRenderer.removeListener('transfer:progress', handler) }
}

// 系统警告：暴露主进程启动时写入的环境变量标记。
//（preload 专属优势：直接读环境变量，不需要 IPC 往返）
;(api as ElectronAPI).getSystemWarnings = async () => ({
  vcredistMissing: process.env.CRAFT_VCREDIST_MISSING === '1',
  downloadUrl: process.env.CRAFT_VCREDIST_URL,
})

// i18n：同步语言切换给主进程，让原生菜单/对话框也能跟随语言。
;(api as ElectronAPI).changeLanguage = (lang: string) => ipcRenderer.invoke('i18n:changeLanguage', lang)

// webUtils.getPathForFile：返回从 <input type="file"> 或系统拖拽得到的 File 对象的绝对路径。
// 对于从 Blob 构造的 File（剪贴板粘贴、网页拖拽）返回 null —— 那些只有内容，没有文件系统路径。
;(api as ElectronAPI).getFilePath = (file: File) => {
  try {
    return webUtils.getPathForFile(file) || null
  } catch {
    return null
  }
}

// 把 api 安全地注入到渲染进程的 window.electronAPI。
// 之后 React 代码里通过 window.electronAPI 调用这些能力。
contextBridge.exposeInMainWorld('electronAPI', api)
