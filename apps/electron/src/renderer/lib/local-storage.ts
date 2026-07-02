/**
 * Electron 渲染进程的 localStorage 集中封装。
 * 提供类型安全的读写接口，并为所有 key 统一加前缀，避免冲突。
 */

const PREFIX = 'craft-'

/**
 * 应用中所有 localStorage 键的集中定义。
 * 集中管理可以避免魔法字符串与键名冲突。
 */
export const KEYS = {
  // 聊天侧边栏
  sidebarVisible: 'sidebar-visible',
  sidebarWidth: 'sidebar-width',
  sessionListWidth: 'session-list-width',
  sidebarMode: 'sidebar-mode',
  listFilter: 'list-filter',
  labelFilter: 'label-filter',
  viewFilters: 'view-filters', // 每个视图的过滤条件：{ [viewKey]: { statuses, labels } }
  expandedFolders: 'expanded-folders',
  collapsedSidebarItems: 'collapsed-sidebar-items',
  chatGroupingMode: 'chat-grouping-mode', // 会话分组方式：'date' | 'status'
  collapsedSessionGroups: 'collapsed-session-groups', // 会话列表中折叠的分组键

  // 专注模式
  focusModeEnabled: 'focus-mode-enabled',

  // 会话文件面板状态
  sessionFilesExpandedFolders: 'session-files-expanded', // 会话文件树中展开的文件夹（按 sessionId 区分）

  // 主题
  theme: 'theme',

  // 面板布局（动态后缀）
  panelLayout: 'panel-layout', // 实际使用形式：panelLayout:${key}

  // 标签页（按工作区区分）
  tabs: 'tabs', // 实际使用形式：tabs-${workspaceId}

  // 工作目录
  recentWorkingDirs: 'recent-working-dirs',

  // TurnCard 展开状态（跨会话切换保持）
  turnCardExpansion: 'turncard-expansion',

  // 最后选中的会话（按工作区后缀区分）
  lastSelectedSessionId: 'last-selected-session-id',

  // 设置页导航
  lastSettingsSubpage: 'last-settings-subpage',

  // 外观
  showConnectionIcons: 'show-connection-icons',
  projectColorTreatment: 'project-color-treatment', // 'stripe' | 'stripe-tint'

  // What's New
  whatsNewLastSeenVersion: 'whats-new-last-seen-version',

  // 工作区导航状态（按 workspaceSlug 后缀区分）
  // 保存完整 URL 查询字符串，切换回来时恢复面板/焦点/侧边栏状态
  workspaceUrl: 'workspace-url',
} as const

export type StorageKey = typeof KEYS[keyof typeof KEYS]

/**
 * 组装带前缀的完整键。
 * 支持动态后缀，例如 'panel-layout:chat' 或 'tabs-workspace123'。
 */
function buildKey(key: string, suffix?: string): string {
  const base = `${PREFIX}${key}`
  return suffix ? `${base}:${suffix}` : base
}

/**
 * 从 localStorage 读取值并做 JSON 解析。
 * 键不存在或解析失败时返回 fallback。
 */
export function get<T>(key: StorageKey, fallback: T, suffix?: string): T {
  try {
    const item = localStorage.getItem(buildKey(key, suffix))
    if (item === null) return fallback
    return JSON.parse(item) as T
  } catch {
    return fallback
  }
}

/**
 * 把值 JSON 序列化后写入 localStorage。
 */
export function set<T>(key: StorageKey, value: T, suffix?: string): void {
  try {
    localStorage.setItem(buildKey(key, suffix), JSON.stringify(value))
  } catch (error) {
    console.warn(`[localStorage] 设置 ${key} 失败：`, error)
  }
}

/**
 * 从 localStorage 删除指定键。
 */
export function remove(key: StorageKey, suffix?: string): void {
  localStorage.removeItem(buildKey(key, suffix))
}

/**
 * 读取原始字符串值（用于 atomWithStorage 等需要原始字符串的兼容场景）。
 */
export function getRaw(key: StorageKey, suffix?: string): string | null {
  return localStorage.getItem(buildKey(key, suffix))
}

/**
 * 写入原始字符串值（用于 atomWithStorage 等需要原始字符串的兼容场景）。
 */
export function setRaw(key: StorageKey, value: string, suffix?: string): void {
  localStorage.setItem(buildKey(key, suffix), value)
}

/**
 * 获取完整的带前缀键名字符串，供 atomWithStorage 等需要原始键字符串的 API 使用。
 */
export function getKeyString(key: StorageKey, suffix?: string): string {
  return buildKey(key, suffix)
}
