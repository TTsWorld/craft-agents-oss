/**
 * auto-update.ts —— 自动更新模块（基于 electron-updater）。
 *
 * 负责检查、下载、安装 Electron 应用更新。更新包从 https://agents.craft.do/electron/latest
 * 分发，使用 generic provider（YAML 清单 + 放在 R2/S3 上的二进制）。
 *
 * 各平台行为：
 * - macOS：下载 zip，解压后原子替换 app bundle
 * - Windows：下载 NSIS 安装包，退出时静默运行
 * - Linux：下载 AppImage，替换当前文件
 *
 * 所有平台都支持 download-progress 进度事件（electron-updater v6.8.0+）。
 * quitAndInstall() 会原生处理重启，不需要外部脚本。
 */

import { autoUpdater } from 'electron-updater'
import { app, BrowserWindow } from 'electron'
import { platform } from 'os'
import * as path from 'path'
import * as fs from 'fs'
import { mainLog, autoUpdateLog } from './logger'
import { getAppVersion } from '@craft-agent/shared/version'
import {
  getDismissedUpdateVersion,
  clearDismissedUpdateVersion,
} from '@craft-agent/shared/config'
import { readJsonFileSync } from '@craft-agent/shared/utils/files'
import { RPC_CHANNELS, type UpdateInfo } from '../shared/types'
import type { EventSink } from '@craft-agent/server-core/transport'

// 平台检测（类似 Go 的 runtime.GOOS）
const PLATFORM = platform()
const IS_MAC = PLATFORM === 'darwin'
const IS_WINDOWS = PLATFORM === 'win32'

// 获取 electron-updater 的更新缓存目录（macOS 文件监听兜底用）
// electron-updater 默认路径：
// - Windows: %LOCALAPPDATA%/{appName}-updater/pending
// - macOS: ~/Library/Caches/{appName}-updater/pending
// - Linux: ~/.cache/{appName}-updater/pending
function getUpdateCacheDir(): string {
  const appName = app.getName()
  if (IS_MAC) {
    return path.join(app.getPath('home'), 'Library', 'Caches', `${appName}-updater`, 'pending')
  } else if (IS_WINDOWS) {
    // Windows 用 LOCALAPPDATA，不是 APPDATA（后者是漫游配置）
    const localAppData = process.env.LOCALAPPDATA || path.join(app.getPath('home'), 'AppData', 'Local')
    return path.join(localAppData, `${appName}-updater`, 'pending')
  } else {
    // Linux
    return path.join(app.getPath('home'), '.cache', `${appName}-updater`, 'pending')
  }
}

// 模块级状态：保存当前更新信息，供 IPC handler 查询
let updateInfo: UpdateInfo = {
  available: false,
  currentVersion: getAppVersion(),
  latestVersion: null,
  downloadState: 'idle',
  downloadProgress: 0,
}

let eventSink: EventSink | null = null

// 更新进行中的标记，用于在 quitAndInstall 期间避免强制退出打断更新流程
let __isUpdating = false

// 在 quitAndInstall 之前执行的钩子，此时 BrowserWindow 还存在。
// electron-updater 会在 quitAndInstall 和 before-quit 之间销毁窗口，
// 所以常规的 before-quit 保存逻辑会拿到空窗口列表。
let beforeUpdateQuitHook: (() => void) | null = null

/**
 * 注册一个回调，installUpdate() 在调用 quitAndInstall() 之前执行它。
 * index.ts 用它在大批窗口仍存活时抓拍多窗口状态。
 */
export function setBeforeUpdateQuitHook(fn: () => void): void {
  beforeUpdateQuitHook = fn
}

/**
 * 检查是否正在安装更新。
 * 主进程用它避免在更新期间强制退出。
 */
export function isUpdating(): boolean {
  return __isUpdating
}

/**
 * 设置事件 sink，用于向所有渲染进程窗口广播更新事件。
 * EventSink 是 server-core 的推送抽象，类似发布订阅里的 publish 函数。
 */
export function setAutoUpdateEventSink(sink: EventSink): void {
  eventSink = sink
}

/**
 * 获取当前更新信息（IPC handler 调用）。
 */
export function getUpdateInfo(): UpdateInfo {
  return { ...updateInfo }
}

