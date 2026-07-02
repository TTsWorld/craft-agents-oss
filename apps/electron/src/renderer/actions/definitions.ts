import type { ActionDefinition } from './types'

/**
 * 全应用 action（动作/命令）的集中定义表。
 *
 * 每个 action 代表一个可被快捷键触发、也可被代码显式调用的操作，
 * 类似 IDE/编辑器里的命令系统（VSCode command / Go 里可理解为注册表中的 handler 名）。
 * 这里只声明元数据（id、显示名、默认快捷键、分类、触发条件等），
 * 真正的执行逻辑在 registry.tsx 中通过 register() 注册。
 */
export const actions = {
  // ═══════════════════════════════════════════
  // 通用（General）
  // ═══════════════════════════════════════════
  'app.newChat': {
    id: 'app.newChat',
    label: 'New Chat',
    description: 'Create a new chat session',
    defaultHotkey: 'mod+n',
    category: 'General',
  },
  'app.newChatInPanel': {
    id: 'app.newChatInPanel',
    label: 'New Chat in Panel',
    description: 'Create a new chat session in a new panel',
    defaultHotkey: 'mod+t',
    category: 'General',
  },
  'app.settings': {
    id: 'app.settings',
    label: 'Settings',
    description: 'Open application settings',
    defaultHotkey: 'mod+,',
    category: 'General',
  },
  'app.toggleTheme': {
    id: 'app.toggleTheme',
    label: 'Toggle Theme',
    description: 'Switch between light and dark mode',
    defaultHotkey: 'mod+shift+a',
    category: 'General',
  },
  'app.search': {
    id: 'app.search',
    label: 'Search',
    description: 'Open search panel',
    defaultHotkey: 'mod+f',
    category: 'General',
  },
  'app.keyboardShortcuts': {
    id: 'app.keyboardShortcuts',
    label: 'Keyboard Shortcuts',
    description: 'Show keyboard shortcuts reference',
    defaultHotkey: 'mod+/',
    category: 'General',
  },
  'app.newWindow': {
    id: 'app.newWindow',
    label: 'New Window',
    description: 'Open a new window',
    defaultHotkey: 'mod+shift+n',
    category: 'General',
  },
  'app.quit': {
    id: 'app.quit',
    label: 'Quit',
    description: 'Quit the application',
    defaultHotkey: 'mod+q',
    category: 'General',
  },

  // ═══════════════════════════════════════════
  // 导航（Navigation）
  // ═══════════════════════════════════════════
  'nav.focusSidebar': {
    id: 'nav.focusSidebar',
    label: 'Focus Sidebar',
    defaultHotkey: 'mod+1',
    category: 'Navigation',
  },
  'nav.focusNavigator': {
    id: 'nav.focusNavigator',
    label: 'Focus Navigator',
    defaultHotkey: 'mod+2',
    category: 'Navigation',
  },
  'nav.focusChat': {
    id: 'nav.focusChat',
    label: 'Focus Chat',
    defaultHotkey: 'mod+3',
    category: 'Navigation',
  },
  'nav.nextZone': {
    id: 'nav.nextZone',
    label: 'Focus Next Zone',
    defaultHotkey: 'tab',
    category: 'Navigation',
    when: '!inputFocus',  // 在文本输入框里要让 Tab 保持正常切焦点的行为
  },
  'nav.goBack': {
    id: 'nav.goBack',
    label: 'Go Back',
    description: 'Navigate to previous session',
    defaultHotkey: 'mod+[',
    category: 'Navigation',
  },
  'nav.goForward': {
    id: 'nav.goForward',
    label: 'Go Forward',
    description: 'Navigate to next session',
    defaultHotkey: 'mod+]',
    category: 'Navigation',
  },
  'nav.goBackAlt': {
    id: 'nav.goBackAlt',
    label: 'Go Back',
    description: 'Navigate to previous session (arrow key)',
    defaultHotkey: 'mod+left',
    category: 'Navigation',
    when: '!inputFocus',  // 在文本输入框里 Cmd+Left 是把光标移到行首
  },
  'nav.goForwardAlt': {
    id: 'nav.goForwardAlt',
    label: 'Go Forward',
    description: 'Navigate to next session (arrow key)',
    defaultHotkey: 'mod+right',
    category: 'Navigation',
    when: '!inputFocus',  // 在文本输入框里 Cmd+Right 是把光标移到行尾
  },

  // ═══════════════════════════════════════════
  // 视图（View）
  // ═══════════════════════════════════════════
  'view.toggleSidebar': {
    id: 'view.toggleSidebar',
    label: 'Toggle Sidebar',
    defaultHotkey: 'mod+b',
    category: 'View',
  },
  'view.toggleFocusMode': {
    id: 'view.toggleFocusMode',
    label: 'Toggle Focus Mode',
    description: 'Hide both sidebars for distraction-free work',
    defaultHotkey: 'mod+.',
    category: 'View',
  },

  // ═══════════════════════════════════════════
  // 导航器/中间面板（Navigator，作用域限定）
  // ═══════════════════════════════════════════
  'navigator.selectAll': {
    id: 'navigator.selectAll',
    label: 'Select All',
    defaultHotkey: 'mod+a',
    category: 'Navigator',
    scope: 'navigator',
    when: 'navigatorFocus',  // 在文本输入框里 Cmd+A 应该是“全选文本”
  },
  'navigator.clearSelection': {
    id: 'navigator.clearSelection',
    label: 'Clear Selection',
    defaultHotkey: 'escape',
    category: 'Navigator',
    scope: 'navigator',
    when: 'navigatorFocus',
  },

  // ═══════════════════════════════════════════
  // 面板（Panels）
  // ═══════════════════════════════════════════
  'panel.focusNext': {
    id: 'panel.focusNext',
    label: 'Focus Next Panel',
    description: 'Move focus to the next panel',
    defaultHotkey: 'mod+shift+]',
    category: 'Navigation',
  },
  'panel.focusPrev': {
    id: 'panel.focusPrev',
    label: 'Focus Previous Panel',
    description: 'Move focus to the previous panel',
    defaultHotkey: 'mod+shift+[',
    category: 'Navigation',
  },

  // ═══════════════════════════════════════════
  // 聊天（Chat）
  // ═══════════════════════════════════════════
  'chat.stopProcessing': {
    id: 'chat.stopProcessing',
    label: 'Stop Processing',
    description: 'Cancel the current agent task (double-press)',
    defaultHotkey: 'escape',
    category: 'Chat',
    scope: 'chat',
    when: '!hasSelection',  // 先让浏览器用 Esc 清除选区；浮层由 enabled 回调里的 hasOpenOverlay() 处理
  },
  'chat.cyclePermissionMode': {
    id: 'chat.cyclePermissionMode',
    label: 'Cycle Permission Mode',
    description: 'Switch between Explore, Ask, and Execute modes',
    defaultHotkey: 'shift+tab',
    category: 'Chat',
  },
  'chat.nextSearchMatch': {
    id: 'chat.nextSearchMatch',
    label: 'Next Search Match',
    defaultHotkey: 'mod+g',
    category: 'Chat',
  },
  'chat.prevSearchMatch': {
    id: 'chat.prevSearchMatch',
    label: 'Previous Search Match',
    defaultHotkey: 'mod+shift+g',
    category: 'Chat',
  },

} as const satisfies Record<string, ActionDefinition>
// `as const` 把对象里的每个值都变成最窄的 literal 类型（比如 id 是 'app.newChat' 而不是 string），
// `satisfies Record<string, ActionDefinition>` 保证这个对象符合 ActionDefinition 的结构，
// 这样 TS 既能做类型检查，又能精确推导出所有 action ID。

/** 从 actions 对象推导出的 action ID 类型，保证类型安全（keyof + typeof 是 TS 常用技巧）。 */
export type ActionId = keyof typeof actions

/** 将所有 action 转为数组，常用于快捷键说明页。 */
export const actionList = Object.values(actions)

/** 按分类把 action 分组，用于设置页/帮助页的分组展示。 */
export const actionsByCategory = actionList.reduce((acc, action) => {
  if (!acc[action.category]) acc[action.category] = []
  acc[action.category].push(action)
  return acc
}, {} as Record<string, ActionDefinition[]>)
