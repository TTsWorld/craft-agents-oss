// 先加载用户 shell 环境（在其他可能读取 env 的 import 之前）
// 这样 Homebrew、nvm 等工具对 agent 可用
import { loadShellEnv } from './shell-env'
loadShellEnv()

import { app, BrowserWindow, dialog, ipcMain, nativeImage, nativeTheme, shell } from 'electron'
import { createHash, randomUUID } from 'crypto'
import { hostname, homedir } from 'os'
import * as Sentry from '@sentry/electron/main'

// 在导入 app 后尽早初始化 Sentry 错误追踪。
// 仅在生产（打包）构建中启用，避免开发环境噪音。
// DSN 在构建时通过 esbuild --define 写入（与 OAuth secrets 同样的方式）。
//
// 注意：Source map 上传被有意禁用，Sentry 里的堆栈会显示打包/压缩后的代码。
// 将来如需启用 source map 上传：
//   1. 在 CI secrets 里加 SENTRY_AUTH_TOKEN、SENTRY_ORG、SENTRY_PROJECT
//   2. 在 vite.config.ts 里重新启用 @sentry/vite-plugin（处理渲染进程 map）
//   3. 在 scripts/electron-build-main.ts 里加 @sentry/esbuild-plugin（处理主进程 map）
Sentry.init({
  dsn: process.env.SENTRY_ELECTRON_INGEST_URL,
  environment: app.isPackaged ? 'production' : 'development',
  release: app.getVersion(),
  // 只要有 ingest URL 就启用——生产环境由 CI 烘焙，开发环境通过 .env / 1Password 注入。
  // 在 Sentry 后台按 environment 过滤即可。
  enabled: !!process.env.SENTRY_ELECTRON_INGEST_URL,

  // 发送给 Sentry 前先脱敏：移除 authorization header、API key/token 等凭证类数据。
  beforeSend(event) {
    // 脱敏请求头（authorization、cookie）
    if (event.request?.headers) {
      const sensitiveHeaders = ['authorization', 'cookie', 'x-api-key']
      for (const header of sensitiveHeaders) {
        if (event.request.headers[header]) {
          event.request.headers[header] = '[REDACTED]'
        }
      }
    }

    // 脱敏可能包含敏感值的 breadcrumb 数据
    if (event.breadcrumbs) {
      for (const breadcrumb of event.breadcrumbs) {
        if (breadcrumb.data) {
          for (const key of Object.keys(breadcrumb.data)) {
            const lowerKey = key.toLowerCase()
            if (lowerKey.includes('token') || lowerKey.includes('key') ||
                lowerKey.includes('secret') || lowerKey.includes('password') ||
                lowerKey.includes('credential') || lowerKey.includes('auth')) {
              breadcrumb.data[key] = '[REDACTED]'
            }
          }
        }
      }
    }

    return event
  },
})

// 初始化主进程 i18n（用于菜单、对话框等）
//
// 主进程的 i18n 实例没有探测插件（Node 里没有 localStorage），
// 默认 fallbackLng 为 'en'。这里从持久化的 `uiLanguage` 偏好进行水合，
// 该偏好由用户修改「外观 → 语言」时触发的 `i18n:changeLanguage` IPC handler 维护。
// 如果不做这步，渲染进程每次重启都会从 localStorage 恢复语言，
// 而主进程默默保持英文，导致会话标题语言、系统提示里的「Preferred language」、
// 原生菜单都出错。
import { setupI18n, i18n, SUPPORTED_LANGUAGE_CODES, type LanguageCode } from '@craft-agent/shared/i18n'
import { getPersistedUiLanguage, setPersistedUiLanguage } from '@craft-agent/shared/config'
setupI18n()
const persistedUiLanguage = getPersistedUiLanguage()
if (persistedUiLanguage) {
  void i18n.changeLanguage(persistedUiLanguage)
}
// 注意：启动相关日志放在 mainLog 可用之后（log.initialize() 之后）。

// 设置匿名机器 ID 用于 Sentry 用户跟踪（无 PII，只是一个 hash）。
// 用 hostname + homedir 生成稳定的每机标识符。
const machineId = createHash('sha256').update(hostname() + homedir()).digest('hex').slice(0, 16)
Sentry.setUser({ id: machineId })

import { join, delimiter } from 'path'
import { existsSync, readFileSync } from 'fs'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { SessionManager, setSessionPlatform, setSessionRuntimeHooks } from '@craft-agent/server-core/sessions'
import { registerAllRpcHandlers } from './handlers/index'
import { registerCoreRpcHandlers, cleanupSessionFileWatchForClient } from '@craft-agent/server-core/handlers/rpc'
import type { PlatformServices } from '../runtime/platform'
import { createElectronPlatform } from './platform'
import type { HandlerDeps } from './handlers/handler-deps'
import { bootstrapServer, releaseServerLock } from '@craft-agent/server-core/bootstrap'
import { createMessagingBootstrap, type MessagingBootstrapHandle } from '@craft-agent/messaging-gateway'
import { getCredentialManager } from '@craft-agent/shared/credentials'
import { initModelRefreshService, getModelRefreshService, setFetcherPlatform } from '@craft-agent/server-core/model-fetchers'
import { setSearchPlatform, setImageProcessor } from '@craft-agent/server-core/services'
import { createApplicationMenu } from './menu'
import { WindowManager } from './window-manager'
import { loadWindowState, saveWindowState } from './window-state'
import { getWorkspaces, getWorkspaceByNameOrId, loadStoredConfig, addWorkspace, saveConfig } from '@craft-agent/shared/config'
import { getDefaultWorkspacesDir } from '@craft-agent/shared/workspaces'
import { initializeDocs } from '@craft-agent/shared/docs'
import { initializeReleaseNotes } from '@craft-agent/shared/release-notes'
import { ensureDefaultPermissions } from '@craft-agent/shared/agent/permissions-config'
import { ensureToolIcons, ensurePresetThemes } from '@craft-agent/shared/config'
import { setBundledAssetsRoot } from '@craft-agent/shared/utils'
import { initializeBackendHostRuntime } from '@craft-agent/shared/agent/backend'
import { setPowerShellValidatorRoot } from '@craft-agent/shared/agent'
import { handleDeepLink } from './deep-link'
import { BrowserPaneManager } from './browser-pane-manager'
import { OAuthFlowStore } from '@craft-agent/shared/auth'
import { registerThumbnailScheme, registerThumbnailHandler } from './thumbnail-protocol'
import log, { isDebugMode, mainLog, getLogFilePath, getMessagingGatewayLogFilePath, messagingGatewayLog, autoUpdateLog } from './logger'
import { setPerfEnabled, enableDebug } from '@craft-agent/shared/utils'
import { registerPiModelResolver } from '@craft-agent/shared/config'
import { getPiModelsForAuthProvider, getAllPiModels } from '@craft-agent/shared/config'
import { initNotificationService, initBadgeIcon, initInstanceBadge, updateBadgeCount } from './notifications'
import { checkForUpdatesOnLaunch, setAutoUpdateEventSink, isUpdating, setBeforeUpdateQuitHook } from './auto-update'
import type { EventSink } from '@craft-agent/server-core/transport'
import { validateGitBashPath, checkVCRedistInstalled } from '@craft-agent/server-core/services'