/**
 * 向所有渲染进程窗口广播更新信息。
 * 先拍一份快照再发送，避免广播过程中状态被并发修改。
 */
function broadcastUpdateInfo(): void {
  if (!eventSink) return

  const snapshot = { ...updateInfo }
  eventSink(RPC_CHANNELS.update.AVAILABLE, { to: 'all' }, snapshot)
}

/**
 * 向所有渲染进程窗口广播下载进度（0-100）。
 */
function broadcastDownloadProgress(progress: number): void {
  if (!eventSink) return

  eventSink(RPC_CHANNELS.update.DOWNLOAD_PROGRESS, { to: 'all' }, progress)
}

// ─── 配置 electron-updater ───────────────────────────────────────────────────

// 检测到更新后自动在后台下载
autoUpdater.autoDownload = true

// 应用退出时自动安装（已下载但用户还没点「重启」的情况）
autoUpdater.autoInstallOnAppQuit = true

// 把 electron-updater 内部日志桥接到我们的主日志
autoUpdater.logger = {
  info: (msg: unknown) => mainLog.info('[electron-updater]', msg),
  warn: (msg: unknown) => mainLog.warn('[electron-updater]', msg),
  error: (msg: unknown) => mainLog.error('[electron-updater]', msg),
  debug: (msg: unknown) => mainLog.info('[electron-updater:debug]', msg),
}

// ─── 事件处理器 ───────────────────────────────────────────────────────────────

autoUpdater.on('checking-for-update', () => {
  mainLog.info('[auto-update] Checking for updates...')
})

autoUpdater.on('update-available', (info) => {
  autoUpdateLog.info(`Update available: ${updateInfo.currentVersion} → ${info.version}`)

  // 先检查 electron-updater 内部状态（最可靠）
  const internalState = checkElectronUpdaterState()
  if (internalState.ready) {
    mainLog.info(`[auto-update] electron-updater reports download ready`)
    updateInfo = {
      ...updateInfo,
      available: true,
      latestVersion: info.version,
      downloadState: 'ready',
      downloadProgress: 100,
    }
    broadcastUpdateInfo()
    return
  }

  // 兜底：检查缓存目录里是否已经有下载好的文件
  const existing = checkForExistingDownload()
  if (existing.exists) {
    mainLog.info(`[auto-update] Update already downloaded (file check), setting state to ready`)
    updateInfo = {
      ...updateInfo,
      available: true,
      latestVersion: info.version,
      downloadState: 'ready',
      downloadProgress: 100,
    }
    broadcastUpdateInfo()
    return
  }

  updateInfo = {
    ...updateInfo,
    available: true,
    latestVersion: info.version,
    downloadState: 'downloading',
    downloadProgress: 0,
  }
  broadcastUpdateInfo()
})

autoUpdater.on('update-not-available', (info) => {
  mainLog.info(`[auto-update] Already up to date (${info.version})`)

  // 已经是最新版，重置状态
  updateInfo = {
    ...updateInfo,
    available: false,
    latestVersion: info.version,
    downloadState: 'idle',
  }
  broadcastUpdateInfo()
})

autoUpdater.on('download-progress', (progress) => {
  const percent = Math.round(progress.percent)
  updateInfo = { ...updateInfo, downloadProgress: percent }
  broadcastDownloadProgress(percent)
})

autoUpdater.on('update-downloaded', async (info) => {
  autoUpdateLog.info(`Update downloaded: v${info.version}`)

  // 下载完成，状态置为 ready，并重建菜单以显示「安装更新…」选项
  updateInfo = {
    ...updateInfo,
    available: true,
    latestVersion: info.version,
    downloadState: 'ready',
    downloadProgress: 100,
  }
  broadcastUpdateInfo()

  // 重建菜单，显示「安装更新…」选项
  const { rebuildMenu } = await import('./menu')
  rebuildMenu()
})

autoUpdater.on('error', (error) => {
  autoUpdateLog.error('electron-updater error', error)

  // 下载出错，记录错误信息并广播
  updateInfo = {
    ...updateInfo,
    downloadState: 'error',
    error: error.message,
  }
  broadcastUpdateInfo()
})

// ─── 导出 API ─────────────────────────────────────────────────────────────────

