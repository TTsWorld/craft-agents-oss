/**
 * notifications.ts —— 通知服务。
 *
 * 负责：
 * - 应用未聚焦时显示原生系统通知
 * - 更新 Dock / 任务栏角标数量
 * - 点击通知后聚焦窗口并导航到对应会话
 */

import { Notification, app, BrowserWindow, nativeImage } from 'electron'
import { join } from 'path'
import { readFileSync } from 'fs'
import { mainLog } from './logger'
import { RPC_CHANNELS } from '../shared/types'
import type { WindowManager } from './window-manager'
import type { EventSink } from '@craft-agent/server-core/transport'

type ClientResolver = (webContentsId: number) => string | undefined

let windowManager: WindowManager | null = null
let eventSink: EventSink | null = null
let clientResolver: ClientResolver | null = null
let baseIconPath: string | null = null
let baseIconDataUrl: string | null = null
let currentBadgeCount: number = 0
let instanceNumber: number | null = null  // 多实例开发：Dock 角标上显示的实例编号

/**
 * 初始化通知服务，传入 WindowManager 引用
 */
export function initNotificationService(wm: WindowManager): void {
  windowManager = wm
}

/**
 * 设置通知广播用的事件 sink（server 创建后调用）。
 *
 * 提供 resolver 时，可以把会话导航事件定向到单个 client，
 * 而不是广播到整个 workspace 的所有窗口。
 */
export function setNotificationEventSink(sink: EventSink, resolver?: ClientResolver): void {
  eventSink = sink
  clientResolver = resolver ?? null
}

/**
 * 显示一条原生通知（用于新消息到达）。
 *
 * @param title   - 通知标题（如会话名）
 * @param body    - 通知正文（如消息预览）
 * @param workspaceId - 用于点击后导航的工作区 ID
 * @param sessionId   - 用于点击后导航的会话 ID
 */
export function showNotification(
  title: string,
  body: string,
  workspaceId: string,
  sessionId: string
): void {
  if (!Notification.isSupported()) {
    mainLog.info('Notifications not supported on this platform')
    return
  }

  const notification = new Notification({
    title,
    body,
    // macOS 专用选项
    silent: false,
    // 使用应用图标
    icon: undefined,  // macOS 默认会使用应用图标
  })

  notification.on('click', () => {
    mainLog.info('Notification clicked:', { workspaceId, sessionId })
    handleNotificationClick(workspaceId, sessionId)
  })

  notification.show()
  mainLog.info('Notification shown:', { title, sessionId })
}

/**
 * 处理通知点击：聚焦窗口并导航到对应会话
 */
function handleNotificationClick(workspaceId: string, sessionId: string): void {
  if (!windowManager) {
    mainLog.error('WindowManager not initialized for notification click')
    return
  }

  // 查找或创建该 workspace 的窗口
  let window = windowManager.getWindowByWorkspace(workspaceId)

  if (!window) {
    // 为该 workspace 创建新窗口
    windowManager.createWindow({ workspaceId })
    window = windowManager.getWindowByWorkspace(workspaceId)
  }

  if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
    // 聚焦窗口
    if (window.isMinimized()) {
      window.restore()
    }
    window.focus()

    // 发送导航事件给渲染进程以打开对应 session。
    // 优先单 client 目标，避免跨窗口导航的副作用。
    if (eventSink) {
      const clientId = clientResolver?.(window.webContents.id)
      if (clientId) {
        eventSink(RPC_CHANNELS.notification.NAVIGATE, { to: 'client', clientId }, {
          workspaceId,
          sessionId,
        })
      } else {
        eventSink(RPC_CHANNELS.notification.NAVIGATE, { to: 'workspace', workspaceId }, {
          workspaceId,
          sessionId,
        })
      }
    }
  }
}

/**
 * 初始化角标叠加用的基础图标，app 启动时调用
 */
export function initBadgeIcon(iconPath: string): void {
  try {
    baseIconPath = iconPath
    // 读取图标并缓存为 base64 data URL
    const iconBuffer = readFileSync(iconPath)
    baseIconDataUrl = `data:image/png;base64,${iconBuffer.toString('base64')}`
    mainLog.info('Badge icon initialized:', iconPath)
  } catch (error) {
    mainLog.error('Failed to initialize badge icon:', error)
  }
}

/**
 * 更新应用角标数量（跨平台）。
 *
 * - macOS：用 Canvas 在 Dock 图标上绘制角标。
 * - Windows：用任务栏覆盖图标显示角标。
 * - Linux：用 app.setBadgeCount()（Unity/KDE 支持）。
 *
 * @param count - 角标数字，0 表示清除
 */
