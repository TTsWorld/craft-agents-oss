/**
 * 服务端 → 客户端推送事件的字典（typed event map）。
 * 键是频道字符串字面量，值是该频道触发时传给监听器的参数元组。
 * 类比 Go：相当于一个 "chan -> 参数签名" 的路由表，类型系统会校验订阅/发布是否匹配。
 */

import type { ThemeOverrides } from '../config/index'
import type { LoadedSource } from '../sources/types'
import type { LoadedSkill } from '../skills/types'
import type { LoadedProject } from '../projects/types'
import { RPC_CHANNELS } from './channels'
import type {
  SessionEvent,
  UnreadSummary,
  UpdateInfo,
  BrowserInstanceInfo,
  DeepLinkNavigation,
  TaskGenerateResult,
} from './dto'

// BroadcastEventMap：所有广播事件的类型映射，订阅端用它推导回调参数。
// 形如 [arg1: T1, arg2: T2] 表示该事件会按顺序传入这些参数。
export interface BroadcastEventMap {
  // 会话相关事件（按 workspace 范围广播，仅当前 workspace 的客户端收到）
  [RPC_CHANNELS.sessions.EVENT]: [event: SessionEvent]
  [RPC_CHANNELS.sessions.UNREAD_SUMMARY_CHANGED]: [summary: UnreadSummary]
  [RPC_CHANNELS.sessions.FILES_CHANGED]: [sessionId: string]

  // 领域数据变更广播（全局广播，所有客户端都收到）
  [RPC_CHANNELS.sources.CHANGED]: [workspaceId: string, sources: LoadedSource[]]
  [RPC_CHANNELS.labels.CHANGED]: [workspaceId: string]
  [RPC_CHANNELS.statuses.CHANGED]: [workspaceId: string]
  [RPC_CHANNELS.automations.CHANGED]: [workspaceId: string]
  [RPC_CHANNELS.skills.CHANGED]: [workspaceId: string, skills: LoadedSkill[]]
  [RPC_CHANNELS.projects.CHANGED]: [workspaceId: string, projects: LoadedProject[]]
  [RPC_CHANNELS.tasks.GENERATED]: [workspaceId: string, result: TaskGenerateResult]
  [RPC_CHANNELS.llmConnections.CHANGED]: []
  [RPC_CHANNELS.permissions.DEFAULTS_CHANGED]: [value: null]

  // 主题相关广播（全局）
  [RPC_CHANNELS.theme.APP_CHANGED]: [theme: ThemeOverrides | null]
  [RPC_CHANNELS.theme.SYSTEM_CHANGED]: [isDark: boolean]
  [RPC_CHANNELS.theme.PREFERENCES_CHANGED]: [preferences: { mode: string; colorTheme: string; font: string }]
  [RPC_CHANNELS.theme.WORKSPACE_THEME_CHANGED]: [data: { workspaceId: string; themeId: string | null }]

  // 更新广播（全局）
  [RPC_CHANNELS.update.AVAILABLE]: [info: UpdateInfo]
  [RPC_CHANNELS.update.DOWNLOAD_PROGRESS]: [progress: number]

  // 角标/托盘图标广播（全局）
  [RPC_CHANNELS.badge.DRAW]: [data: { count: number; iconDataUrl: string }]
  [RPC_CHANNELS.badge.DRAW_WINDOWS]: [data: { count: number }]

  // 窗口事件（按窗口广播）
  [RPC_CHANNELS.window.FOCUS_STATE]: [isFocused: boolean]
  [RPC_CHANNELS.window.CLOSE_REQUESTED]: []

  // 浏览器面板事件（全局）
  [RPC_CHANNELS.browserPane.STATE_CHANGED]: [info: BrowserInstanceInfo]
  [RPC_CHANNELS.browserPane.REMOVED]: [id: string]
  [RPC_CHANNELS.browserPane.INTERACTED]: [id: string]

  // 导航事件（按窗口广播）
  [RPC_CHANNELS.notification.NAVIGATE]: [data: { workspaceId: string; sessionId: string }]
  [RPC_CHANNELS.deeplink.NAVIGATE]: [navigation: DeepLinkNavigation]

  // Copilot 设备码事件（OAuth 设备码授权流程）
  [RPC_CHANNELS.copilot.DEVICE_CODE]: [data: { userCode: string; verificationUri: string }]

  // 菜单事件（按窗口广播，无 payload）
  [RPC_CHANNELS.menu.NEW_CHAT]: []
  [RPC_CHANNELS.menu.OPEN_SETTINGS]: []
  [RPC_CHANNELS.menu.KEYBOARD_SHORTCUTS]: []
  [RPC_CHANNELS.menu.TOGGLE_FOCUS_MODE]: []
  [RPC_CHANNELS.menu.TOGGLE_SIDEBAR]: []

  // 消息网关广播（WhatsApp/Telegram/Lark 等绑定状态）
  [RPC_CHANNELS.messaging.BINDING_CHANGED]: [workspaceId: string]
  [RPC_CHANNELS.messaging.PLATFORM_STATUS]: [workspaceId: string, platform: string, connected: boolean]
}