/**
 * 检查 electron-updater 内部是否已有验证过的下载包。
 * 比文件检查更可靠，因为它直接读内部 helper 状态。
 */
function checkElectronUpdaterState(): { ready: boolean; version?: string } {
  try {
    // 访问 electron-updater 内部 downloadedUpdateHelper（非公开 API）
    // @ts-expect-error - 为了可靠性主动访问内部 API
    const helper = autoUpdater.downloadedUpdateHelper
    if (helper) {
      mainLog.info(`[auto-update] downloadedUpdateHelper exists, cacheDir: ${helper.cacheDir}`)
      // @ts-expect-error - 访问内部 API
      const versionInfo = helper.versionInfo
      if (versionInfo) {
        mainLog.info(`[auto-update] electron-updater has validated download: ${JSON.stringify(versionInfo)}`)
        return { ready: true, version: versionInfo.version }
      }
    }
  } catch (error) {
    mainLog.warn('[auto-update] Error checking electron-updater state:', error)
  }
  return { ready: false }
}

/**
 * checkForUpdates 的选项。
 */
interface CheckOptions {
  /** true 表示发现更新时自动下载（默认 true） */
  autoDownload?: boolean
}

/**
 * 检查缓存目录里是否已经有之前会话下载好的更新包。
 */
function checkForExistingDownload(): { exists: boolean; version?: string } {
  try {
    const cacheDir = getUpdateCacheDir()
    mainLog.info(`[auto-update] Checking cache directory: ${cacheDir}`)

    if (!fs.existsSync(cacheDir)) {
      mainLog.info(`[auto-update] Cache directory does not exist`)
      return { exists: false }
    }

    const files = fs.readdirSync(cacheDir)
    mainLog.info(`[auto-update] Files in cache: ${JSON.stringify(files)}`)

    // 查找 electron-updater 创建的 update-info.json
    const updateInfoFile = files.find(f => f === 'update-info.json')
    if (updateInfoFile) {
      const infoPath = path.join(cacheDir, updateInfoFile)
      const info = readJsonFileSync(infoPath) as Record<string, unknown> | null
      mainLog.info(`[auto-update] update-info.json contents: ${JSON.stringify(info)}`)

      // electron-updater 在 update-info.json 里用 'fileName'（不是 'path'）
      const fileName = (info?.fileName || info?.path) as string | undefined
      if (fileName && fs.existsSync(path.join(cacheDir, fileName))) {
        mainLog.info(`[auto-update] Found existing download via update-info.json: ${fileName}`)
        return { exists: true, version: info?.version as string }
      }
    }

    // 兜底：只要找到常见安装包格式就认为已下载
    const downloadFile = files.find(f =>
      f.endsWith('.zip') ||
      f.endsWith('.exe') ||
      f.endsWith('.AppImage') ||
      f.endsWith('.dmg') ||
      f.endsWith('.nupkg')
    )
    if (downloadFile) {
      mainLog.info(`[auto-update] Found existing download file: ${downloadFile}`)
      return { exists: true }
    }

    mainLog.info(`[auto-update] No existing download found in cache`)
    return { exists: false }
  } catch (error) {
    mainLog.warn('[auto-update] Error checking for existing download:', error)
    return { exists: false }
  }
}

/**
 * 检查是否有可用更新。
 * 返回检查完成后的 UpdateInfo 状态。
 *
 * @param options.autoDownload - false 表示只检查不下载（用于设置页「立即检查」）
 */
export async function checkForUpdates(options: CheckOptions = {}): Promise<UpdateInfo> {
  const { autoDownload = true } = options

  // 临时覆盖 autoDownload，本次检查结束后再恢复
  // 例如：设置页手动检查时，不应在按流量计费的网络下自动下载
  const previousAutoDownload = autoUpdater.autoDownload
  autoUpdater.autoDownload = autoDownload

  try {
    // checkForUpdates 返回检查结果 Promise
    const result = await autoUpdater.checkForUpdates()

    // 如果有更新且已经下载过，update-downloaded 事件应该会触发。
    // 等待一小段时间让事件落稳再返回。
    if (result?.updateInfo) {
      // 给 electron-updater 一点时间触发 update-downloaded（如果文件已存在）
      await new Promise(resolve => setTimeout(resolve, 500))

      // 二次确认：如果状态还是 downloading 但文件已存在，则改成 ready
      if (updateInfo.downloadState === 'downloading') {
        const existing = checkForExistingDownload()
        if (existing.exists) {
          mainLog.info('[auto-update] Update already downloaded, updating state to ready')
          updateInfo = {
            ...updateInfo,
            downloadState: 'ready',
            downloadProgress: 100,
          }
          broadcastUpdateInfo()
        }
      }
    }
  } catch (error) {
    autoUpdateLog.error('Update check failed', error)
    updateInfo = {
      ...updateInfo,
      downloadState: 'error',
      error: error instanceof Error ? error.message : 'Check failed',
    }
  } finally {
    // 恢复之前的 autoDownload 设置
    autoUpdater.autoDownload = previousAutoDownload
  }

  return getUpdateInfo()
}

