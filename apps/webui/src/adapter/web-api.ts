/**
 * Web API 适配器：在浏览器里实现 ElectronAPI 接口。
 *
 * 复用 Electron 应用里的 WsRpcClient、buildClientApi() 和 CHANNEL_MAP。
 * 对那些只适用于桌面端的 LOCAL_ONLY 方法（窗口管理、原生对话框等），
 * 用浏览器可用的等价实现覆盖。
 *
 * 鉴权：浏览器里的 session cookie（由 /api/auth 设置）会在 WebSocket 升级请求时自动携带，
 * 不需要手动传 bearer token。
 */

import i18n from 'i18next'
import { toast } from 'sonner'
import { openExternalUrl } from '@craft-agent/ui'
import { WsRpcClient } from '../../../electron/src/transport/client'
import { buildClientApi } from '../../../electron/src/transport/build-api'
import { CHANNEL_MAP } from '../../../electron/src/transport/channel-map'
import type { ElectronAPI, TransportConnectionState } from '../../../electron/src/shared/types'

// ---------------------------------------------------------------------------
// Web 文件选择器（替代 Electron 原生 dialog）
// ---------------------------------------------------------------------------

function webFilePicker(): Promise<string[]> {
  return new Promise((resolve) => {
    // 动态创建一个隐藏的 <input type="file">，再触发点击
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.onchange = () => {
      const files = input.files
      if (!files || files.length === 0) {
        resolve([])
        return
      }
      // 只返回文件名，实际读取逻辑在其他地方处理
      resolve(Array.from(files).map(f => f.name))
    }
    // 用户取消对话框时也返回空数组
    input.oncancel = () => resolve([])
    input.click()
  })
}

// ---------------------------------------------------------------------------
// 系统主题检测
// ---------------------------------------------------------------------------

// matchMedia 监听系统 prefers-color-scheme 偏好
const darkMediaQuery = typeof window !== 'undefined'
  ? window.matchMedia('(prefers-color-scheme: dark)')
  : null

function getSystemTheme(): boolean {
  return darkMediaQuery?.matches ?? false
}

// ---------------------------------------------------------------------------
// 创建 Web API
// ---------------------------------------------------------------------------

// WebApiOptions 是创建适配器时传入的选项接口（类似 Go 的 struct）
export interface WebApiOptions {
  /** WebSocket 服务器地址（ws:// 或 wss://） */
  serverUrl: string
  /** 要连接的 workspace ID */
  workspaceId?: string
}

