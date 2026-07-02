import { createContext, useContext } from "react"
import type { LabelConfig } from "@craft-agent/shared/labels"
import type { SessionStatusId, SessionStatus } from "@/config/session-status-config"
import type { SessionMeta } from "@/atoms/sessions"
import type { SessionOptions } from "@/hooks/useSessionOptions"
import type { ContentSearchResult } from "@/hooks/useSessionSearch"

/**
 * 会话列表上下文（Context）
 *
 * React 的 Context 可以理解为“跨层传递数据的公共包”：
 * 父组件通过 Provider 把值塞进去，子孙组件通过 useContext 取出来，
 * 不用一级一级 props 往下传。对 Go 同学来说，类似把依赖放在 context.Context 里，
 * 但 React Context 是同步、单向向下广播的。
 *
 * 这里集中存放会话列表需要的回调函数、配置和按会话查找的缓存数据。
 */
export interface SessionListContextValue {
  // 会话操作回调（所有列表项共享）
  onRenameClick: (sessionId: string, currentName: string) => void
  onSessionStatusChange: (sessionId: string, state: SessionStatusId) => void
  onFlag?: (sessionId: string) => void
  onUnflag?: (sessionId: string) => void
  onArchive?: (sessionId: string) => void
  onUnarchive?: (sessionId: string) => void
  onMarkUnread: (sessionId: string) => void
  onDelete: (sessionId: string, skipConfirmation?: boolean) => Promise<boolean>
  onLabelsChange?: (sessionId: string, labels: string[]) => void
  /** Set or clear the project binding for a session (null = unbind) */
  onSetProjectId?: (sessionId: string, projectId: string | null) => void
  /** Available workspace projects for the context-menu submenu */
  projects?: Array<{ id: string; slug: string; name: string; color?: string }>
  onSelectSessionById: (sessionId: string) => void
  onOpenInNewWindow: (item: SessionMeta) => void
  onSendToWorkspace?: (sessionIds: string[]) => void
  /** 触发焦点区域切换（例如按 Cmd+1 回到会话列表） */
  onFocusZone: () => void
  /** 会话列表项的键盘事件处理（Enter/Space/方向键等） */
  onKeyDown: (e: React.KeyboardEvent, item: SessionMeta) => void

  // 共享配置
  sessionStatuses: SessionStatus[]
  flatLabels: LabelConfig[]
  labels: LabelConfig[]
  searchQuery?: string
  selectedSessionId?: string | null
  /** 是否处于多选模式（此时单点击进入选择而非打开会话） */
  isMultiSelectActive: boolean

  // 按会话查找的 Map（类似 Go 里的 map[string]T，但保留插入顺序）
  sessionOptions?: Map<string, SessionOptions>
  contentSearchResults: Map<string, ContentSearchResult>
  /** 当前会话在 DOM 中实际匹配到的信息（匹配数、是否高亮中） */
  activeChatMatchInfo?: { sessionId: string | null; count: number; isHighlighting?: boolean }
  /** 判断某个会话是否还有待处理的权限/管理员提示 */
  hasPendingPrompt?: (sessionId: string) => boolean
}

// 创建 Context，默认值设为 null，这样如果组件没在 Provider 内调用 useSessionListContext 会报错
const SessionListContext = createContext<SessionListContextValue | null>(null)

/**
 * 消费 SessionListContext 的 Hook
 * 必须在 SessionListProvider 内部使用，否则会抛错（比 Go 的空指针检查更严格）。
 */
export function useSessionListContext(): SessionListContextValue {
  const ctx = useContext(SessionListContext)
  if (!ctx) throw new Error("useSessionListContext must be used within SessionList")
  return ctx
}

// 直接把内部 Context 的 Provider 导出，外部用 <SessionListProvider value={...}> 包裹组件树
export const SessionListProvider = SessionListContext.Provider
