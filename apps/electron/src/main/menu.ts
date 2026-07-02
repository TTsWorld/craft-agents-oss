/**
 * menu.ts —— Electron 原生应用菜单（macOS）。
 *
 * 构建并设置 Craft Agents 的顶部菜单栏。Windows/Linux 使用应用内自定义菜单，
 * 这里只负责 macOS 原生菜单。菜单点击通过 RPC event sink 通知渲染进程执行动作。
 */
import { Menu, app, shell, BrowserWindow } from 'electron'
import { i18n } from '@craft-agent/shared/i18n'
import { RPC_CHANNELS, type BroadcastEventMap } from '../shared/types'
import { EDIT_MENU, VIEW_MENU, WINDOW_MENU } from '../shared/menu-schema'
import type { MenuItem } from '../shared/menu-schema'
import type { WindowManager } from './window-manager'
import type { EventSink } from '@craft-agent/server-core/transport'
import { mainLog, isDebugMode } from './logger'

type ClientResolver = (webContentsId: number) => string | undefined

// 缓存引用，方便更新菜单时重建
let cachedWindowManager: WindowManager | null = null
let cachedEventSink: EventSink | null = null
let cachedClientResolver: ClientResolver | null = null

/**
 * 创建并设置 macOS 应用菜单。
 *
 * 更新状态变化时调用 rebuildMenu() 刷新菜单项。
 */
export function createApplicationMenu(windowManager: WindowManager, sink?: EventSink, resolver?: ClientResolver): void {
  cachedWindowManager = windowManager
  cachedEventSink = sink ?? null
  cachedClientResolver = resolver ?? null
  rebuildMenu()
}

/**
 * server 创建后设置事件 sink 和 client 解析器。
 * 与 createApplicationMenu 分开调用，因为菜单初始化时 server 可能还不存在。
 */
export function setMenuEventSink(sink: EventSink, resolver: ClientResolver): void {
  cachedEventSink = sink
  cachedClientResolver = resolver
}

/**
 * 用当前更新状态重建应用菜单。
 *
 * Windows/Linux：隐藏原生菜单，功能都在应用内 Craft logo 菜单里。
 * macOS：按 Apple 规范保留原生菜单。
 */