// 初始化 electron-log，也支持渲染进程日志
log.initialize()

// 诊断日志：报告主进程 i18n 水合结果。这里才记录是因为 mainLog 到此点才可用。
mainLog.info('[i18n] startup hydration', {
  persistedUiLanguage: persistedUiLanguage ?? null,
  resolvedLanguageAfterHydration: i18n.resolvedLanguage ?? null,
})

// 开发模式（从源码运行）启用调试/性能日志
if (isDebugMode) {
  process.env.CRAFT_DEBUG = '1'
  enableDebug()
  setPerfEnabled(true)
}

// 打包 CLI 工具：解析平台相关的 uv 二进制和包装脚本。
// 通过 CRAFT_UV、CRAFT_SCRIPTS 环境变量和 PATH 前置暴露给所有 agent Bash 会话。
// uv 首次使用时会自动下载 Python 3.12（约 5 秒，之后缓存）。
{
  // 打包应用：资源位于 process.resourcesPath/app/resources/
  // 开发环境：资源位于 __dirname/../resources/（dist 的同级目录）
  const resourcesBase = app.isPackaged
    ? join(process.resourcesPath, 'app')
    : join(__dirname, '..')
  const platformKey = `${process.platform}-${process.arch}`
  const uvPlatformDir = join(resourcesBase, 'resources', 'bin', platformKey)
  const uvBinary = join(uvPlatformDir, process.platform === 'win32' ? 'uv.exe' : 'uv')
  const binDir = join(resourcesBase, 'resources', 'bin')
  const scriptsDir = join(resourcesBase, 'resources', 'scripts')

  const bundledUvExists = existsSync(uvBinary)
  const fallbackUv = bundledUvExists ? null : 'uv'

  // 给共享 session 工具的运行时解析提示
  process.env.CRAFT_IS_PACKAGED = app.isPackaged ? '1' : '0'
  process.env.CRAFT_RESOURCES_BASE = resourcesBase
  process.env.CRAFT_APP_ROOT = app.isPackaged ? app.getAppPath() : process.cwd()

  process.env.CRAFT_UV = bundledUvExists ? uvBinary : (fallbackUv ?? uvBinary)

  // Bun 运行时：打包构建优先使用自带的 bun，而不是 PATH 上的
  const bunBinary = join(resourcesBase, 'vendor', 'bun', process.platform === 'win32' ? 'bun.exe' : 'bun')
  if (existsSync(bunBinary)) {
    process.env.CRAFT_BUN = bunBinary
  }

  process.env.CRAFT_SCRIPTS = scriptsDir
  process.env.CRAFT_COMMANDS_ENTRY = app.isPackaged
    ? join(app.getAppPath(), 'packages', 'craft-agents-commands', 'src', 'main.ts')
    : join(process.cwd(), 'packages', 'craft-agents-commands', 'src', 'main.ts')
  process.env.CRAFT_CLI_ENTRY = app.isPackaged
    ? join(app.getAppPath(), 'packages', 'craft-cli', 'src', 'cli.ts')
    : join(process.cwd(), 'packages', 'craft-cli', 'src', 'cli.ts')
  process.env.CRAFT_COMMANDS_DOC_PATH = app.isPackaged
    ? join(resourcesBase, 'resources', 'docs', 'craft-cli.md')
    : join(process.cwd(), 'apps', 'electron', 'resources', 'docs', 'craft-cli.md')
  process.env.CRAFT_CLI_DOC_PATH = process.env.CRAFT_COMMANDS_DOC_PATH
  process.env.CRAFT_AGENT_VERSION = app.getVersion()
  // 把通用包装脚本目录和平台 uv 目录都加到 PATH 前面：
  // - binDir 暴露包装命令（pdf-tool、docx-tool 等）
  // - uvPlatformDir 暴露原始 `uv`，便于直接 shell 使用或调试
  process.env.PATH = `${binDir}${delimiter}${uvPlatformDir}${delimiter}${process.env.PATH}`

  if (!bundledUvExists) {
    mainLog.warn('Bundled uv binary missing, CLI document tools may fail unless uv is available on PATH.', {
      expectedUvPath: uvBinary,
      usingCraftUv: process.env.CRAFT_UV,
    })
  }

  if (isDebugMode) {
    mainLog.info('CLI tools configured:', { uvBinary: process.env.CRAFT_UV, binDir, scriptsDir, bundledUvExists })
  }
}

// 注册 Pi model 解析器，让 llm-connections.ts 能解析 Pi 模型
// 而不必引入 @earendil-works/pi-ai（会破坏 Vite 渲染进程构建）
registerPiModelResolver((piAuthProvider) =>
  piAuthProvider ? getPiModelsForAuthProvider(piAuthProvider) : getAllPiModels()
)

// 自定义 URL scheme，用于深链（如 craftagents://auth-complete）
// 支持多实例开发：CRAFT_DEEPLINK_SCHEME 环境变量（craftagents1、craftagents2 等）
const DEEPLINK_SCHEME = process.env.CRAFT_DEEPLINK_SCHEME || 'craftagents'

let windowManager: WindowManager | null = null
let sessionManager: SessionManager | null = null
let browserPaneManager: BrowserPaneManager | null = null
let oauthFlowStore: OAuthFlowStore | null = null
let moduleSink: EventSink | null = null
let moduleClientResolver: ((webContentsId: number) => string | undefined) | null = null

// Messaging gateway：bootstrap handle 在 sessionManager 可用时
//（createHandlerDeps 内部）创建，bootstrapServer 完成后再把 WS publisher 注入进去。
// Electron 和独立服务器两种宿主都通过 createMessagingBootstrap 接线，
// 不要直接构造 MessagingGatewayRegistry。
let messagingHandle: MessagingBootstrapHandle | null = null

// 冷启动时如果应用还没准备好，先把深链存起来
let pendingDeepLink: string | null = null

// 在 app.whenReady() 之前尽早设置应用名，确保 macOS 菜单栏标题正确
// 支持多实例开发：CRAFT_APP_NAME 环境变量（如 "Craft Agents [1]"）
app.setName(process.env.CRAFT_APP_NAME || 'Craft Agents')

// 注册为 craftagents:// URL 的默认协议客户端
// 某些平台要求在 app.whenReady() 之前完成
if (process.defaultApp) {
  // 开发模式：需要传入应用路径
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(DEEPLINK_SCHEME, process.execPath, [process.argv[1]])
  }
} else {
  // 生产模式
  app.setAsDefaultProtocolClient(DEEPLINK_SCHEME)
}

// 尽早应用网络代理设置（仅 Node 层；Electron session 要等 app.whenReady）
import { applyConfiguredProxySettings } from './network-proxy'
void applyConfiguredProxySettings()

// 连接用户配置的远程服务器时允许自签名/不受信任证书。
// 只对 CRAFT_SERVER_URL 的来源跳过证书校验，其他连接仍走标准验证。
// 否则 wss:// 到自签名服务器会因为 Chromium WebSocket 拒绝不受信任证书而报 ERR_CERT_AUTHORITY_INVALID。
//
// Electron 的 certificate-error 事件总是把 URL 报告成 https:// scheme，
// 所以把 wss:// 归一化为 https://（ws:// 归一化为 http://），确保来源比较正确。
function normalizeOriginForCert(urlStr: string): string {
  const u = new URL(urlStr)
  if (u.protocol === 'wss:') u.protocol = 'https:'
  else if (u.protocol === 'ws:') u.protocol = 'http:'
  return u.origin
}

