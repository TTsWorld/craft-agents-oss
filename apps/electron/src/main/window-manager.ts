/**
 * window-manager.ts —— Electron 窗口管理器。
 *
 * 负责创建、聚焦、关闭主窗口，维护 webContents.id → workspaceId 的映射，
 * 处理窗口关闭前的分层拦截、外部链接打开、系统主题变化通知等。
 */
import { BrowserWindow, shell, nativeTheme, Menu, app } from 'electron'
import { windowLog } from './logger'
import { join, resolve, sep } from 'path'
import { existsSync } from 'fs'
import { release } from 'os'
import { fileURLToPath } from 'url'
import { getWorkspaceByNameOrId } from '@craft-agent/shared/config'
import { classifyExternalUrl, formatBlockedUrlError } from '@craft-agent/shared/utils/url-safety'
import { RPC_CHANNELS, type WindowCloseRequestSource } from '../shared/types'
import type { SavedWindow } from './window-state'

// Vite 开发服务器地址，用于热重载
const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL

/**
 * 根据 Windows 版本选择合适的透明背景材质：
 * - Windows 11 (build 22000+)：Mica
 * - Windows 10 1809+ (build 17763+)：Acrylic
 * - 更旧版本：无透明效果
 */
function getWindowsBackgroundMaterial(): 'mica' | 'acrylic' | undefined {
  if (process.platform !== 'win32') return undefined

  // os.release() 返回 "10.0.xxxxx"，其中 xxxxx 是 build 号
  const buildNumber = parseInt(release().split('.')[2] || '0', 10)

  if (buildNumber >= 22000) {
    windowLog.info('Windows 11 detected (build ' + buildNumber + '), using Mica')
    return 'mica'
  } else if (buildNumber >= 17763) {
    windowLog.info('Windows 10 1809+ detected (build ' + buildNumber + '), using Acrylic')
    return 'acrylic'
  }

  windowLog.info('Older Windows detected (build ' + buildNumber + '), no transparency')
  return undefined
}


// WindowManager 内部维护的窗口记录
interface ManagedWindow {
  window: BrowserWindow
  workspaceId: string
}

export interface CreateWindowOptions {
  /** 要打开的工作区 ID（空字符串表示 onboarding） */
  workspaceId: string
  /** 是否以 focused 模式打开（小窗口、无侧边栏） */
  focused?: boolean
  /** 窗口加载后导航到的深链 URL（不带 ?window= 参数） */
  initialDeepLink?: string
  /** 从保存状态恢复用的完整 URL（保留路由和查询参数） */
  restoreUrl?: string
}

/**
 * WindowManager：管理所有 Electron 主窗口。
 *
 * 每个窗口对应一个工作区；通过 webContents.id 做索引。
 */
export class WindowManager {
  private windows: Map<number, ManagedWindow> = new Map()  // webContents.id → ManagedWindow
  private focusedModeWindows: Set<number> = new Set()  // focused 模式窗口的 webContents.id 集合
  private pendingCloseTimeouts: Map<number, NodeJS.Timeout> = new Map()  // 窗口关闭兜底超时
  private eventSink: ((channel: string, target: import('@craft-agent/shared/protocol').PushTarget, ...args: any[]) => void) | null = null
  private clientResolver: ((wcId: number) => string | undefined) | null = null
  private keyboardCloseIntents: Set<number> = new Set()  // Cmd/Ctrl+W 触发关闭的窗口标记
  private keyboardCloseIntentTimeouts: Map<number, NodeJS.Timeout> = new Map()  // 自动清除过期标记
  private isAppQuitting = false  // 应用退出时跳过分层关闭拦截

  /**
   * 设置 RPC event sink 和 client 解析器。
   * server 创建后调用，后续用 WS 推送事件替代 webContents.send。
   */
  setRpcEventSink(
    sink: (channel: string, target: import('@craft-agent/shared/protocol').PushTarget, ...args: any[]) => void,
    resolver: (wcId: number) => string | undefined
  ): void {
    this.eventSink = sink
    this.clientResolver = resolver
  }

