/**
 * Route Registry —— 路由注册表。
 *
 * 为应用内导航提供类型安全的路由构建器。
 * 所有导航都应使用这里的 builder，避免硬编码字符串。
 *
 * 路由格式：
 * - action/{name}[/{id}] —— 触发副作用
 * - {filter}[/session/{sessionId}] —— 组合式视图路由，表达完整的导航状态
 *
 * 使用示例：
 *   import { routes } from '@/shared/routes'
 *   navigate(routes.action.newSession())
 *   navigate(routes.view.allSessions())
 *   navigate(routes.view.settings('shortcuts'))
 */

import type { SettingsSubpage } from './settings-registry'
import type { PermissionMode } from '@craft-agent/shared/agent/mode-types'

// 把参数对象转换成 URL query string 的辅助函数
function toQueryString(params?: Record<string, string | undefined>): string {
  if (!params) return ''
  const filtered = Object.entries(params).filter(([, v]) => v !== undefined)
  if (filtered.length === 0) return ''
  const searchParams = new URLSearchParams(
    filtered as [string, string][]
  )
  return `?${searchParams.toString()}`
}

/**
 * 路由定义，所有 builder 都带类型安全。
 *
 * 'as const' 让整个对象成为常量类型，ReturnType 可以精确推导出返回的字面量字符串，
 * 这样 ActionRoute / ViewRoute 就是由所有合法路由字符串组成的联合类型。
 */