// 创建浏览器版 ElectronAPI，返回 { api, client }
export function createWebApi(options: WebApiOptions): {
  api: ElectronAPI
  client: WsRpcClient
} {
  const { serverUrl, workspaceId } = options

  // WsRpcClient 是共享的 WebSocket RPC 客户端，web 模式表示走远程服务器
  const client = new WsRpcClient(serverUrl, {
    workspaceId,
    autoReconnect: true,
    mode: 'remote',
    // 不传 token：鉴权靠 session cookie
  })

  // 用 Electron 相同的 channel map 构建基础 API 代理
  const baseApi = buildClientApi(
    client,
    CHANNEL_MAP,
    (ch) => client.isChannelAvailable(ch),
  )

  // 覆盖 LOCAL_ONLY 方法为浏览器兼容实现
  const webOverrides: Partial<ElectronAPI> = {
    // 系统外壳操作：用浏览器 API 实现
    openUrl: (url: string) => {
      const result = openExternalUrl(url)
      if (!result.opened) {
        if (result.reason === 'dangerous') {
          toast.error(`Blocked unsafe URL (${result.detail})`)
        } else if (result.reason === 'internal-deeplink') {
          console.warn('[openUrl] craftagents:// deep links require the desktop app')
        } else {
          console.warn('[openUrl] Malformed URL:', url)
        }
      }
      return Promise.resolve()
    },
    openFile: () => Promise.resolve(), // 浏览器里无意义，空操作
    showInFolder: () => Promise.resolve(), // 浏览器里无意义，空操作

    // 文件对话框
    openFileDialog: webFilePicker,
    openFolderDialog: () => Promise.resolve(null), // 浏览器无法选择文件夹

    // 系统信息
    getVersions: () => ({ node: 'n/a', chrome: navigator.userAgent, electron: 'web' }),
    getRuntimeEnvironment: () => 'web',
    getSystemWarnings: () => Promise.resolve({ vcredistMissing: false }),
    isDebugMode: () => Promise.resolve(import.meta.env.DEV),

    // 主题
    getSystemTheme: () => Promise.resolve(getSystemTheme()),
    onSystemThemeChange: (cb: (isDark: boolean) => void) => {
      if (!darkMediaQuery) return () => {}
      const handler = (e: MediaQueryListEvent) => cb(e.matches)
      darkMediaQuery.addEventListener('change', handler)
      return () => darkMediaQuery.removeEventListener('change', handler)
    },

    // 窗口管理：浏览器里多为空操作或用等价 API
    setTrafficLightsVisible: () => Promise.resolve(),
    closeWindow: () => Promise.resolve(),
    confirmCloseWindow: () => Promise.resolve(),
    cancelCloseWindow: () => Promise.resolve(),
    onCloseRequested: () => () => {},
    getWindowFocusState: () => Promise.resolve(document.hasFocus()),
    onWindowFocusChange: (cb: (focused: boolean) => void) => {
      const onFocus = () => cb(true)
      const onBlur = () => cb(false)
      window.addEventListener('focus', onFocus)
      window.addEventListener('blur', onBlur)
      return () => {
        window.removeEventListener('focus', onFocus)
        window.removeEventListener('blur', onBlur)
      }
    },

    // Workspace 操作：web UI 只有一个连接
    getWindowWorkspace: () => Promise.resolve(workspaceId ?? null),
    getWindowMode: () => Promise.resolve('main'),
    // switchWorkspace 必须通知服务器，让服务器把 client.workspaceId 注册进去，
    // 否则推送事件（如 session 更新）不会下发到这个连接。
    switchWorkspace: async (wsId: string) => {
      await client.invoke('window:switchWorkspace', wsId)
    },
    openWorkspace: async () => {},
    openSessionInNewWindow: async (_wsId: string, sessionId: string) => {
      // 浏览器里用新标签页打开
      window.open(`${window.location.origin}/?session=${sessionId}`, '_blank')
    },

    // 自动更新：web 端不适用，但仍暴露服务器版本给关于页
    checkForUpdates: () => Promise.resolve({ available: false, currentVersion: client.getServerVersion() ?? '' } as any),
    getUpdateInfo: () => Promise.resolve({ available: false, currentVersion: client.getServerVersion() ?? '' } as any),
    installUpdate: () => Promise.resolve(),
    dismissUpdate: () => Promise.resolve(),
    getDismissedUpdateVersion: () => Promise.resolve(null),
    onUpdateAvailable: () => () => {},
    onUpdateDownloadProgress: () => () => {},
    // 发行说明：通过 RPC 从服务器拉取，和 Electron 端内容一致
    getReleaseNotes: () => client.invoke('releaseNotes:get') as Promise<string>,
    getLatestReleaseVersion: () => client.invoke('releaseNotes:getLatestVersion') as Promise<string | undefined>,

    // 菜单事件：web 端没有原生菜单，返回空取消函数
    onMenuNewChat: () => () => {},
    onMenuOpenSettings: () => () => {},
    onMenuKeyboardShortcuts: () => () => {},
    onMenuToggleFocusMode: () => () => {},
    onMenuToggleSidebar: () => () => {},
    onDeepLinkNavigate: () => () => {},

    // 菜单动作：web 没有原生菜单
    menuQuit: () => Promise.resolve(),
    menuNewWindow: () => { window.open(window.location.href, '_blank'); return Promise.resolve() },
    menuMinimize: () => Promise.resolve(),
    menuMaximize: () => Promise.resolve(),
    menuZoomIn: () => Promise.resolve(),
    menuZoomOut: () => Promise.resolve(),
    menuZoomReset: () => Promise.resolve(),
    menuToggleDevTools: () => Promise.resolve(),
    menuUndo: () => { document.execCommand('undo'); return Promise.resolve() },
    menuRedo: () => { document.execCommand('redo'); return Promise.resolve() },
    menuCut: () => { document.execCommand('cut'); return Promise.resolve() },
    menuCopy: () => { document.execCommand('copy'); return Promise.resolve() },
    menuPaste: () => { document.execCommand('paste'); return Promise.resolve() },
    menuSelectAll: () => { document.execCommand('selectAll'); return Promise.resolve() },

    // 角标：web 端通过 document.title 实现（实际更新由渲染层处理）
    refreshBadge: () => Promise.resolve(),
    setDockIconWithBadge: () => Promise.resolve(),
    onBadgeDraw: () => () => {},
    onBadgeDrawWindows: () => () => {},

    // 通知：使用 Web Notifications API
    showNotification: async (title: string, body: string) => {
      if ('Notification' in window && Notification.permission === 'granted') {
        new Notification(title, { body })
      }
    },
    onNotificationNavigate: () => () => {},

    // Git Bash（仅 Windows）：web 端不适用
    checkGitBash: () => Promise.resolve({ available: true } as any),
    browseForGitBash: () => Promise.resolve(null),
    setGitBashPath: () => Promise.resolve({ success: true }),

    // Skills：浏览器无法打开本地编辑器/文件夹
    openSkillInEditor: () => Promise.resolve(),
    openSkillInFinder: () => Promise.resolve(),

    // 确认对话框：用浏览器原生 confirm()
    showLogoutConfirmation: () => Promise.resolve(window.confirm(i18n.t('dialog.logoutConfirmation'))),
    showDeleteSessionConfirmation: (name: string) => Promise.resolve(window.confirm(i18n.t('dialog.deleteSessionConfirmation', { name }))),

    // 电源设置：web 端不适用
    getKeepAwakeWhileRunning: () => Promise.resolve(false),
    setKeepAwakeWhileRunning: () => Promise.resolve(),

    // 传输层状态
    getTransportConnectionState: () => Promise.resolve(client.getConnectionState() as TransportConnectionState),
    onTransportConnectionStateChanged: (cb: (state: TransportConnectionState) => void) => {
      return client.onConnectionStateChanged(cb as any)
    },
    reconnectTransport: () => { client.reconnectNow(); return Promise.resolve() },
    isChannelAvailable: (ch: string) => client.isChannelAvailable(ch),

    // 重启应用：web 端直接刷新页面
    relaunchApp: () => { window.location.reload(); return Promise.resolve() },
    removeWorkspace: () => Promise.resolve(false), // web UI 不支持
    invokeOnServer: () => Promise.reject(new Error('Cross-server RPC not available in web UI')),
  }

  // OAuth 覆盖：浏览器里用 window.open 打开授权页
  // Electron preload 里用 shell.openExternal()，浏览器里没有这个 API。
  const oauthOverrides: Partial<ElectronAPI> = {
    // 通用 OAuth：服务器准备授权流程，我们在新标签页打开 auth URL。
    // 授权完成后，OAuth 提供商会通过 relay 重定向回服务器的 /api/oauth/callback，
    // 服务器完成 token 交换并通过 WebSocket 推送状态。
    performOAuth: async (args: {
      sourceSlug: string
      sessionId?: string
      authRequestId?: string
    }) => {
      // iOS Safari 等严格弹窗拦截要求 window.open() 必须在点击事件的同步调用栈里执行，
      // 前面一旦 await 就会丢失用户手势，导致弹窗被静默拦截。
      // 所以我们先预打开一个空白页，等拿到 auth URL 后再改写它的 location.href。
      // 如果 popup 完全无法打开（popup === null），则退化为同窗口跳转。
      // 注意：这里没传 noopener，因为某些浏览器对 noopener 打开的窗口返回 null，会让我们拿不到预打开对象。
      const popup = window.open('about:blank', '_blank')

      try {
        const callbackUrl = `${window.location.origin}/api/oauth/callback`
        const result = await client.invoke('oauth:start', {
          sourceSlug: args.sourceSlug,
          callbackUrl,
          sessionId: args.sessionId,
          authRequestId: args.authRequestId,
        })

        if (popup && !popup.closed) {
          // 正常路径：预打开的 popup 还在，把它重定向到授权页
          popup.location.href = result.authUrl
        } else if (popup === null) {
          // popup 被完全拦截，改为同窗口跳转；cookie 鉴权让用户授权后仍能保持会话
          window.location.href = result.authUrl
        } else {
          // popup 被用户提前关闭，避免把主窗口也带偏
          return {
            success: false,
            error: 'Sign-in window was closed before authentication started.',
          }
        }

        // 服务器收到 callback 后完成流程，并通过 WebSocket 推送 auth 状态，
        // AuthRequestCard 等组件会自动更新。
        return { success: true }
      } catch (err) {
        if (popup && !popup.closed) popup.close()
        return {
          success: false,
          error: err instanceof Error ? err.message : 'OAuth flow failed',
        }
      }
    },

    // Claude OAuth：服务器返回 authUrl，我们在新标签页打开。
    // 与 performOAuth 使用同样的 iOS 安全预打开模式。
    startClaudeOAuth: async () => {
      const popup = window.open('about:blank', '_blank')
      try {
        const result = await client.invoke('onboarding:startClaudeOAuth')
        if (result.success && result.authUrl) {
          if (popup && !popup.closed) {
            popup.location.href = result.authUrl
          } else {
            window.location.href = result.authUrl
          }
        } else if (popup && !popup.closed) {
          // 没有 auth URL，关闭点击时预打开的空白页
          popup.close()
        }
        return result
      } catch (err) {
        if (popup && !popup.closed) popup.close()
        return {
          success: false,
          error: err instanceof Error ? err.message : 'Claude OAuth failed',
        }
      }
    },

    // ChatGPT OAuth：需要本地回调服务器，浏览器环境无法实现
    startChatGptOAuth: async () => {
      return {
        success: false,
        error: i18n.t('errors.chatGptOAuthNotAvailable'),
      }
    },
  }

  // 合并基础 API、web 覆盖、OAuth 覆盖为一个完整的 ElectronAPI 对象
  const api = { ...baseApi, ...webOverrides, ...oauthOverrides } as ElectronAPI

  return { api, client }
}
