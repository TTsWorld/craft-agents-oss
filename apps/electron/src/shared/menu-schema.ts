/**
 * Shared Menu Schema —— 共享菜单结构定义。
 *
 * 本文件同时被以下两者消费：
 * - Main 进程：转换为 Electron 原生的 MenuItemConstructorOptions
 * - Renderer 进程：转换为 React 下拉组件
 *
 * 标签、快捷键、图标、IPC 通道都在这里统一维护，避免两侧不一致。
 *
 * 注意：所有 labelKey 都是 i18n key（例如 "menu.edit"），不是已翻译的字符串。
 * 消费方需要在渲染/构建时调用 t(item.labelKey) 或 i18n.t(item.labelKey) 解析。
 * 这样可避免模块级 i18n.t() 调用带来的翻译过时问题。
 */

import { RPC_CHANNELS } from './types'
import { FEATURE_FLAGS } from '@craft-agent/shared/feature-flags'

// ─────────────────────────────────────────────────────────────────────────────
// 类型定义
// ─────────────────────────────────────────────────────────────────────────────

// 普通动作菜单项：点击后通过 ipcChannel 向 main 进程发送命令
export interface MenuItemAction {
  type: 'action'
  id: string
  // i18n key —— 渲染时通过 t() 解析成本地语言
  labelKey: string
  /**
   * 与动作注册表（action registry）关联，例如 'view.toggleSidebar'。
   * 未来可用于：从注册表推导显示快捷键、同步用户自定义快捷键覆盖。
   */
  actionId?: string
  // Electron accelerator 快捷键，例如 'CmdOrCtrl+B'
  shortcut: string
  // macOS 上显示的快捷键，例如 '⌘B'
  shortcutDisplayMac: string
  // Windows/Linux 上显示的快捷键，例如 'Ctrl+B'
  shortcutDisplayOther: string
  // 点击时发送的 IPC 通道名
  ipcChannel: string
  // Lucide 图标名称
  icon: string
}

// Electron 内置 role 菜单项，例如 undo/copy/paste
export interface MenuItemRole {
  type: 'role'
  // Electron 原生 role，例如 'undo'、'copy'
  role: string
  // i18n key —— 渲染时通过 t() 解析
  labelKey: string
  shortcutDisplayMac?: string
  shortcutDisplayOther?: string
  icon: string
  // renderer 可选调用的 IPC 通道
  ipcChannel?: string
}

// 分隔线
export interface MenuItemSeparator {
  type: 'separator'
}

/**
 * 外部链接菜单项，例如“帮助与文档”。
 *
 * Renderer 会把它渲染成 `window.electronAPI.openUrl(url)`。
 * Main 进程的 Electron 原生菜单构建器目前只消费 EDIT/VIEW/WINDOW，不会消费此项。
 */
export interface MenuItemUrl {
  type: 'url'
  id: string
  // i18n key —— 渲染时通过 t() 解析
  labelKey: string
  // 目标 URL，最终交给 shell.openExternal 打开
  url: string
  // Lucide 图标名称
  icon: string
}

// 菜单项联合类型：动作、内置 role、分隔线、外部链接四种
export type MenuItem = MenuItemAction | MenuItemRole | MenuItemSeparator | MenuItemUrl

export interface MenuSection {
  // 分区唯一 ID
  id: string
  // i18n key —— 渲染时通过 t() 解析
  labelKey: string
  // Lucide 图标名称
  icon: string
  // 该分区下的菜单项列表
  items: MenuItem[]
}

// ─────────────────────────────────────────────────────────────────────────────
// 菜单定义
// ─────────────────────────────────────────────────────────────────────────────