export const routes = {
  // ============================================
  // Action Routes —— 触发动作
  // ============================================
  action: {
    /**
     * 创建新 session。
     * @param input - 可选的初始消息，用于预填充或直接发送
     * @param name - 可选的 session 名称
     * @param send - 如果为 true 且提供了 input，则立即发送该消息
     * @param status - 可选的状态（todo-state）ID，会应用到新 session
     * @param label - 可选的标签 ID，会应用到新 session
     * @param project - 可选的项目 id，用于绑定新 session
     */
    newSession: (params?: { input?: string; name?: string; send?: boolean; status?: string; label?: string; project?: string }) =>
      `action/new-session${toQueryString(params ? { ...params, send: params.send ? 'true' : undefined } : undefined)}` as const,

    // 重命名 session
    renameSession: (sessionId: string, name: string) =>
      `action/rename-session/${sessionId}?name=${encodeURIComponent(name)}` as const,

    // 删除 session（带确认）
    deleteSession: (sessionId: string) =>
      `action/delete-session/${sessionId}` as const,

    // 给 session 打标（flag）
    flagSession: (sessionId: string) =>
      `action/flag-session/${sessionId}` as const,

    // 取消 session 的 flag
    unflagSession: (sessionId: string) =>
      `action/unflag-session/${sessionId}` as const,

    // 为 source 启动 OAuth 授权流程
    oauth: (sourceSlug: string) => `action/oauth/${sourceSlug}` as const,

    // 打开添加 source 的 UI
    addSource: () => 'action/add-source' as const,

    // 注意：test-source 路由可在 API 支持后添加
    // testSource: (sourceSlug: string) => `action/test-source/${sourceSlug}` as const,

    // 删除 source
    deleteSource: (sourceSlug: string) =>
      `action/delete-source/${sourceSlug}` as const,

    // 为 session 设置权限模式（permission mode）
    setPermissionMode: (
      sessionId: string,
      mode: PermissionMode
    ) => `action/set-mode/${sessionId}?mode=${mode}` as const,

    // 复制文本到剪贴板
    copyToClipboard: (text: string) =>
      `action/copy?text=${encodeURIComponent(text)}` as const,
  },

  // ============================================
  // View Routes —— 组合式侧边栏/导航器/详情路由
  // ============================================
  view: {
    // sessions 导航器：allSessions 筛选视图
    allSessions: (sessionId?: string) =>
      sessionId ? `allSessions/session/${sessionId}` as const : 'allSessions' as const,

    // sessions 导航器：flagged 筛选视图
    flagged: (sessionId?: string) =>
      sessionId ? `flagged/session/${sessionId}` as const : 'flagged' as const,

    // sessions 导航器：archived 筛选视图
    archived: (sessionId?: string) =>
      sessionId ? `archived/session/${sessionId}` as const : 'archived' as const,

    // sessions 导航器：按待办状态筛选
    state: (stateId: string, sessionId?: string) =>
      sessionId
        ? `state/${stateId}/session/${sessionId}` as const
        : `state/${stateId}` as const,

    // sessions 导航器：按标签筛选（包含通过树层级继承下来的后代）
    label: (labelId: string, sessionId?: string) =>
      sessionId
        ? `label/${encodeURIComponent(labelId)}/session/${sessionId}` as const
        : `label/${encodeURIComponent(labelId)}` as const,

    // sessions 导航器：按视图（view）筛选，视图规则是动态计算的
    view: (viewId: string, sessionId?: string) =>
      sessionId
        ? `view/${encodeURIComponent(viewId)}/session/${sessionId}` as const
        : `view/${encodeURIComponent(viewId)}` as const,

    // sources 导航器，支持按类型过滤（api / mcp / local）
    sources: (params?: { sourceSlug?: string; type?: 'api' | 'mcp' | 'local' }) => {
      const { sourceSlug, type } = params ?? {}
      // 根据筛选类型构建基础路径
      const base = type ? `sources/${type}` : 'sources'
      if (sourceSlug) {
        return `${base}/source/${sourceSlug}` as const
      }
      return base as 'sources' | `sources/${'api' | 'mcp' | 'local'}`
    },

    // sources 导航器：仅 API 类型 source
    sourcesApi: (sourceSlug?: string) =>
      sourceSlug
        ? `sources/api/source/${sourceSlug}` as const
        : 'sources/api' as const,

    // sources 导航器：仅 MCP 类型 source
    sourcesMcp: (sourceSlug?: string) =>
      sourceSlug
        ? `sources/mcp/source/${sourceSlug}` as const
        : 'sources/mcp' as const,

    // sources 导航器：仅本地文件夹类型 source
    sourcesLocal: (sourceSlug?: string) =>
      sourceSlug
        ? `sources/local/source/${sourceSlug}` as const
        : 'sources/local' as const,

    // skills 导航器；传入 slug 时进入本地 skill 详情视图
    skills: (skillSlug?: string) => {
      if (!skillSlug) return 'skills' as const
      return `skills/skill/${skillSlug}` as const
    },

    // automations 导航器，支持按类型过滤（scheduled / event / agentic）
    automations: (params?: { automationId?: string; type?: 'scheduled' | 'event' | 'agentic' }) => {
      const { automationId, type } = params ?? {}
      const base = type ? `automations/${type}` : 'automations'
      if (automationId) return `${base}/automation/${automationId}` as const
      return base as 'automations' | `automations/${'scheduled' | 'event' | 'agentic'}`
    },

    // automations 导航器：仅 scheduled 类型
    automationsScheduled: (automationId?: string) =>
      automationId ? `automations/scheduled/automation/${automationId}` as const : 'automations/scheduled' as const,

    // automations 导航器：仅 event 类型
    automationsEvent: (automationId?: string) =>
      automationId ? `automations/event/automation/${automationId}` as const : 'automations/event' as const,

    // automations 导航器：仅 agentic 类型
    automationsAgentic: (automationId?: string) =>
      automationId ? `automations/agentic/automation/${automationId}` as const : 'automations/agentic' as const,

    // settings 导航器，使用 settings-registry 中的 SettingsSubpage
    settings: (subpage?: SettingsSubpage) =>
      subpage
        ? `settings/${subpage}` as const
        : 'settings' as const,

    /** Projects view (projects navigator) */
    projects: (projectSlug?: string) =>
      projectSlug
        ? `projects/project/${projectSlug}` as const
        : 'projects' as const,

    /** Kanban board view (sessions navigator, board view mode, all sessions) */
    board: () => 'board' as const,
  },
} as const

/**
 * 所有合法路由字符串的联合类型。
 *
 * 这里通过 (typeof routes.action)[keyof typeof routes.action] 取出 action 下每个 builder 的返回类型，
 * 再用 ReturnType 得到具体字符串字面量，最终组成联合类型。
 * 效果类似 Go 里用 const + iota 枚举，但 TS 能在编译期检查字符串是否合法。
 */
export type ActionRoute = ReturnType<(typeof routes.action)[keyof typeof routes.action]>
export type ViewRoute = ReturnType<(typeof routes.view)[keyof typeof routes.view]>
export type Route = ActionRoute | ViewRoute