export function updateBadgeCount(count: number): void {
  // 数字没变就跳过
  if (count === currentBadgeCount) {
    return
  }

  currentBadgeCount = count

  if (process.platform === 'darwin') {
    updateBadgeCountMacOS(count)
  } else if (process.platform === 'win32') {
    updateBadgeCountWindows(count)
  } else if (process.platform === 'linux') {
    updateBadgeCountLinux(count)
  }
}

/**
 * macOS：用 Dock 图标叠加绘制角标
 */
function updateBadgeCountMacOS(count: number): void {
  try {
    if (count > 0) {
      // 通过渲染进程（Canvas API）在图标上绘制角标
      if (eventSink && baseIconDataUrl) {
        eventSink(RPC_CHANNELS.badge.DRAW, { to: 'all' }, { count, iconDataUrl: baseIconDataUrl })
      }
    } else {
      // 重置为原始图标（无角标）
      if (baseIconPath) {
        const originalIcon = nativeImage.createFromPath(baseIconPath)
        app.dock?.setIcon(originalIcon)
      }
    }
    mainLog.info('Badge count updated (macOS):', count)
  } catch (error) {
    mainLog.error('Failed to update badge count (macOS):', error)
  }
}

/**
 * Windows：用任务栏覆盖图标显示角标
 */
function updateBadgeCountWindows(count: number): void {
  try {
    if (count > 0) {
      // 通过渲染进程（Canvas API）绘制任务栏覆盖图标
      if (eventSink) {
        eventSink(RPC_CHANNELS.badge.DRAW_WINDOWS, { to: 'all' }, { count })
      }
    } else {
      // 清除所有窗口的覆盖图标
      const windows = BrowserWindow.getAllWindows()
      for (const window of windows) {
        if (!window.isDestroyed()) {
          window.setOverlayIcon(null, '')
        }
      }
    }
    mainLog.info('Badge count updated (Windows):', count)
  } catch (error) {
    mainLog.error('Failed to update badge count (Windows):', error)
  }
}

/**
 * Linux：使用 app.setBadgeCount（Unity/KDE）
 */
function updateBadgeCountLinux(count: number): void {
  try {
    // Electron 的 setBadgeCount 在 Linux 上支持 Unity launcher 和 KDE
    app.setBadgeCount(count)
    mainLog.info('Badge count updated (Linux):', count)
  } catch (error) {
    mainLog.error('Failed to update badge count (Linux):', error)
  }
}

/**
 * 用渲染进程绘制好的带角标图标更新 Dock / 任务栏图标（跨平台）
 */
export function setDockIconWithBadge(dataUrl: string): void {
  try {
    const icon = nativeImage.createFromDataURL(dataUrl)

    if (process.platform === 'darwin') {
      app.dock?.setIcon(icon)
      mainLog.info('Dock icon updated with badge (macOS)')
    } else if (process.platform === 'win32') {
      // Windows：设置任务栏覆盖图标
      const windows = BrowserWindow.getAllWindows()
      const window = windows[0]
      if (window && !window.isDestroyed()) {
        window.setOverlayIcon(icon, `${currentBadgeCount} notifications`)
        mainLog.info('Taskbar overlay updated with badge (Windows)')
      }
    }
  } catch (error) {
    mainLog.error('Failed to set dock/taskbar icon with badge:', error)
  }
}

/**
 * 清除应用角标
 */
export function clearBadgeCount(): void {
  updateBadgeCount(0)
}

/**
 * 检查当前是否有窗口处于聚焦状态
 */
export function isAnyWindowFocused(): boolean {
  const focusedWindow = BrowserWindow.getFocusedWindow()
  return focusedWindow !== null && !focusedWindow.isDestroyed()
}

/**
 * 多实例开发时初始化实例角标。
 *
 * 当从编号目录运行（如 craft-tui-agent-1）时，在 Dock 图标上显示永久角标以区分实例。
 *
 * @param number - 实例编号（1、2…），null 表示默认实例
 */
export function initInstanceBadge(number: number): void {
  if (process.platform !== 'darwin') {
    // 实例角标目前仅支持 macOS
    return
  }

  instanceNumber = number

  try {
    // 用 dock.setBadge() 设置简单文本角标
    // 会在 Dock 图标上以红色角标显示数字
    app.dock?.setBadge(String(number))
    mainLog.info(`Instance badge set: ${number}`)
  } catch (error) {
    mainLog.error('Failed to set instance badge:', error)
  }
}