export const EDIT_MENU: MenuSection = {
  id: 'edit',
  labelKey: 'menu.edit',
  icon: 'Pencil',
  items: [
    {
      type: 'role',
      role: 'undo',
      labelKey: 'menu.undo',
      icon: 'Undo2',
      shortcutDisplayMac: '⌘Z',
      shortcutDisplayOther: 'Ctrl+Z',
      ipcChannel: RPC_CHANNELS.menu.UNDO,
    },
    {
      type: 'role',
      role: 'redo',
      labelKey: 'menu.redo',
      icon: 'Redo2',
      shortcutDisplayMac: '⌘⇧Z',
      shortcutDisplayOther: 'Ctrl+Shift+Z',
      ipcChannel: RPC_CHANNELS.menu.REDO,
    },
    { type: 'separator' },
    {
      type: 'role',
      role: 'cut',
      labelKey: 'menu.cut',
      icon: 'Scissors',
      shortcutDisplayMac: '⌘X',
      shortcutDisplayOther: 'Ctrl+X',
      ipcChannel: RPC_CHANNELS.menu.CUT,
    },
    {
      type: 'role',
      role: 'copy',
      labelKey: 'menu.copy',
      icon: 'Copy',
      shortcutDisplayMac: '⌘C',
      shortcutDisplayOther: 'Ctrl+C',
      ipcChannel: RPC_CHANNELS.menu.COPY,
    },
    {
      type: 'role',
      role: 'paste',
      labelKey: 'menu.paste',
      icon: 'ClipboardPaste',
      shortcutDisplayMac: '⌘V',
      shortcutDisplayOther: 'Ctrl+V',
      ipcChannel: RPC_CHANNELS.menu.PASTE,
    },
    { type: 'separator' },
    {
      type: 'role',
      role: 'selectAll',
      labelKey: 'menu.selectAll',
      icon: 'TextSelect',
      shortcutDisplayMac: '⌘A',
      shortcutDisplayOther: 'Ctrl+A',
      ipcChannel: RPC_CHANNELS.menu.SELECT_ALL,
    },
  ],
}

export const VIEW_MENU: MenuSection = {
  id: 'view',
  labelKey: 'menu.view',
  icon: 'Eye',
  items: [
    {
      type: 'role',
      role: 'zoomIn',
      labelKey: 'menu.zoomIn',
      icon: 'ZoomIn',
      shortcutDisplayMac: '⌘+',
      shortcutDisplayOther: 'Ctrl++',
      ipcChannel: RPC_CHANNELS.menu.ZOOM_IN,
    },
    {
      type: 'role',
      role: 'zoomOut',
      labelKey: 'menu.zoomOut',
      icon: 'ZoomOut',
      shortcutDisplayMac: '⌘-',
      shortcutDisplayOther: 'Ctrl+-',
      ipcChannel: RPC_CHANNELS.menu.ZOOM_OUT,
    },
    {
      type: 'role',
      role: 'resetZoom',
      labelKey: 'menu.resetZoom',
      icon: 'RotateCcw',
      shortcutDisplayMac: '⌘0',
      shortcutDisplayOther: 'Ctrl+0',
      ipcChannel: RPC_CHANNELS.menu.ZOOM_RESET,
    },
    { type: 'separator' },
    {
      type: 'action',
      id: 'toggleFocusMode',
      actionId: 'view.toggleFocusMode',
      labelKey: 'menu.toggleFocusMode',
      shortcut: 'CmdOrCtrl+.',
      shortcutDisplayMac: '⌘.',
      shortcutDisplayOther: 'Ctrl+.',
      ipcChannel: RPC_CHANNELS.menu.TOGGLE_FOCUS_MODE,
      icon: 'Focus',
    },
    {
      type: 'action',
      id: 'toggleSidebar',
      actionId: 'view.toggleSidebar',
      labelKey: 'menu.toggleSidebar',
      shortcut: 'CmdOrCtrl+B',
      shortcutDisplayMac: '⌘B',
      shortcutDisplayOther: 'Ctrl+B',
      ipcChannel: RPC_CHANNELS.menu.TOGGLE_SIDEBAR,
      icon: 'PanelLeft',
    },
  ],
}