  /** 返回当前 RPC event sink（如果传输层已初始化）。 */
  getRpcEventSink(): ((channel: string, target: import('@craft-agent/shared/protocol').PushTarget, ...args: any[]) => void) | null {
    return this.eventSink
  }

  /** 根据 transport 握手状态解析窗口当前的 clientId。 */
  getClientIdForWindow(webContentsId: number): string | undefined {
    return this.clientResolver?.(webContentsId)
  }

  /** 向指定窗口推送事件；优先用 RPC event sink，否则回退到 webContents.send。 */
  private pushToWindow(window: BrowserWindow, channel: string, ...args: any[]): void {
    if (this.eventSink && this.clientResolver) {
      const clientId = this.clientResolver(window.webContents.id)
      if (clientId) {
        this.eventSink(channel, { to: 'client', clientId }, ...args)
        return
      }
    }
    // 回退：直接 webContents.send（WS 握手完成前使用）
    if (!window.isDestroyed() && !window.webContents.isDestroyed() && window.webContents.mainFrame) {
      window.webContents.send(channel, ...args)
    }
  }

  private isRendererAppUrl(url: string): boolean {
    if (VITE_DEV_SERVER_URL) {
      try {
        const parsed = new URL(url)
        const devServer = new URL(VITE_DEV_SERVER_URL)
        if (parsed.origin === devServer.origin) return true
      } catch {
        // 出错则继续走下面的 file:// 处理
      }
    }

    try {
      const parsed = new URL(url)
      if (parsed.protocol !== 'file:') return false

      const filePath = resolve(fileURLToPath(parsed))
      const rendererRoot = resolve(join(__dirname, 'renderer'))
      return filePath === join(rendererRoot, 'index.html') || filePath.startsWith(rendererRoot + sep)
    } catch {
      return false
    }
  }

