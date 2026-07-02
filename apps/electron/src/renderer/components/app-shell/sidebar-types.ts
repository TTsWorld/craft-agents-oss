/**
 * sidebar-types.ts
 *
 * 定义左侧边栏（2nd sidebar）的内容模式类型与类型守卫。
 * 左侧导航项切换时，AppShell 根据 SidebarMode 决定中间导航栏显示会话列表、Source 列表还是设置项。
 */

// 从共享类型导入，避免重复定义
import type { SessionFilter, SettingsSubpage } from '../../../shared/types'
export type { SessionFilter, SettingsSubpage }

/**
 * 侧边栏模式：决定中间导航栏显示什么内容。
 *
 * Settings 的 subpage 为 null 对应裸 `settings` 路由，
 * 用于紧凑模式下只显示导航栏、不展示右侧内容面板的场景。
 */
export type SidebarMode =
  | { type: 'sessions'; filter: SessionFilter }
  | { type: 'sources' }
  | { type: 'settings'; subpage: SettingsSubpage | null }

/**
 * 类型守卫：判断当前模式是否为会话模式。
 * TS 类型守卫会在返回 true 时把 mode 收窄为具体类型，便于安全访问 filter。
 */
export const isSessionsMode = (
  mode: SidebarMode
): mode is { type: 'sessions'; filter: SessionFilter } => mode.type === 'sessions'

/** 类型守卫：判断当前模式是否为 Sources 模式 */
export const isSourcesMode = (
  mode: SidebarMode
): mode is { type: 'sources' } => mode.type === 'sources'

/** 类型守卫：判断当前模式是否为 Settings 模式 */
export const isSettingsMode = (
  mode: SidebarMode
): mode is { type: 'settings'; subpage: SettingsSubpage | null } => mode.type === 'settings'

/**
 * 把当前模式转换成可用于 localStorage 持久化的 key。
 * 这样切换工作区或刷新页面后可以恢复上次选中的侧边栏视图。
 */
export const getSidebarModeKey = (mode: SidebarMode): string => {
  if (mode.type === 'sources') return 'sources'
  if (mode.type === 'settings') {
    return mode.subpage === null ? 'settings' : `settings:${mode.subpage}`
  }
  const f = mode.filter
  if (f.kind === 'state') return `state:${f.stateId}`
  return f.kind
}

/**
 * 把持久化 key 解析回 SidebarMode。
 * 如果 key 无效或需要额外校验（如 state）则返回 null。
 */
export const parseSidebarModeKey = (key: string): SidebarMode | null => {
  if (key === 'sources') return { type: 'sources' }
  if (key === 'allSessions') return { type: 'sessions', filter: { kind: 'allSessions' } }
  if (key === 'flagged') return { type: 'sessions', filter: { kind: 'flagged' } }
  if (key.startsWith('state:')) {
    const stateId = key.slice(6)
    if (stateId) return { type: 'sessions', filter: { kind: 'state', stateId } }
  }
  if (key.startsWith('settings:')) {
    const subpage = key.slice(9) as SettingsSubpage
    if (['app', 'appearance', 'workspace', 'permissions', 'labels', 'shortcuts', 'preferences'].includes(subpage)) {
      return { type: 'settings', subpage }
    }
  }
  if (key === 'settings') return { type: 'settings', subpage: null }
  return null
}

/** 默认侧边栏模式：显示全部会话 */
export const DEFAULT_SIDEBAR_MODE: SidebarMode = {
  type: 'sessions',
  filter: { kind: 'allSessions' },
}