export const WINDOW_MENU: MenuSection = {
  id: 'window',
  labelKey: 'menu.window',
  icon: 'AppWindow',
  items: [
    {
      type: 'role',
      role: 'minimize',
      labelKey: 'menu.minimize',
      icon: 'Minimize2',
      shortcutDisplayMac: '⌘M',
      shortcutDisplayOther: '',
      ipcChannel: RPC_CHANNELS.menu.MINIMIZE,
    },
    {
      type: 'role',
      role: 'zoom',
      labelKey: 'menu.maximize',
      icon: 'Maximize2',
      ipcChannel: RPC_CHANNELS.menu.MAXIMIZE,
    },
  ],
}

// 按顺序排列的所有菜单分区（供 renderer 使用）
export const MENU_SECTIONS: MenuSection[] = [EDIT_MENU, VIEW_MENU, WINDOW_MENU]

// ─────────────────────────────────────────────────────────────────────────────
// 根菜单项
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Craft logo 菜单中的根级动作项。
 *
 * DesktopAppMenu（下拉菜单）和 MobileAppMenu（全屏面板）都读取此集合。
 * 桌面端直接渲染全部四项；移动端会过滤掉 quit（在浏览器标签中无意义），
 * 并在 newWindow 与 keyboardShortcuts 之间插入 Settings/Help/Debug 导航行。
 *
 * 图标均为 Lucide 名称。newChat 在 renderer 里映射到本地组件 SquarePenRounded，
 * 这是唯一允许的例外。
 */
export const ROOT_MENU = {
  newChat: {
    type: 'action',
    id: 'newChat',
    actionId: 'app.newChat',
    labelKey: 'menu.newChat',
    shortcut: 'CmdOrCtrl+N',
    shortcutDisplayMac: '⌘N',
    shortcutDisplayOther: 'Ctrl+N',
    ipcChannel: RPC_CHANNELS.menu.NEW_CHAT,
    icon: 'SquarePen',
  },
  newWindow: {
    type: 'action',
    id: 'newWindow',
    actionId: 'app.newWindow',
    labelKey: 'menu.newWindow',
    shortcut: 'CmdOrCtrl+Shift+N',
    shortcutDisplayMac: '⌘⇧N',
    shortcutDisplayOther: 'Ctrl+Shift+N',
    ipcChannel: RPC_CHANNELS.menu.NEW_WINDOW,
    icon: 'AppWindow',
  },
  keyboardShortcuts: {
    type: 'action',
    id: 'keyboardShortcuts',
    actionId: 'app.keyboardShortcuts',
    labelKey: 'menu.keyboardShortcuts',
    shortcut: '',
    shortcutDisplayMac: '',
    shortcutDisplayOther: '',
    ipcChannel: RPC_CHANNELS.menu.KEYBOARD_SHORTCUTS,
    icon: 'Keyboard',
  },
  quit: {
    type: 'action',
    id: 'quit',
    actionId: 'app.quit',
    labelKey: 'menu.quitCraftAgents',
    shortcut: 'CmdOrCtrl+Q',
    shortcutDisplayMac: '⌘Q',
    shortcutDisplayOther: 'Ctrl+Q',
    ipcChannel: RPC_CHANNELS.menu.QUIT,
    icon: 'LogOut',
  },
} as const satisfies Record<string, MenuItemAction>

// ─────────────────────────────────────────────────────────────────────────────
// 帮助链接
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Help 子菜单（桌面端）与 Help 子页面（移动端）中渲染的外部链接项。
 * 不包含 keyboardShortcuts，因为它是 MenuItemAction，且位于 ROOT_MENU 中，
 * 以便移动端能把它提升到根列表。
 */
export const HELP_LINKS: MenuItemUrl[] = [
  {
    type: 'url',
    id: 'helpAndDocs',
    labelKey: 'menu.helpAndDocs',
    url: 'https://agents.craft.do/docs',
    icon: 'HelpCircle',
  },
]