  private openExternalFromRenderer(url: string, context: string, sourceWindow?: BrowserWindow): void {
    const classification = classifyExternalUrl(url)

    if (classification.kind === 'dangerous') {
      windowLog.warn(`[url-safety] Blocked ${context}: ${formatBlockedUrlError(classification)} url=${url}`)
      return
    }

    if (classification.kind === 'internal-deeplink') {
      if (!sourceWindow) {
        windowLog.warn(`[url-safety] Blocked ${context}: internal deep link has no target window url=${url}`)
        return
      }

      void import('./deep-link').then(async ({ handleDeepLink }) => {
        const result = await handleDeepLink(
          url,
          this,
          this.eventSink ?? undefined,
          this.clientResolver ?? undefined,
          this.clientResolver?.(sourceWindow.webContents.id),
        )
        if (!result.success) {
          windowLog.warn(`[url-safety] Blocked ${context}: unsupported internal deep link url=${url} error=${result.error ?? 'unknown'}`)
        }
      }).catch((error) => {
        windowLog.warn(`[url-safety] Failed to route internal deep link from ${context}: ${error instanceof Error ? error.message : String(error)}`)
      })
      return
    }

    void shell.openExternal(url).catch((error) => {
      windowLog.warn(`[url-safety] Failed to open external URL from ${context}: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  /**
   * 刷新所有窗口标题策略：
   *   1 个窗口 → 显示应用名「Craft Agents」
   *   ≥2 个窗口 → 显示各自 workspace 名称，无法解析时回退到应用名。
   *
   * createWindow() 注册新窗口和 closed 事件移除窗口后都会调用，
   * 保证标题随窗口数量变化而更新。
   */
  private refreshWindowTitles(): void {
    const defaultTitle = app.getName()
    const showWorkspaceName = this.windows.size > 1
    for (const { window, workspaceId } of this.windows.values()) {
      if (window.isDestroyed()) continue
      let title = defaultTitle
      if (showWorkspaceName && workspaceId) {
        try {
          const ws = getWorkspaceByNameOrId(workspaceId)
          if (ws?.name) title = ws.name
        } catch (err) {
          windowLog.warn('refreshWindowTitles: workspace lookup failed', { workspaceId, err })
        }
      }
      window.setTitle(title)
    }
  }

  /**
   * 为指定工作区创建一个新窗口。
   */
  createWindow(options: CreateWindowOptions): BrowserWindow {
    const { workspaceId, focused = false, initialDeepLink, restoreUrl } = options

    // 加载平台专属应用图标
    // 打包后资源在 dist/resources/；开发时在 ../resources/
    const getIconPath = () => {
      const iconName = process.platform === 'darwin' ? 'icon.icns'
        : process.platform === 'win32' ? 'icon.ico'
        : 'icon.png'
      return [
        join(__dirname, 'resources', iconName),
        join(__dirname, '../resources', iconName),
      ].find(p => existsSync(p)) ?? join(__dirname, '../resources', iconName)
    }

    const iconPath = getIconPath()
    const iconExists = existsSync(iconPath)

    if (!iconExists) {
      windowLog.warn('App icon not found at:', iconPath)
    }

    // focused 模式使用更小窗口（单会话视图）
    const windowWidth = focused ? 900 : 1400
    const windowHeight = focused ? 700 : 900

    // 平台相关窗口选项
    const isMac = process.platform === 'darwin'
    const isWindows = process.platform === 'win32'
    const windowsBackgroundMaterial = getWindowsBackgroundMaterial()

    const window = new BrowserWindow({
      width: windowWidth,
      height: windowHeight,
      minWidth: 800,
      minHeight: 600,
      show: false, // 等 ready-to-show 再显示，减少启动白屏感
      title: '',
      icon: iconExists ? iconPath : undefined,
      // macOS：隐藏标题栏，内嵌交通灯
      ...(isMac && {
        titleBarStyle: 'hiddenInset',
        trafficLightPosition: { x: 18, y: 16 },
        vibrancy: 'under-window',
        visualEffectState: 'active',
      }),
      // Windows：保留原生边框，使用 Mica/Acrylic 透明效果
      ...(isWindows && {
        frame: true,
        autoHideMenuBar: true,
        // 注意：backgroundMaterial 不要配合 transparent:true，否则会隐藏窗口边框
        ...(windowsBackgroundMaterial && {
          backgroundMaterial: windowsBackgroundMaterial,
        }),
      }),
      // Linux：使用原生边框
      ...(!isMac && !isWindows && {
        frame: true,
        autoHideMenuBar: true,
      }),
      webPreferences: {
        preload: join(__dirname, 'bootstrap-preload.cjs'),
        contextIsolation: true,    // 启用上下文隔离（安全建议）
        nodeIntegration: false,    // 渲染进程不直接访问 Node API
        sandbox: false,            // 需要访问 preload 的一部分能力
        webviewTag: false          // 浏览器集成用 WebContentsView，不用 <webview>
      }
    })

    // 等首次绘制准备好再显示窗口，减少启动白屏感
    window.once('ready-to-show', () => {
      window.show()
    })

    // 拦截 window.open 等外部导航：危险协议被阻止，craftagents:// 走深链，其他用系统浏览器打开
    window.webContents.setWindowOpenHandler((details) => {
      this.openExternalFromRenderer(details.url, 'window-open', window)
      return { action: 'deny' }
    })

    // 处理渲染进程 WebContents 的外部导航尝试
    window.webContents.on('will-navigate', (event, url) => {
      // 只允许真正的应用壳（prod 是 file://，dev 是 Vite dev server），其他都当外部 URL 处理
      if (this.isRendererAppUrl(url)) return

      event.preventDefault()
      this.openExternalFromRenderer(url, 'will-navigate', window)
    })

    // 开发模式下启用右键上下文菜单
    if (!app.isPackaged) {
      window.webContents.on('context-menu', (_event, params) => {
        Menu.buildFromTemplate([
          { label: 'Inspect Element', click: () => window.webContents.inspectElement(params.x, params.y) },
          { type: 'separator' },
          { label: 'Cut', role: 'cut', enabled: params.editFlags.canCut },
          { label: 'Copy', role: 'copy', enabled: params.editFlags.canCopy },
          { label: 'Paste', role: 'paste', enabled: params.editFlags.canPaste },
        ]).popup()
      })
    }

    // index.html 默认标题是 `<title>Craft Agents</title>`，Electron 会自动同步到窗口标题，
    // 这会覆盖我们按 workspace 命名的策略。这里阻止默认同步。
    window.on('page-title-updated', (event) => {
      event.preventDefault()
    })

    // 在 loadURL 之前先注册窗口映射：bootstrap preload 会通过 sendSync 读取 __get-workspace-id
    const webContentsId = window.webContents.id
    this.windows.set(webContentsId, { window, workspaceId })

    // 窗口映射已包含新窗口，刷新标题策略：窗口数从 1→2 时现有窗口也要从应用名切到 workspace 名
    this.refreshWindowTitles()

    // 记录 focused 模式状态，用于持久化
    if (focused) {
      this.focusedModeWindows.add(webContentsId)
    }

    // 加载渲染进程：优先用 restoreUrl，否则根据 options 构造 URL
    if (restoreUrl) {
      if (VITE_DEV_SERVER_URL) {
        // dev 模式：保留保存 URL 的路径和查询参数，只替换主机为 dev server
        try {
          const savedUrl = new URL(restoreUrl)
          const devUrl = new URL(VITE_DEV_SERVER_URL)
          devUrl.pathname = savedUrl.pathname
          devUrl.search = savedUrl.search
          window.loadURL(devUrl.toString())
        } catch {
          windowLog.warn('Failed to parse restoreUrl, using default:', restoreUrl)
          const params = new URLSearchParams({ workspaceId, ...(focused && { focused: 'true' }) }).toString()
          window.loadURL(`${VITE_DEV_SERVER_URL}?${params}`)
        }
      } else {
        // prod：总是提取查询参数并从当前 __dirname 加载。
        // 不要直接加载 file:// URL，路径可能已失效（例如 Linux AppImage 每次挂载到不同 /tmp 目录）。参见 #13。
        try {
          const savedUrl = new URL(restoreUrl)
          const query: Record<string, string> = {}
          savedUrl.searchParams.forEach((value, key) => { query[key] = value })
          window.loadFile(join(__dirname, 'renderer/index.html'), { query })
        } catch {
          window.loadFile(join(__dirname, 'renderer/index.html'), { query: { workspaceId } })
        }
      }
    } else {
      const query: Record<string, string> = { workspaceId }
      if (focused) {
        query.focused = 'true' // focused 模式（无侧边栏）
      }

      if (VITE_DEV_SERVER_URL) {
        const params = new URLSearchParams(query).toString()
        window.loadURL(`${VITE_DEV_SERVER_URL}?${params}`)
      } else {
        window.loadFile(join(__dirname, 'renderer/index.html'), { query })
      }
    }

    // 兜底：渲染进程加载失败时（路径过期、磁盘错误等）优雅恢复为默认状态，避免白屏。参见 #13。
    // dev 模式下重试 Vite dev server（它可能还没启动好），而不是回退到不存在的 file://。
    let failLoadRetries = 0
    window.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
      windowLog.warn('Failed to load renderer:', errorCode, errorDescription)
      if (VITE_DEV_SERVER_URL && failLoadRetries < 5) {
        failLoadRetries++
        windowLog.info(`Retrying Vite dev server (attempt ${failLoadRetries}/5)...`)
        setTimeout(() => {
          const params = new URLSearchParams({ workspaceId }).toString()
          window.loadURL(`${VITE_DEV_SERVER_URL}?${params}`)
        }, 1000)
      } else {
        window.loadFile(join(__dirname, 'renderer/index.html'), { query: { workspaceId } })
      }
    })

    // 如果提供了初始深链，窗口准备好后导航过去
    if (initialDeepLink) {
      window.once('ready-to-show', () => {
        // 动态导入 parseDeepLink，避免循环依赖
        import('./deep-link').then(({ parseDeepLink }) => {
          const target = parseDeepLink(initialDeepLink)
          if (target && (target.view || target.action)) {
            // 稍等片刻让 React 挂载并注册 IPC 监听器
            setTimeout(() => {
              this.pushToWindow(window, RPC_CHANNELS.deeplink.NAVIGATE, {
                view: target.view,
                action: target.action,
                actionParams: target.actionParams,
              })
            }, 100)
          }
        })
      })
    }

    // 监听系统主题变化并通知该窗口的渲染进程
    const themeHandler = () => {
      this.pushToWindow(window, RPC_CHANNELS.theme.SYSTEM_CHANGED, nativeTheme.shouldUseDarkColors)
    }
    nativeTheme.on('updated', themeHandler)

    // 聚焦/失焦时广播窗口焦点状态
    window.on('focus', () => {
      this.pushToWindow(window, RPC_CHANNELS.window.FOCUS_STATE, true)
    })
    window.on('blur', () => {
      this.pushToWindow(window, RPC_CHANNELS.window.FOCUS_STATE, false)
    })

    // 在 close 事件前检测 Cmd/Ctrl+W，让渲染进程区分关闭来源。
    // 意图标记是短效的，避免过期误分类。
    window.webContents.on('before-input-event', (_event, input) => {
      if (!input || input.type !== 'keyDown') return
      const key = input.key?.toLowerCase?.()
      if (key !== 'w') return

      const isCloseShortcut = process.platform === 'darwin'
        ? !!input.meta
        : !!input.control

      if (!isCloseShortcut) return

      const wcId = window.webContents.id
      this.keyboardCloseIntents.add(wcId)
      const existingTimeout = this.keyboardCloseIntentTimeouts.get(wcId)
      if (existingTimeout) clearTimeout(existingTimeout)

      this.keyboardCloseIntentTimeouts.set(wcId, setTimeout(() => {
        this.keyboardCloseIntentTimeouts.delete(wcId)
        this.keyboardCloseIntents.delete(wcId)
      }, 500))
    })

    // 处理窗口关闭请求（交通灯按钮、菜单关闭、Cmd/Ctrl+W）
    // 把来源元数据发给渲染进程，让它决定是先关闭弹窗/面板还是直接关闭窗口。
    window.on('close', (event) => {
      // 应用退出期间绕过分层关闭行为，走原生关闭流程。
      // 这样 Cmd+Q 会退出应用，而不是先关闭覆盖层/面板。
      if (this.isAppQuitting) {
        return
      }

      // 检查渲染进程是否已准备好（mainFrame 存在）；没准备好就直接关闭
      if (!window.webContents.isDestroyed() && window.webContents.mainFrame) {
        event.preventDefault()
        const wcId = window.webContents.id
        let source: WindowCloseRequestSource = 'window-button'
        if (this.keyboardCloseIntents.has(wcId)) {
          source = 'keyboard-shortcut'
          this.keyboardCloseIntents.delete(wcId)
          const keyboardIntentTimeout = this.keyboardCloseIntentTimeouts.get(wcId)
          if (keyboardIntentTimeout) {
            clearTimeout(keyboardIntentTimeout)
            this.keyboardCloseIntentTimeouts.delete(wcId)
          }
        }

        // 发送关闭请求给渲染进程：它会关闭模态框/面板，或确认关闭窗口。
        this.pushToWindow(window, RPC_CHANNELS.window.CLOSE_REQUESTED, { source })

        // 兜底超时：如果 IPC 失败（如 Hyprland/Wayland 上），3 秒后强制关闭。
        // 每次关闭尝试都重置超时，避免正在关闭弹窗的用户被打断。
        const existingTimeout = this.pendingCloseTimeouts.get(wcId)
        if (existingTimeout) clearTimeout(existingTimeout)

        this.pendingCloseTimeouts.set(wcId, setTimeout(() => {
          this.pendingCloseTimeouts.delete(wcId)
          if (!window.isDestroyed()) window.destroy()
        }, 3000))
      }
      // 渲染进程没准备好时允许默认关闭行为
    })

    // 窗口已关闭：清理主题监听器和内部状态
    window.on('closed', () => {
      // 清理挂起的关闭超时，防止内存泄漏
      const timeout = this.pendingCloseTimeouts.get(webContentsId)
      if (timeout) {
        clearTimeout(timeout)
        this.pendingCloseTimeouts.delete(webContentsId)
      }

      // 清理短生命周期的键盘关闭意图跟踪
      const keyboardIntentTimeout = this.keyboardCloseIntentTimeouts.get(webContentsId)
      if (keyboardIntentTimeout) {
        clearTimeout(keyboardIntentTimeout)
        this.keyboardCloseIntentTimeouts.delete(webContentsId)
      }
      this.keyboardCloseIntents.delete(webContentsId)

      nativeTheme.removeListener('updated', themeHandler)
      this.windows.delete(webContentsId)
      this.focusedModeWindows.delete(webContentsId)
      // 重新应用窗口标题策略：存活窗口在数量从 2 → 1 时从 workspace 名切回应用名
      this.refreshWindowTitles()
      windowLog.info(`Window closed for workspace ${workspaceId}`)
    })

    windowLog.info(`Created window for workspace ${workspaceId} (focused: ${focused})`)
    return window
  }

  /**
   * Get window by webContents.id (used by IPC handlers instead of BrowserWindow.fromId)
   */
  getWindowByWebContentsId(wcId: number): BrowserWindow | null {
    const managed = this.windows.get(wcId)
    return managed?.window ?? null
  }

  /**
   * Get window by workspace ID (returns first match - for backwards compatibility)
   */
  getWindowByWorkspace(workspaceId: string): BrowserWindow | null {
    for (const managed of this.windows.values()) {
      if (managed.workspaceId === workspaceId && !managed.window.isDestroyed()) {
        return managed.window
      }
    }
    return null
  }

  /**
   * Get ALL windows for a workspace (main window + tab content windows)
   * Used for broadcasting events to all windows showing the same workspace
   */
  getAllWindowsForWorkspace(workspaceId: string): BrowserWindow[] {
    const windows: BrowserWindow[] = []
    for (const managed of this.windows.values()) {
      if (managed.workspaceId === workspaceId && !managed.window.isDestroyed()) {
        windows.push(managed.window)
      }
    }
    // 调试：查找失败时打印已注册的 workspace
    if (windows.length === 0 && this.windows.size > 0) {
      const registered = Array.from(this.windows.values()).map(m => m.workspaceId)
      windowLog.warn(`No windows for workspace '${workspaceId}', have: [${registered.join(', ')}]`)
    }
    return windows
  }

  /**
   * Get workspace ID for a window (by webContents.id)
   */
  getWorkspaceForWindow(webContentsId: number): string | null {
    const managed = this.windows.get(webContentsId)
    return managed?.workspaceId ?? null
  }

  /**
   * Mark whether the app is in quit flow.
   * When true, window close events bypass layered close interception.
   */
  setAppQuitting(isQuitting: boolean): void {
    this.isAppQuitting = isQuitting
  }

  /**
   * Close window by webContents.id (triggers close event which may be intercepted)
   */
  closeWindow(webContentsId: number): void {
    const managed = this.windows.get(webContentsId)
    if (managed && !managed.window.isDestroyed()) {
      managed.window.close()
    }
  }

  /**
   * Force close window by webContents.id (bypasses close event interception).
   * Used when renderer confirms the close action (no modals to close).
   */
  forceCloseWindow(webContentsId: number): void {
    // 渲染进程已确认关闭，清除兜底超时
    const timeout = this.pendingCloseTimeouts.get(webContentsId)
    if (timeout) {
      clearTimeout(timeout)
      this.pendingCloseTimeouts.delete(webContentsId)
    }

    const managed = this.windows.get(webContentsId)
    if (managed && !managed.window.isDestroyed()) {
      // 临时移除 close 监听器避免无限循环，然后直接销毁窗口
      managed.window.destroy()
    }
  }

  /**
   * Cancel a pending close request (renderer handled it by closing a modal/panel).
   * Clears the fallback timeout so the window stays open.
   */
  cancelPendingClose(webContentsId: number): void {
    const timeout = this.pendingCloseTimeouts.get(webContentsId)
    if (timeout) {
      clearTimeout(timeout)
      this.pendingCloseTimeouts.delete(webContentsId)
    }
  }

  /**
   * Close window for a specific workspace
   */
  closeWindowForWorkspace(workspaceId: string): void {
    const window = this.getWindowByWorkspace(workspaceId)
    if (window && !window.isDestroyed()) {
      window.close()
    }
  }

  /**
   * Update the workspace ID for an existing window (for in-window switching)
   * @param webContentsId - The webContents.id of the window
   * @param workspaceId - The new workspace ID
   * @returns true if window was found and updated, false otherwise
   */
  updateWindowWorkspace(webContentsId: number, workspaceId: string): boolean {
    const managed = this.windows.get(webContentsId)
    if (managed) {
      const oldWorkspaceId = managed.workspaceId
      managed.workspaceId = workspaceId
      // 重新应用窗口标题策略，使窗口内切换 workspace 时标题栏立即更新
      //（在打开 ≥2 个窗口时才有可见效果）。
      this.refreshWindowTitles()
      windowLog.info(`Updated window ${webContentsId} from workspace ${oldWorkspaceId} to ${workspaceId}`)
      return true
    }
    // 窗口未找到，打印调试信息
    windowLog.warn(`Cannot update workspace for unknown window ${webContentsId}, registered: [${Array.from(this.windows.keys()).join(', ')}]`)
    return false
  }

  /**
   * Register an existing window with a workspace ID
   * Used for re-registration when window mapping is lost (e.g., after refresh)
   * @param window - The BrowserWindow to register
   * @param workspaceId - The workspace ID to associate with
   */
  registerWindow(window: BrowserWindow, workspaceId: string): void {
    const webContentsId = window.webContents.id
    this.windows.set(webContentsId, { window, workspaceId })
    // 重新注册后重新应用窗口标题策略（例如刷新后重新注册）
    this.refreshWindowTitles()
    windowLog.info(`Registered window ${webContentsId} for workspace ${workspaceId}`)
  }

  /**
   * Get all managed windows
   */
  getAllWindows(): ManagedWindow[] {
    return Array.from(this.windows.values()).filter(m => !m.window.isDestroyed())
  }

  /**
   * Focus existing window for workspace or create new one
   */
  focusOrCreateWindow(workspaceId: string): BrowserWindow {
    const existing = this.getWindowByWorkspace(workspaceId)
    if (existing) {
      if (existing.isMinimized()) {
        existing.restore()
      }
      existing.focus()
      return existing
    }
    return this.createWindow({ workspaceId })
  }

  /**
   * Get window states for persistence (includes bounds and focused mode)
   * Used by window-state.ts to save/restore windows
   */
  getWindowStates(): SavedWindow[] {
    return this.getAllWindows().map(managed => {
      const webContentsId = managed.window.webContents.id
      const isFocused = this.focusedModeWindows.has(webContentsId)
      const url = managed.window.webContents.getURL()
      return {
        type: 'main' as const,
        workspaceId: managed.workspaceId,
        bounds: managed.window.getBounds(),
        ...(isFocused && { focused: true }),
        ...(url && { url }),
      }
    })
  }

  /**
   * Check if any windows are open
   */
  hasWindows(): boolean {
    return this.getAllWindows().length > 0
  }

  /**
   * Get the currently focused window
   */
  getFocusedWindow(): BrowserWindow | null {
    const focused = BrowserWindow.getFocusedWindow()
    if (focused && !focused.isDestroyed()) {
      return focused
    }
    return null
  }

  /**
   * Get the last active window (most recently used)
   * Falls back to any available window if none focused
   */
  getLastActiveWindow(): BrowserWindow | null {
    // 先尝试聚焦窗口
    const focused = this.getFocusedWindow()
    if (focused) {
      return focused
    }

    // 回退到任意可用窗口
    const allWindows = this.getAllWindows()
    if (allWindows.length > 0) {
      return allWindows[0].window
    }

    return null
  }

  /**
   * Show or hide macOS traffic light buttons (close/minimize/maximize).
   * Used to hide them when fullscreen overlays are open to prevent accidental clicks.
   * No-op on non-macOS platforms.
   */
  setTrafficLightsVisible(webContentsId: number, visible: boolean): void {
    if (process.platform !== 'darwin') return

    const managed = this.windows.get(webContentsId)
    if (managed && !managed.window.isDestroyed()) {
      managed.window.setWindowButtonVisibility(visible)
      // 显示/隐藏按钮后恢复自定义交通灯位置，因为 setWindowButtonVisibility 可能把它重置为默认
      if (visible) {
        // 显示按钮后恢复自定义交通灯位置（setWindowButtonVisibility 可能把它重置为默认）
        managed.window.setWindowButtonPosition({ x: 18, y: 19 })
      }
    }
  }
}