if (process.env.CRAFT_SERVER_URL) {
  let serverOrigin: string | undefined
  try {
    serverOrigin = normalizeOriginForCert(process.env.CRAFT_SERVER_URL)
  } catch {
    // URL 无效，稍后连接时会失败，这里不需要处理
  }
  if (serverOrigin) {
    app.on('certificate-error', (event, _webContents, url, _error, _certificate, callback) => {
      try {
        if (normalizeOriginForCert(url) === serverOrigin) {
          event.preventDefault()
          callback(true)
          return
        }
      } catch {
        // URL 解析失败，落到底层默认拒绝
      }
      callback(false)
    })
  }
}

// 注册 thumbnail:// 自定义协议，用于侧边栏文件预览缩略图。
// 必须在 app.whenReady() 之前完成——Electron 要求尽早注册 scheme。
registerThumbnailScheme()

// macOS：处理应用运行期间收到的深链
app.on('open-url', (event, url) => {
  event.preventDefault()
  mainLog.info('Received deeplink:', url)

  if (windowManager) {
    handleDeepLink(url, windowManager, moduleSink ?? undefined, moduleClientResolver ?? undefined).catch(err => {
      mainLog.error('Failed to handle deep link:', err)
    })
  } else {
    // 应用还没准备好，先存起来稍后处理
    pendingDeepLink = url
  }
})

// Windows/Linux：单实例检查 + 深链处理
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, commandLine, _workingDirectory) => {
    // 有第二个实例启动时，应该聚焦当前窗口。
    // Windows/Linux 上深链在 commandLine 里
    const url = commandLine.find(arg => arg.startsWith(`${DEEPLINK_SCHEME}://`))
    if (url && windowManager) {
      mainLog.info('Received deeplink from second instance:', url)
      handleDeepLink(url, windowManager, moduleSink ?? undefined, moduleClientResolver ?? undefined).catch(err => {
        mainLog.error('Failed to handle deep link:', err)
      })
    } else if (windowManager) {
      // 没有深链，只聚焦第一个窗口
      const windows = windowManager.getAllWindows()
      if (windows.length > 0) {
        const win = windows[0].window
        if (win.isMinimized()) win.restore()
        win.focus()
      }
    }
  })
}

// 启动时创建初始窗口的辅助函数
async function createInitialWindows(): Promise<void> {
  if (!windowManager) return

  // 加载保存的窗口状态
  const savedState = loadWindowState()
  let workspaces = getWorkspaces()

  // 首次运行没有 workspace 时，创建默认的 "My Workspace"
  if (workspaces.length === 0) {
    // 确保配置文件存在（addWorkspace 需要）
    if (!loadStoredConfig()) {
      saveConfig({ workspaces: [], activeWorkspaceId: null, activeSessionId: null })
    }
    const defaultPath = join(getDefaultWorkspacesDir(), 'my-workspace')
    addWorkspace({ rootPath: defaultPath, name: 'My Workspace' })
    workspaces = getWorkspaces() // 创建后刷新
    mainLog.info('Created default workspace on first run')
  }

  const validWorkspaceIds = workspaces.map(ws => ws.id)

  if (savedState?.windows.length) {
    // 从保存状态恢复窗口
    let restoredCount = 0

    for (const saved of savedState.windows) {
      // 跳过无效 workspace
      if (!validWorkspaceIds.includes(saved.workspaceId)) continue

      // 恢复主窗口；如果保存时处于 focused 模式也恢复
      mainLog.info(`Restoring window: workspaceId=${saved.workspaceId}, focused=${saved.focused ?? false}, url=${saved.url ?? 'none'}`)
      const win = windowManager.createWindow({
        workspaceId: saved.workspaceId,
        focused: saved.focused,
        restoreUrl: saved.url,
      })
      win.setBounds(saved.bounds)

      restoredCount++
    }

    if (restoredCount > 0) {
      mainLog.info(`Restored ${restoredCount} window(s) from saved state`)
      return
    }
  }

  // 默认：为第一个 workspace 打开窗口
  windowManager.createWindow({ workspaceId: workspaces[0].id })
  mainLog.info(`Created window for first workspace: ${workspaces[0].name}`)
}