export async function rebuildMenu(): Promise<void> {
  if (!cachedWindowManager) return

  const windowManager = cachedWindowManager
  const isMac = process.platform === 'darwin'

  // Windows/Linux 完全隐藏原生菜单
  if (!isMac) {
    Menu.setApplicationMenu(null)
    return
  }

  // 获取当前更新状态
  const { getUpdateInfo, installUpdate, checkForUpdates } = await import('./auto-update')
  const updateInfo = getUpdateInfo()
  const updateReady = updateInfo.available && updateInfo.downloadState === 'ready'

  // 根据更新状态构建菜单项
  const updateMenuItem: Electron.MenuItemConstructorOptions = updateReady
    ? {
        label: i18n.t("menu.installUpdateVersion", { version: updateInfo.latestVersion }),
        click: async () => {
          await installUpdate()
        }
      }
    : {
        label: i18n.t("menu.checkForUpdatesEllipsis"),
        click: async () => {
          await checkForUpdates({ autoDownload: true })
        }
      }

  const template: Electron.MenuItemConstructorOptions[] = [
    // 应用菜单（仅 macOS）
    ...(isMac ? [{
      label: 'Craft Agents',
      submenu: [
        { role: 'about' as const, label: i18n.t('menu.aboutCraftAgents') },
        updateMenuItem,
        { type: 'separator' as const },
        {
          label: i18n.t("menu.settings"),
          accelerator: 'CmdOrCtrl+,',
          registerAccelerator: false,  // 快捷键由 Action registry 统一处理，这里不注册原生快捷键
          click: () => sendToRenderer(RPC_CHANNELS.menu.OPEN_SETTINGS)
        },
        { type: 'separator' as const },
        { role: 'hide' as const, label: i18n.t('menu.hideCraftAgents') },
        { role: 'hideOthers' as const },
        { role: 'unhide' as const },
        { type: 'separator' as const },
        { role: 'quit' as const, label: i18n.t('menu.quitCraftAgents') }
      ]
    }] : []),

    // 文件菜单
    {
      label: i18n.t("menu.file"),
      submenu: [
        {
          label: i18n.t("menu.newChat"),
          accelerator: 'CmdOrCtrl+N',
          registerAccelerator: false,  // 键盘快捷键由 Action registry 处理
          click: () => sendToRenderer(RPC_CHANNELS.menu.NEW_CHAT)
        },
        {
          label: i18n.t("menu.newWindow"),
          accelerator: 'CmdOrCtrl+Shift+N',
          registerAccelerator: false,  // 键盘快捷键由 Action registry 处理
          click: () => {
            const focused = BrowserWindow.getFocusedWindow()
            if (focused) {
              const workspaceId = windowManager.getWorkspaceForWindow(focused.webContents.id)
              if (workspaceId) {
                windowManager.createWindow({ workspaceId })
              }
            }
          }
        },
        { type: 'separator' as const },
        isMac ? { role: 'close' as const } : { role: 'quit' as const }
      ]
    },

    // 编辑菜单（来自共享 schema）
    {
      label: i18n.t(EDIT_MENU.labelKey),
      submenu: EDIT_MENU.items.map(toElectronMenuItem),
    },

    // 视图菜单（来自共享 schema + 开发专用项）
    {
      label: i18n.t(VIEW_MENU.labelKey),
      submenu: [
        ...VIEW_MENU.items.map(toElectronMenuItem),
        // 开发者工具——开发模式或带 --debug 启动时可用
        ...(!app.isPackaged || isDebugMode ? [
          { type: 'separator' as const },
          ...(!app.isPackaged ? [
            {
              label: i18n.t("menu.reload"),
              accelerator: 'CmdOrCtrl+R',
              click: (_menuItem: Electron.MenuItem, window: Electron.BaseWindow | undefined) => {
                const browserWindow = window instanceof BrowserWindow ? window : BrowserWindow.getFocusedWindow()
                if (!browserWindow) return
                const views = browserWindow.getBrowserViews()
                if (views.length > 0) {
                  views[0].webContents.reload()
                } else {
                  browserWindow.webContents.reload()
                }
              }
            },
            {
              label: i18n.t("menu.forceReload"),
              accelerator: 'CmdOrCtrl+Shift+R',
              click: (_menuItem: Electron.MenuItem, window: Electron.BaseWindow | undefined) => {
                const browserWindow = window instanceof BrowserWindow ? window : BrowserWindow.getFocusedWindow()
                if (!browserWindow) return
                const views = browserWindow.getBrowserViews()
                if (views.length > 0) {
                  views[0].webContents.reloadIgnoringCache()
                } else {
                  browserWindow.webContents.reloadIgnoringCache()
                }
              }
            },
          ] : []),
          { role: 'toggleDevTools' as const },
        ] : [])
      ]
    },

    // 窗口菜单（来自共享 schema + macOS 专用项）
    {
      label: i18n.t(WINDOW_MENU.labelKey),
      submenu: [
        ...WINDOW_MENU.items.map(toElectronMenuItem),
        ...(isMac ? [
          { type: 'separator' as const },
          { role: 'front' as const }
        ] : [])
      ]
    },

    // 调试菜单（仅开发模式）
    ...(!app.isPackaged ? [{
      label: i18n.t("menu.debug"),
      submenu: [
        {
          label: i18n.t("menu.checkForUpdates"),
          click: async () => {
            const { checkForUpdates } = await import('./auto-update')
            const info = await checkForUpdates({ autoDownload: true })
            mainLog.info('[debug-menu] Update check result:', info)
          }
        },
        {
          label: i18n.t("menu.installUpdate"),
          click: async () => {
            const { installUpdate } = await import('./auto-update')
            try {
              await installUpdate()
            } catch (err) {
              mainLog.error('[debug-menu] Install failed:', err)
            }
          }
        },
        { type: 'separator' as const },
        {
          label: i18n.t("menu.resetToDefaults"),
          click: async () => {
            const { dialog } = await import('electron')
            await dialog.showMessageBox({
              type: 'info',
              message: i18n.t("menu.resetToDefaultsTitle"),
              detail: i18n.t("menu.resetToDefaultsDetail"),
              buttons: [i18n.t("common.ok")]
            })
          }
        }
      ]
    }] : []),

    // 帮助菜单
    {
      label: i18n.t("menu.help"),
      submenu: [
        {
          label: i18n.t("menu.helpAndDocs"),
          click: () => shell.openExternal('https://agents.craft.do/docs')
        },
        {
          label: i18n.t("menu.keyboardShortcuts"),
          accelerator: 'CmdOrCtrl+/',
          registerAccelerator: false,  // 键盘快捷键由 Action registry 处理
          click: () => sendToRenderer(RPC_CHANNELS.menu.KEYBOARD_SHORTCUTS)
        }
      ]
    }
  ]

  const menu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(menu)
}

/** 菜单里需要主进程向渲染进程推送的 channel 类型 */
type MenuBroadcastChannel = Extract<keyof BroadcastEventMap, `menu:${string}`>

/**
 * 通过 RPC event sink 向当前聚焦的渲染窗口发送事件。
 */
function sendToRenderer(channel: MenuBroadcastChannel): void {
  if (!cachedEventSink || !cachedClientResolver) return
  const win = BrowserWindow.getFocusedWindow()
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
    const clientId = cachedClientResolver(win.webContents.id)
    if (clientId) {
      cachedEventSink(channel, { to: 'client', clientId })
    }
  }
}

/**
 * 把共享菜单 schema 里的 MenuItem 转成 Electron 的 MenuItemConstructorOptions。
 */
function toElectronMenuItem(item: MenuItem): Electron.MenuItemConstructorOptions {
  if (item.type === 'separator') {
    return { type: 'separator' }
  }

  if (item.type === 'role') {
    // 使用 Electron 内置 role，自动处理快捷键
    return { role: item.role as Electron.MenuItemConstructorOptions['role'] }
  }

  if (item.type === 'action') {
    return {
      label: i18n.t(item.labelKey),
      accelerator: item.shortcut,
      registerAccelerator: false,  // 键盘快捷键由 Action registry 处理
      click: () => sendToRenderer(item.ipcChannel as MenuBroadcastChannel),
    }
  }

  // 不应走到这里
  return { type: 'separator' }
}