// ─────────────────────────────────────────────────────────────────────────────
// Debug 菜单（仅开发环境）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Debug 子菜单 —— 仅在 `window.electronAPI.isDebugMode()` 返回 true 时渲染。
 *
 * checkForUpdates 与 installUpdate 调用的是 renderer 专属的 electronAPI 方法，
 * 不走菜单 IPC 通道，因此它们的 ipcChannel 字段故意留空。
 */
export const DEBUG_MENU: MenuSection = {
  id: 'debug',
  labelKey: 'menu.debug',
  icon: 'Bug',
  items: [
    {
      type: 'action',
      id: 'checkForUpdates',
      actionId: 'app.checkForUpdates',
      labelKey: 'menu.checkForUpdates',
      shortcut: '',
      shortcutDisplayMac: '',
      shortcutDisplayOther: '',
      ipcChannel: '',
      icon: 'Download',
    },
    {
      type: 'action',
      id: 'installUpdate',
      actionId: 'app.installUpdate',
      labelKey: 'menu.installUpdate',
      shortcut: '',
      shortcutDisplayMac: '',
      shortcutDisplayOther: '',
      ipcChannel: '',
      icon: 'Download',
    },
    { type: 'separator' },
    {
      type: 'action',
      id: 'toggleDevTools',
      actionId: 'app.toggleDevTools',
      labelKey: 'menu.toggleDevTools',
      shortcut: '',
      shortcutDisplayMac: '⌥⌘I',
      shortcutDisplayOther: 'Ctrl+Shift+I',
      ipcChannel: RPC_CHANNELS.menu.TOGGLE_DEV_TOOLS,
      icon: 'Bug',
    },
  ],
}

// ─────────────────────────────────────────────────────────────────────────────
// 设置菜单项
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 设置项定义
 * 同时被 AppMenu（logo 下拉菜单）与 SettingsNavigator（设置侧边栏面板）使用
 */
import { SETTINGS_PAGES, type SettingsSubpage } from './settings-registry'

export interface SettingsMenuItem {
  id: SettingsSubpage
  // i18n key —— 渲染时通过 t() 解析
  labelKey: string
  // Lucide 图标名称，供 AppMenu 使用
  icon: string
  // i18n key —— 渲染时通过 t() 解析
  descriptionKey: string
}

/**
 * 设置页面的图标映射表（Lucide 图标名称）。
 * 只有图标需要在这里定义，页面其他数据来自 settings-registry。
 */
const SETTINGS_ICONS: Record<SettingsSubpage, string> = {
  app: 'ToggleRight',
  ai: 'Sparkles',
  appearance: 'Palette',
  input: 'Keyboard',
  workspace: 'Building2',
  permissions: 'ShieldCheck',
  labels: 'Tag',
  messaging: 'MessageSquare',
  server: 'Server',
  shortcuts: 'Keyboard',
  preferences: 'UserCircle',
}

/**
 * 所有设置页面 —— 从 settings-registry 派生（单一事实来源）。
 * 顺序由 settings-registry.ts 中的 SETTINGS_PAGES 决定。
 */
export const SETTINGS_ITEMS: SettingsMenuItem[] = SETTINGS_PAGES
  .filter(page => page.id !== 'server' || FEATURE_FLAGS.embeddedServer)
  .map(page => ({
    id: page.id,
    labelKey: page.labelKey,
    icon: SETTINGS_ICONS[page.id],
    descriptionKey: page.descriptionKey,
  }))

// ─────────────────────────────────────────────────────────────────────────────
// 辅助函数
// ─────────────────────────────────────────────────────────────────────────────

// 获取当前平台应显示的快捷键文本
export function getShortcutDisplay(item: MenuItemAction | MenuItemRole, isMac: boolean): string {
  return isMac ? (item.shortcutDisplayMac ?? '') : (item.shortcutDisplayOther ?? '')
}