app.whenReady().then(async () => {
  // 把打包状态导出为环境变量，这样 logger.ts（以及 headless Bun）不必引入 'electron'
  process.env.CRAFT_IS_PACKAGED = app.isPackaged ? 'true' : 'false'

  // 注册打包资源根目录，所有 seeding 函数都能通过 getBundledAssetsDir 找到文件
  //（docs、permissions、themes、tool-icons 都从这里解析）
  setBundledAssetsRoot(__dirname)

  // 初始化后端运行时启动（Codex vendor 根目录、Claude SDK 运行时路径）
  initializeBackendHostRuntime({
    hostRuntime: {
      appRootPath: app.isPackaged ? app.getAppPath() : process.cwd(),
      resourcesPath: process.resourcesPath,
      isPackaged: app.isPackaged,
    },
  })

  // 注册 PowerShell 验证器根目录，让它能找到打包的解析脚本
  //（仅 Windows：在 Explore 模式下用 AST 分析验证 PowerShell 命令）
  setPowerShellValidatorRoot(join(__dirname, 'resources'))

  // 初始化打包文档
  initializeDocs()

  // 初始化打包 release notes
  initializeReleaseNotes()

  // 确保默认权限文件存在（首次运行时从打包 default.json 复制）
  ensureDefaultPermissions()

  // 把工具图标种子复制到 ~/.craft-agent/tool-icons/（首次运行）
  ensureToolIcons()

  // 把预设主题复制到 ~/.craft-agent/themes/（首次运行）
  ensurePresetThemes()

  // 注册 thumbnail:// 协议处理器（scheme 已在 app.whenReady 前注册）
  registerThumbnailHandler()

  // Electron session 已可用，重新应用代理设置
  //（before app.whenReady 那次只配置了 Node 层代理）
  await applyConfiguredProxySettings()

  // 注意：electron-updater 通过 autoInstallOnAppQuit 自动处理待安装更新

  // 应用菜单在 windowManager 初始化后再创建（见下文）

  // macOS：设置 Dock 图标（开发模式需要；打包应用通过 Info.plist）
  if (process.platform === 'darwin' && app.dock) {
    // 打包应用：资源在 dist/resources/（与 __dirname 同级）
    // 开发环境：资源在 ../resources/（dist 的兄弟目录）
    const dockIconPath = [
      join(__dirname, 'resources/icon.png'),
      join(__dirname, '../resources/icon.png'),
    ].find(p => existsSync(p))

    if (dockIconPath) {
      app.dock.setIcon(dockIconPath)
      // 初始化用于 Canvas 角标叠加的基础图标
      initBadgeIcon(dockIconPath)
    }

    // 多实例开发：在 Dock 图标上显示实例编号角标
    // CRAFT_INSTANCE_NUMBER 由 detect-instance.sh 为编号目录设置
    const instanceNum = process.env.CRAFT_INSTANCE_NUMBER
    if (instanceNum) {
      const num = parseInt(instanceNum, 10)
      if (!isNaN(num) && num > 0) {
        initInstanceBadge(num)
      }
    }
  }

  try {
    // 初始化窗口管理器
    windowManager = new WindowManager()

    // 创建应用菜单（新建窗口动作需要 windowManager）
    createApplicationMenu(windowManager)

    // 如果设置了 CRAFT_SERVER_URL，当前 Electron 实例是瘦客户端——
    // 只创建窗口，preload 会连接到远程服务器。
    // 跳过服务端初始化（SessionManager、模型刷新、平台注入）。
    const isClientOnly = !!process.env.CRAFT_SERVER_URL
    const isHeadless = !!process.env.CRAFT_HEADLESS

    if (isClientOnly) {
      mainLog.info(`Client-only mode: CRAFT_SERVER_URL=${process.env.CRAFT_SERVER_URL} (server initialization skipped)`)
    }

    // 初始化通知服务（始终初始化，因为由服务器推送事件触发）
    initNotificationService(windowManager)

    // 初始化浏览器面板管理器（即使 headless 也要初始化，用于依赖接线）
    browserPaneManager = new BrowserPaneManager()
    browserPaneManager.setWindowManager(windowManager)
    browserPaneManager.registerToolbarIpc()
    browserPaneManager.registerCapabilityIpc()

    // 从 Electron API 构建真正的 PlatformServices
    const platform: PlatformServices = createElectronPlatform({
      app,
      nativeImage,
      shell,
      nativeTheme,
      logger: log,
      isDebugMode,
      getLogFilePath,
      captureError: (err) => Sentry.captureException(err),
    })

    // 启动 IPC handler —— preload 用 sendSync 获取窗口本地信息
    ipcMain.on('__get-web-contents-id', (e) => {
      e.returnValue = e.sender.id
    })
    ipcMain.on('__get-workspace-id', (e) => {
      e.returnValue = windowManager?.getWorkspaceForWindow(e.sender.id) ?? ''
    })

    // 传输诊断桥 —— preload 报告远程 WS 连接状态变化，
    // 这样失败信息也能在终端/main.log 看到，而不仅限于渲染进程控制台。
    ipcMain.on('__transport:status', (_event, payload: unknown) => {
      if (!payload || typeof payload !== 'object') return
      const p = payload as {
        level?: 'info' | 'warn' | 'error'
        message?: string
        status?: string
        attempt?: number
        nextRetryInMs?: number
        error?: unknown
        close?: unknown
        url?: string
      }

      const level = p.level ?? 'info'
      const message = p.message ?? '[transport] status update'
      const context = {
        status: p.status,
        attempt: p.attempt,
        nextRetryInMs: p.nextRetryInMs,
        error: p.error,
        close: p.close,
        url: p.url,
      }

      if (level === 'error') {
        mainLog.error(message, context)
      } else if (level === 'warn') {
        mainLog.warn(message, context)
      } else {
        mainLog.info(message, context)
      }
    })

    // 对话框桥 —— preload 的能力处理器通过 ipcRenderer.invoke 调用
    // 主进程独占的 dialog/BrowserWindow API。
    ipcMain.handle('__dialog:showMessageBox', async (event, spec) => {
      const win = BrowserWindow.fromWebContents(event.sender)
        || BrowserWindow.getFocusedWindow()
        || BrowserWindow.getAllWindows()[0]
      const result = await dialog.showMessageBox(win, spec)
      return { response: result.response }
    })
    ipcMain.handle('__dialog:showOpenDialog', async (event, spec) => {
      const win = BrowserWindow.fromWebContents(event.sender)
        || BrowserWindow.getFocusedWindow()
        || BrowserWindow.getAllWindows()[0]
      const result = await dialog.showOpenDialog(win, spec)
      return { canceled: result.canceled, filePaths: result.filePaths }
    })

    if (!isClientOnly) {
      // Windows：恢复持久化的 Git Bash 路径（必须在任何 SDK 子进程启动前）
      if (process.platform === 'win32') {
        const { getGitBashPath, clearGitBashPath } = await import('@craft-agent/shared/config')
        const gitBashPath = getGitBashPath()
        if (gitBashPath) {
          const validation = await validateGitBashPath(gitBashPath)
          if (validation.valid) {
            process.env.CLAUDE_CODE_GIT_BASH_PATH = validation.path
          } else {
            clearGitBashPath()
            delete process.env.CLAUDE_CODE_GIT_BASH_PATH
            mainLog.warn(`Cleared invalid persisted Git Bash path: ${gitBashPath}`)
          }
        }
      }

      // Windows：检查 VC++ Redistributable（onnxruntime / markitdown 需要）。
      // 没有它时，PDF、PPTX、DOCX、XLSX 等文档转换工具会因 DLL 错误崩溃。
      // 设置环境变量，让渲染进程显示可操作的安装提示 toast。
      if (process.platform === 'win32') {
        const vcCheck = checkVCRedistInstalled()
        if (!vcCheck.installed) {
          mainLog.warn('[vcredist]', vcCheck.message)
          process.env.CRAFT_VCREDIST_MISSING = '1'
          if (vcCheck.downloadUrl) {
            process.env.CRAFT_VCREDIST_URL = vcCheck.downloadUrl
          }
        } else if (isDebugMode) {
          mainLog.info('[vcredist]', vcCheck.message)
        }
      }

      // 预加载电源管理器（applyPlatformToSubsystems 需要异步 import）
      const { onSessionStarted, onSessionStopped } = await import('./power-manager')

      // Electron IPC 桥的 Client ID 映射（webContentsId → clientId）
      const clientMap = new Map<number, string>()
      const resolveClientId = (wcId: number) => clientMap.get(wcId)

      // 读取内置服务器配置（服务器设置页）
      const { getServerConfig } = await import('@craft-agent/shared/config')
      const embeddedServerConfig = getServerConfig()
      const serverModeEnabled = embeddedServerConfig.enabled && !isClientOnly

      // 从服务器配置或环境变量覆盖推导 host/port/token
      const serverToken = serverModeEnabled && embeddedServerConfig.token
        ? embeddedServerConfig.token
        : randomUUID()
      const rpcHost = process.env.CRAFT_RPC_HOST
        ?? (serverModeEnabled ? '0.0.0.0' : '127.0.0.1')
      const rpcPort = process.env.CRAFT_RPC_PORT
        ? parseInt(process.env.CRAFT_RPC_PORT, 10)
        : (serverModeEnabled ? embeddedServerConfig.port : 0)

      // 如果配置了 TLS 证书则加载
      let tls: import('@craft-agent/server-core/transport').WsRpcTlsOptions | undefined
      if (serverModeEnabled && embeddedServerConfig.tlsCertPath && embeddedServerConfig.tlsKeyPath) {
        try {
          tls = {
            cert: readFileSync(embeddedServerConfig.tlsCertPath),
            key: readFileSync(embeddedServerConfig.tlsKeyPath),
          }
          mainLog.info('[server-mode] TLS enabled')
        } catch (err) {
          mainLog.error('[server-mode] Failed to load TLS certificates:', err)
        }
      }

      if (serverModeEnabled) {
        mainLog.info(`[server-mode] Enabled — binding ${rpcHost}:${rpcPort}${tls ? ' (TLS)' : ''}`)
      }

      // 通过共享 bootstrap 函数启动 WS RPC 服务器
      const instance = await bootstrapServer<SessionManager, HandlerDeps>({
        serverToken,
        rpcHost,
        rpcPort,
        tls,
        bundledAssetsRoot: __dirname,
        serverId: 'local',
        serverVersion: app.getVersion(),
        platformFactory: () => platform,
        applyPlatformToSubsystems: (p) => {
          setFetcherPlatform(p)
          setSessionPlatform(p)
          setSessionRuntimeHooks({
            updateBadgeCount,
            onSessionStarted,
            onSessionStopped,
            captureException: (error, context) => {
              Sentry.captureException(error instanceof Error ? error : new Error(String(error)), {
                tags: {
                  ...(context?.errorSource ? { errorSource: context.errorSource } : {}),
                  ...(context?.sessionId ? { sessionId: context.sessionId } : {}),
                },
              })
            },
          })
          setSearchPlatform(p)
          setImageProcessor(p.imageProcessor)
        },
        createSessionManager: () => {
          const sm = new SessionManager()
          sm.setBrowserPaneManager(browserPaneManager!)
          return sm
        },
        bindRpcServer: (sm, server) => sm.setRpcServer(server),
        createHandlerDeps: ({ sessionManager: sm, platform: p, oauthFlowStore: ofs }) => {
          // messaging handle 在这里创建，因为它需要 sessionManager。
          // WS publisher 在 bootstrapServer 完成后通过 handle.setPublisher 注入，
          // 因为此时 wsServer 还不存在。
          messagingHandle = createMessagingBootstrap({
            sessionManager: sm,
            credentialManager: getCredentialManager(),
            getMessagingDir: (wsId: string) =>
              join(homedir(), '.craft-agent', 'workspaces', wsId, 'messaging'),
            getLegacyMessagingDir: (wsId: string) => {
              const ws = getWorkspaces().find((w) => w.id === wsId)
              return ws ? join(ws.rootPath, 'messaging') : undefined
            },
            // 把消息网关诊断日志路由到专用日志文件
            // ~/.craft-agent/logs/messaging-gateway.log。
            logger: messagingGatewayLog,
            // WhatsApp worker 通过 Electron 的嵌入式 Node 运行（ELECTRON_RUN_AS_NODE）。
            // WhatsAppAdapter 默认 nodeBin 为 process.execPath。
            // 开发环境从 monorepo 解析 worker.cjs；打包构建通过 extraResources 分发
            //（见 apps/electron/electron-builder.yml）。
            whatsapp: {
              workerEntry: app.isPackaged
                ? join(process.resourcesPath, 'messaging-whatsapp-worker', 'worker.cjs')
                : join(process.cwd(), 'packages', 'messaging-whatsapp-worker', 'dist', 'worker.cjs'),
              pairingMode: 'qr',
            },
          })
          return {
            sessionManager: sm,
            platform: p,
            windowManager: windowManager ?? undefined,
            browserPaneManager: browserPaneManager ?? undefined,
            oauthFlowStore: ofs,
            messagingRegistry: messagingHandle.registry,
          }
        },
        // Headless：只注册核心 handler（没有浏览器、设置等 GUI handler）
        // GUI：注册全部 handler（核心 + GUI）
        registerAllRpcHandlers: isHeadless
          ? (server, deps, serverCtx) => registerCoreRpcHandlers(server, deps, serverCtx)
          : registerAllRpcHandlers,
        setSessionEventSink: (sm, sink) => sm.setEventSink(sink),
        initializeSessionManager: (sm) => sm.initialize(),
        initModelRefreshService: () => initModelRefreshService(async (slug: string) => {
          const { getCredentialManager } = await import('@craft-agent/shared/credentials')
          const manager = getCredentialManager()
          const [apiKey, oauth] = await Promise.all([
            manager.getLlmApiKey(slug).catch(() => null),
            manager.getLlmOAuth(slug).catch(() => null),
          ])
          return {
            apiKey: apiKey ?? undefined,
            oauthAccessToken: oauth?.accessToken,
            oauthRefreshToken: oauth?.refreshToken,
            oauthIdToken: oauth?.idToken,
          }
        }),
        onClientConnected: ({ clientId, webContentsId }) => {
          if (webContentsId != null) clientMap.set(webContentsId, clientId)
        },
        cleanupClientResources: (clientId) => {
          for (const [wcId, cId] of clientMap) {
            if (cId === clientId) { clientMap.delete(wcId); break }
          }
          cleanupSessionFileWatchForClient(clientId)
        },
      })

      // 捕获模块级引用，用于 before-quit 清理和深链处理器
      sessionManager = instance.sessionManager
      oauthFlowStore = instance.oauthFlowStore
      moduleSink = instance.wsServer.push.bind(instance.wsServer)
      moduleClientResolver = resolveClientId

      // -----------------------------------------------------------------------
      // Messaging Gateway —— 注入 WS publisher、初始化本地 workspace、
      // 安装 fan-out 事件 sink。handle 在 createHandlerDeps 里创建，
      // 这样 registry 才能被接到 HandlerDeps 里。
      // -----------------------------------------------------------------------
      try {
        if (!messagingHandle) {
          throw new Error('Messaging handle was not constructed in createHandlerDeps')
        }

        messagingHandle.setPublisher(instance.wsServer.push.bind(instance.wsServer))

        // 跳过远程拥有的 workspace —— messaging 在远程服务器上运行
        const localWorkspaceIds = getWorkspaces()
          .filter((ws) => !ws.remoteServer)
          .map((ws) => ws.id)
        await messagingHandle.initializeWorkspaces(localWorkspaceIds)

        // 组合 fan-out 事件 sink：RPC push + messaging gateway 分发。
        // 始终安装——这样 workspace 可以在运行时启用 messaging 而无需重启进程。
        const baseSink = instance.wsServer.push.bind(instance.wsServer)
        instance.sessionManager.setEventSink(messagingHandle.wrapSink(baseSink))
        if (messagingHandle.registry.size > 0) {
          mainLog.info(`[messaging] Fan-out sink active for ${messagingHandle.registry.size} workspace(s)`)
        }
      } catch (err) {
        mainLog.error('[messaging] Gateway initialization failed:', err)
      }

      // IPC handler —— preload 用 sendSync 获取 WS 连接信息

      // 从配置中移除 workspace（清理失效条目）
      ipcMain.handle('workspace:remove', async (_event, workspaceId: string) => {
        const { removeWorkspace: remove } = await import('@craft-agent/shared/config')
        return remove(workspaceId)
      })

      // 跨服务器 RPC —— 调用任意远程服务器上的 channel
      ipcMain.handle('server:invokeOnServer', async (_event, url: string, token: string, channel: string, ...args: unknown[]) => {
        const { connectToRemote } = await import('./handlers/workspace')
        const { client, error } = await connectToRemote(url, token)
        if (!client) throw new Error(error ?? 'Connection failed')
        try {
          return await client.invoke(channel, ...args)
        } finally {
          client.destroy()
        }
      })

      // 把 session 转移到另一个 workspace —— 在主进程里编排，
      // 这样大 bundle 可以直接在所属服务器之间搬运。
      ipcMain.handle('session:transferToRemoteWorkspace', async (_event, sessionId: string, targetWorkspaceId: string, sessionIndex?: number, sessionCount?: number) => {
        const idx = sessionIndex ?? 0
        const count = sessionCount ?? 1
        const { getWorkspaceByNameOrId } = await import('@craft-agent/shared/config')
        const { connectToRemote } = await import('./handlers/workspace')
        const { CHUNKED_TRANSFER_THRESHOLD, getChunkCount, invokeChunked, prepareChunkedPayload } = await import('./chunked-rpc')

        const targetWorkspace = getWorkspaceByNameOrId(targetWorkspaceId)
        if (!targetWorkspace?.remoteServer) throw new Error(`Workspace ${targetWorkspaceId} has no remote server`)
        if (!sessionManager) throw new Error('Session manager not initialized')

        const sourceWorkspaceLocalId = windowManager?.getWorkspaceForWindow(_event.sender.id)
        if (!sourceWorkspaceLocalId) throw new Error('Unable to resolve source workspace for transfer')

        const sourceWorkspace = getWorkspaceByNameOrId(sourceWorkspaceLocalId)
        if (!sourceWorkspace) throw new Error(`Source workspace ${sourceWorkspaceLocalId} not found`)

        let bundle: any = null

        if (sourceWorkspace.remoteServer) {
          const { url: sourceUrl, token: sourceToken, remoteWorkspaceId: sourceRemoteWorkspaceId } = sourceWorkspace.remoteServer
          console.log(`[Transfer] Exporting remote-owned session ${sessionId} from workspace ${sourceRemoteWorkspaceId}...`)
          const { client: sourceClient, error: sourceError } = await connectToRemote(sourceUrl, sourceToken, sourceRemoteWorkspaceId)
          if (!sourceClient) throw new Error(sourceError ?? 'Connection failed to source remote server')

          try {
            bundle = await sourceClient.invoke('sessions:export', sessionId)
            if (!bundle) throw new Error(`Failed to export session ${sessionId}`)

            try {
              console.log('[Transfer] Generating conversation summary on source server...')
              const transferPayload = await sourceClient.invoke('sessions:exportRemoteTransfer', sessionId)
              if (transferPayload?.summary && bundle.session?.header) {
                ;(bundle.session.header as any).transferredSessionSummary = transferPayload.summary
                ;(bundle.session.header as any).transferredSessionSummaryApplied = false
                console.log(`[Transfer] Summary generated: ${transferPayload.summary.length} chars`)
              }
            } catch (err) {
              console.warn('[Transfer] Source-server summary generation failed:', err)
            }
          } finally {
            sourceClient.destroy()
          }
        } else {
          console.log(`[Transfer] Exporting local-owned session ${sessionId} from workspace ${sourceWorkspace.id}...`)
          bundle = await sessionManager.exportSession(sessionId, sourceWorkspace.id)
          if (!bundle) throw new Error(`Failed to export session ${sessionId}`)

          try {
            console.log('[Transfer] Generating conversation summary...')
            const transferPayload = await sessionManager.exportRemoteSessionTransfer(sessionId, sourceWorkspace.id)
            if (transferPayload?.summary && bundle.session?.header) {
              ;(bundle.session.header as any).transferredSessionSummary = transferPayload.summary
              ;(bundle.session.header as any).transferredSessionSummaryApplied = false
              console.log(`[Transfer] Summary generated: ${transferPayload.summary.length} chars`)
            }
          } catch (err) {
            console.warn('[Transfer] Summary generation failed:', err)
          }
        }

        console.log(`[Transfer] Export complete: ${bundle.session?.messages?.length ?? 0} messages, ${bundle.files?.length ?? 0} files`)

        const { url, token, remoteWorkspaceId } = targetWorkspace.remoteServer
        console.log(`[Transfer] Connecting to target remote server: ${url}`)
        const { client, error } = await connectToRemote(url, token, remoteWorkspaceId)
        if (!client) throw new Error(error ?? 'Connection failed to target remote server')
        console.log('[Transfer] Connected to target remote server')

        try {
          const preparedBundle = prepareChunkedPayload(bundle)
          const payloadSize = preparedBundle.bytes.length
          const payloadMB = (payloadSize / (1024 * 1024)).toFixed(1)

          const emitProgress = (chunkSent: number, chunkTotal: number) => {
            try { _event.sender.send('transfer:progress', { sessionIndex: idx, sessionCount: count, chunkSent, chunkTotal }) } catch { /* 渲染进程可能已关闭 */ }
          }

          if (payloadSize < CHUNKED_TRANSFER_THRESHOLD) {
            console.log(`[Transfer] Bundle size: ${payloadMB}MB (< 5MB threshold) → using direct RPC`)
            emitProgress(0, 1)
            const result = await client.invoke('sessions:import', remoteWorkspaceId, bundle, 'fork')
            emitProgress(1, 1)
            return result
          }

          const chunkCount = getChunkCount(payloadSize)
          console.log(`[Transfer] Bundle size: ${payloadMB}MB (>= 5MB threshold) → using chunked transfer (${chunkCount} chunks)`)
          return await invokeChunked(
            client,
            'sessions:import',
            [remoteWorkspaceId, bundle, 'fork'],
            1,
            emitProgress,
            preparedBundle,
          )
        } finally {
          client.destroy()
        }
      })

      // 应用重启（用于服务器配置变化，不是更新安装）
      ipcMain.handle('app:relaunch', () => {
        app.relaunch()
        app.exit(0)
      })

      // 语言切换：从渲染进程同步到主进程，持久化，并重建原生菜单。
      // 这里的持久化让下次启动时能正确水合主进程 i18n——
      // 见文件顶部的 `getPersistedUiLanguage()` 块。
      ipcMain.handle('i18n:changeLanguage', async (_event, lang: unknown) => {
        const previousResolved = i18n.resolvedLanguage ?? null
        if (typeof lang !== 'string' || !SUPPORTED_LANGUAGE_CODES.includes(lang as LanguageCode)) {
          // 纵深防御：渲染进程保证传入受支持的语言代码，但如果有恶意/异常调用者
          // 传垃圾数据，我们静默丢弃，避免污染 i18n 状态。
          mainLog.warn('[i18n] changeLanguage IPC rejected — unsupported code', {
            incoming: lang,
            previousResolved,
          })
          return
        }
        const code = lang as LanguageCode
        await i18n.changeLanguage(code)
        setPersistedUiLanguage(code)
        mainLog.info('[i18n] changeLanguage IPC applied', {
          incoming: code,
          previousResolved,
          newResolved: i18n.resolvedLanguage ?? null,
        })
        const { rebuildMenu } = await import('./menu')
        await rebuildMenu()
      })

      ipcMain.on('__get-ws-port', (e) => {
        e.returnValue = instance.port
      })
      ipcMain.on('__get-ws-token', (e) => {
        e.returnValue = instance.token
      })
      ipcMain.on('__get-workspace-remote-config', (e) => {
        const wsId = windowManager?.getWorkspaceForWindow(e.sender.id)
        if (!wsId) { e.returnValue = null; return }
        const ws = getWorkspaceByNameOrId(wsId)
        e.returnValue = ws?.remoteServer ?? null
      })

      // 服务器配置 RPC handler（LOCAL_ONLY —— Electron 专属）
      const runningServerState = {
        host: rpcHost,
        port: instance.port,
        tls: !!tls,
        token: serverToken,
        enabled: serverModeEnabled,
      }

      instance.wsServer.handle(RPC_CHANNELS.settings.GET_SERVER_CONFIG, async () => {
        const { getServerConfig: getConfig } = await import('@craft-agent/shared/config')
        return getConfig()
      })

      instance.wsServer.handle(RPC_CHANNELS.settings.SET_SERVER_CONFIG, async (_ctx: unknown, config: unknown) => {
        const { setServerConfig: setConfig } = await import('@craft-agent/shared/config')
        const cfg = config as import('@craft-agent/shared/config/server-config').ServerConfig
        // 校验端口范围
        if (cfg.port < 1024 || cfg.port > 65535) {
          throw new Error(`Port must be between 1024 and 65535, got ${cfg.port}`)
        }
        // 校验证书/私钥文件存在
        if (cfg.tlsCertPath && !existsSync(cfg.tlsCertPath)) {
          throw new Error(`Certificate file not found: ${cfg.tlsCertPath}`)
        }
        if (cfg.tlsKeyPath && !existsSync(cfg.tlsKeyPath)) {
          throw new Error(`Private key file not found: ${cfg.tlsKeyPath}`)
        }
        setConfig(cfg)
      })

      instance.wsServer.handle(RPC_CHANNELS.settings.GET_SERVER_STATUS, async () => {
        const { getServerConfig: getConfig } = await import('@craft-agent/shared/config')
        const saved = getConfig()
        const protocol = runningServerState.tls ? 'wss' : 'ws'

        // 确定展示用的 host（如果绑定到 0.0.0.0 则取局域网 IP）
        let displayHost = runningServerState.host
        if (displayHost === '0.0.0.0' || displayHost === '::') {
          const os = await import('os')
          const nets = os.networkInterfaces()
          for (const name of Object.keys(nets)) {
            for (const net of nets[name] ?? []) {
              if (net.family === 'IPv4' && !net.internal) {
                displayHost = net.address
                break
              }
            }
            if (displayHost !== '0.0.0.0' && displayHost !== '::') break
          }
        }

        // 只有至少一侧启用了 server 模式时才比较 port/tls/token。
        // 如果两边都禁用，运行端口是随机的，和保存的默认值（9100）比较会永远误报「需要重启」。
        const needsRestart = saved.enabled !== runningServerState.enabled
          || ((saved.enabled || runningServerState.enabled) && (
            saved.port !== runningServerState.port
            || (!!saved.tlsCertPath) !== runningServerState.tls
            || (saved.token ?? '') !== runningServerState.token
          ))

        return {
          running: true,
          host: runningServerState.host,
          port: runningServerState.port,
          tls: runningServerState.tls,
          url: `${protocol}://${displayHost}:${runningServerState.port}`,
          token: runningServerState.token,
          needsRestart,
          insecureWarning: isInsecureBind,
        }
      })

      // TLS 强制提醒：server 模式绑定到网络地址但没有 TLS 时警告
      // 与 packages/server/src/index.ts 的硬守卫对应，但这里只警告不阻止，
      // 因为用户通过 UI 显式启用了 server 模式（可能在受信任的局域网）。
      const isInsecureBind = serverModeEnabled && !tls
        && !['127.0.0.1', 'localhost', '::1'].includes(rpcHost)
      if (isInsecureBind) {
        mainLog.warn(
          '[server-mode] WARNING: Listening on a network address without TLS. ' +
          'Auth tokens will be sent in cleartext. ' +
          'Configure TLS certificates in Settings > Server.'
        )
      }

      // 把 EventSink 接到 Electron 专属服务
      // 必须在 createInitialWindows() 之前完成，这样事件处理器从一开始就使用 WS
      windowManager.setRpcEventSink(moduleSink!, resolveClientId)
      const { setMenuEventSink } = await import('./menu')
      setMenuEventSink(moduleSink!, resolveClientId)
      const { setNotificationEventSink } = await import('./notifications')
      setNotificationEventSink(moduleSink!, resolveClientId)

      // Headless：打印连接信息
      if (isHeadless) {
        console.log(`CRAFT_SERVER_URL=${instance.protocol}://${instance.host}:${instance.port}`)
        console.log(`CRAFT_SERVER_TOKEN=${instance.token}`)
      }
    }

    // 创建初始窗口（从保存状态恢复，或为第一个 workspace 打开窗口）
    // headless 模式下服务器不带 UI，跳过窗口创建。
    if (!isHeadless) {
      await createInitialWindows()
    }

    // 启动时执行凭证健康检查，尽早发现问题
    //（损坏、机器迁移、默认连接缺失凭证等）
    // 瘦客户端模式下跳过——凭证由远程服务器管理。
    if (!isClientOnly) {
      try {
        const { getCredentialManager } = await import('@craft-agent/shared/credentials')
        const credentialManager = getCredentialManager()
        const health = await credentialManager.checkHealth()
        if (!health.healthy) {
          mainLog.warn('Credential health check failed:', health.issues)
          // 用户进入设置 → AI 时会显示这些问题
        }
      } catch (err) {
        mainLog.error('Credential health check error:', err)
      }
    }

    // 初始化电源管理器（加载设置，必须在配置可用后）
    // 非关键——headless/xvfb 环境下 powerSaveBlocker 可能不可用
    try {
      const { initPowerManager } = await import('./power-manager')
      await initPowerManager()
    } catch (err) {
      mainLog.warn('[power] Power manager init failed (non-critical):', err instanceof Error ? err.message : err)
    }

    // 设置 Sentry 上下文标签用于错误分组（无 PII，仅配置分类）。
    // 在初始化后运行，确保配置和认证状态已可用。
    // 从默认 LLM 连接推导值，而不是 legacy config 字段。
    try {
      const { getLlmConnection, getDefaultLlmConnection } = await import('@craft-agent/shared/config')
      const workspaces = getWorkspaces()
      const defaultConnSlug = getDefaultLlmConnection()
      const defaultConn = defaultConnSlug ? getLlmConnection(defaultConnSlug) : null
      Sentry.setTag('authType', defaultConn?.authType ?? 'unknown')
      Sentry.setTag('providerType', defaultConn?.providerType ?? 'unknown')
      Sentry.setTag('hasCustomEndpoint', String(!!defaultConn?.baseUrl))
      Sentry.setTag('model', defaultConn?.defaultModel ?? 'default')
      Sentry.setTag('workspaceCount', String(workspaces.length))
    } catch (err) {
      mainLog.warn('Failed to set Sentry context tags:', err)
    }

    // 初始化自动更新（启动后立即检查）
    // 开发模式跳过，避免替换 /Applications 里的应用并意外启动它
    if (moduleSink) setAutoUpdateEventSink(moduleSink)
    // 在 quitAndInstall 之前抓拍多窗口状态。
    // electron-updater（Squirrel.Mac）会在 quitAndInstall 和 before-quit 之间
    // 销毁 BrowserWindow；如果只在 before-quit 保存，window-state.json 会被覆盖成空数组。
    setBeforeUpdateQuitHook(() => captureAndSaveWindowState('pre-update'))
    if (app.isPackaged) {
      checkForUpdatesOnLaunch().catch(err => {
        mainLog.error('[auto-update] Launch check failed:', err)
      })
    } else {
      mainLog.info('[auto-update] Skipping auto-update in dev mode')
    }

    // 处理冷启动时挂起的深链
    if (pendingDeepLink) {
      mainLog.info('Processing pending deep link:', pendingDeepLink)
      await handleDeepLink(pendingDeepLink, windowManager, moduleSink ?? undefined, moduleClientResolver ?? undefined)
      pendingDeepLink = null
    }

    mainLog.info('App initialized successfully')
    if (isDebugMode) {
      mainLog.info('Debug mode enabled - logs at:', getLogFilePath())
    }
    mainLog.info('Messaging gateway log path:', getMessagingGatewayLogFilePath())
  } catch (error) {
    mainLog.error('Failed to initialize app:', error instanceof Error ? error.message : error, (error as any)?.stack)
    // 即使初始化失败也继续，应用会在 UI 里显示错误
  }

  // macOS：点击 Dock 图标时重新创建窗口
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && windowManager) {
      // 打开第一个 workspace 或上次聚焦的 workspace
      const workspaces = getWorkspaces()
      if (workspaces.length > 0) {
        const savedState = loadWindowState()
        const wsId = savedState?.lastFocusedWorkspaceId || workspaces[0].id
        // 校验 workspace 仍存在
        if (workspaces.some(ws => ws.id === wsId)) {
          windowManager.createWindow({ workspaceId: wsId })
        } else {
          windowManager.createWindow({ workspaceId: workspaces[0].id })
        }
      }
    }
  })
})