/**
 * 安装已下载的更新并重启应用。
 * 调用 electron-updater 的 quitAndInstall，它会处理：
 * - macOS：解压 zip 并替换 app bundle
 * - Windows：静默运行 NSIS 安装包
 * - Linux：替换 AppImage 文件
 * 然后自动重新启动应用。
 */
export async function installUpdate(): Promise<void> {
  if (updateInfo.downloadState !== 'ready') {
    throw new Error('No update ready to install')
  }

  autoUpdateLog.info('Installing update and restarting...')

  updateInfo = { ...updateInfo, downloadState: 'installing' }
  broadcastUpdateInfo()

  // 用户明确更新，清除之前「忽略此版本」的标记
  clearDismissedUpdateVersion()

  // 设置标记，防止强制退出打断 electron-updater 的关闭流程
  __isUpdating = true

  // 与 before-quit 的 [update-flow] 日志做诊断关联。如果这里的窗口数
  // 和 before-quit 时不同，说明 electron-updater 在这之间销毁了窗口——
  // 这正是多窗口恢复问题的根因。
  autoUpdateLog.info('installUpdate pre-quit', {
    electronWindowCount: BrowserWindow.getAllWindows().length,
    downloadState: updateInfo.downloadState,
    latestVersion: updateInfo.latestVersion,
  })

  // 在 quitAndInstall 之前抓拍窗口状态——electron-updater 会在这个调用
  // 和 before-quit 之间销毁 BrowserWindow，导致常规的 before-quit 保存
  // 把 window-state.json 覆盖成空数组。
  try {
    beforeUpdateQuitHook?.()
  } catch (err) {
    autoUpdateLog.error('beforeUpdateQuit hook failed', err)
  }

  try {
    // isSilent=false：Windows 需要时显示安装器 UI（兜底）
    // isForceRunAfter=true：确保安装完成后重新启动应用
    autoUpdater.quitAndInstall(false, true)
  } catch (error) {
    __isUpdating = false
    autoUpdateLog.error('quitAndInstall failed', error)
    updateInfo = { ...updateInfo, downloadState: 'error' }
    broadcastUpdateInfo()
    throw error
  }
}

/**
 * 启动时更新检查的结果。
 */
export interface UpdateOnLaunchResult {
  action: 'none' | 'skipped' | 'ready' | 'downloading'
  reason?: string
  version?: string | null
}

/**
 * 应用启动时检查更新。
 * - 立即检查，不延迟
 * - 尊重用户「忽略此版本」的选择（跳过通知，但允许手动检查）
 * - 有更新时自动下载
 */
export async function checkForUpdatesOnLaunch(): Promise<UpdateOnLaunchResult> {
  autoUpdateLog.info('Checking for updates on launch...')

  const info = await checkForUpdates({ autoDownload: true })

  if (!info.available) {
    return { action: 'none' }
  }

  // 检查用户是否忽略了该版本
  const dismissedVersion = getDismissedUpdateVersion()
  if (dismissedVersion === info.latestVersion) {
    mainLog.info(`[auto-update] Update ${info.latestVersion} was dismissed, skipping notification`)
    return { action: 'skipped', reason: 'dismissed', version: info.latestVersion }
  }

  if (info.downloadState === 'ready') {
    return { action: 'ready', version: info.latestVersion }
  }

  // 正在下载中，等下载完成后的 update-downloaded 事件再通知
  return { action: 'downloading', version: info.latestVersion }
}