app.on('window-all-closed', () => {
  if (process.env.CRAFT_HEADLESS) return  // headless 服务器保持运行
  // macOS 上应用通常保持活跃直到显式退出
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// 标记是否正在退出流程中，防止重入
let isQuitting = false

/**
 * 抓拍当前多窗口状态并持久化到磁盘。
 * 两处调用：
 *   - before-quit（正常退出路径，reason='before-quit'）
 *   - installUpdate 钩子（自动更新路径，reason='pre-update'），因为
 *     electron-updater 在 quitAndInstall 和 before-quit 之间销毁 BrowserWindow；
 *     到 before-quit 时 getWindowStates() 已返回空数组，会覆盖掉磁盘上的真实状态。
 * 返回保存的窗口数；windowManager 没准备好时返回 -1。
 */
function captureAndSaveWindowState(reason: 'before-quit' | 'pre-update'): number {
  if (!windowManager) return -1
  const windows = windowManager.getWindowStates()
  const focusedWindow = BrowserWindow.getFocusedWindow()
  const lastFocusedWorkspaceId = focusedWindow
    ? windowManager.getWorkspaceForWindow(focusedWindow.webContents.id) ?? undefined
    : undefined
  saveWindowState({ windows, lastFocusedWorkspaceId })
  mainLog.info('[window-state] saved', { windowCount: windows.length, reason })
  return windows.length
}

// 退出前保存窗口状态并清理资源
app.on('before-quit', async (event) => {
  // 调用 app.exit() 时避免重入
  if (isQuitting) return
  isQuitting = true

  // 确保 Cmd+Q/应用退出绕过分层窗口关闭拦截（区别于 Cmd+W 行为）
  windowManager?.setAppQuitting(true)

  if (windowManager) {
    const windows = windowManager.getWindowStates()
    // 空快照保护：更新退出时，electron-updater 在 before-quit 触发前已销毁所有 BrowserWindow。
    // pre-update 钩子已经保存了真实状态，不要让这次迟到的保存覆盖它。
    if (windows.length === 0 && isUpdating()) {
      mainLog.warn('[window-state] skip save: empty snapshot during update-quit (pre-update snapshot wins)')
    } else {
      captureAndSaveWindowState('before-quit')
    }
    // 与 installUpdate 的 [update-flow] 日志做诊断关联。
    // 更新退出时把这条记录到始终开启的 auto-update 专用日志（#891），
    // 这样生产环境也能诊断安装/退出交接；正常退出仍留在仅调试的 main log。
    const isUpdateQuit = isUpdating()
    const beforeQuitSave = {
      windowCount: windows.length,
      electronWindowCount: BrowserWindow.getAllWindows().length,
      isUpdating: isUpdateQuit,
      reason: isUpdateQuit ? 'update-quit' : 'user-quit',
    }
    if (isUpdateQuit) {
      autoUpdateLog.info('before-quit save', beforeQuitSave)
    } else {
      mainLog.info('[update-flow] before-quit save', beforeQuitSave)
    }
  }

  // 退出前 flush 所有待写入的 session
  if (sessionManager) {
    // 先阻止退出，等 session 落盘
    event.preventDefault()
    try {
      await sessionManager.flushAllSessions()
      mainLog.info('Flushed all pending session writes')
    } catch (error) {
      mainLog.error('Failed to flush sessions:', error)
    }
    // 清理 SessionManager 资源（文件监听、定时器等）
    sessionManager.cleanup()

    // 清理浏览器面板实例
    if (browserPaneManager) {
      browserPaneManager.destroyAll()
    }

    // 清理 OAuth flow store（停止定期清理定时器）
    if (oauthFlowStore) {
      oauthFlowStore.dispose()
    }

    // 停止所有模型刷新定时器
    getModelRefreshService().stopAll()

    // 停止 messaging gateway，让 WhatsApp worker 子进程干净退出
    if (messagingHandle) {
      try {
        await messagingHandle.dispose()
      } catch (err) {
        mainLog.error('[messaging] dispose failed:', err)
      }
    }

    // 清理电源管理器（释放电源阻止器）
    const { cleanup: cleanupPowerManager } = await import('./power-manager')
    cleanupPowerManager()

    // 释放服务器锁文件，避免下次启动看到陈旧 PID。
    // 无论正常退出还是更新退出都要执行。
    releaseServerLock()

    // 如果正在更新，让 electron-updater 处理退出流程
    // 强制退出会破坏 Windows 上的 NSIS 安装器
    if (isUpdating()) {
      mainLog.info('Update in progress, letting electron-updater handle quit')
      app.quit()
      return
    }

    // 现在真正退出
    app.exit(0)
  }
})

// 捕获未处理异常——显式转发到 Sentry，因为注册自定义处理器可能
// 干扰 @sentry/electron 的自动捕获。
process.on('uncaughtException', (error) => {
  mainLog.error('Uncaught exception:', error)
  Sentry.captureException(error)
})

process.on('unhandledRejection', (reason, promise) => {
  mainLog.error('Unhandled rejection at:', promise, 'reason:', reason)
  Sentry.captureException(reason instanceof Error ? reason : new Error(String(reason)))
})
