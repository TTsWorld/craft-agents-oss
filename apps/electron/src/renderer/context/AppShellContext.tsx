/**
 * AppShellContext（应用外壳上下文）
 *
 * 向标签面板（tab panels）提供当前会话、工作空间以及各类回调函数，
 * 避免从 AppShell 到 ChatTabPanel 等深层组件之间层层传递 props。
 *
 * ChatTabPanel 和其他需要当前会话/工作空间的组件都通过这里读取数据。
 */

import * as React from 'react'
import { createContext, useContext, useCallback } from 'react'
import { useAtomValue } from 'jotai'
import type { ChatDisplayHandle } from '@/components/app-shell/ChatDisplay'
import type {
  Session,
  Workspace,
  FileAttachment,
  PermissionRequest,
  CredentialRequest,
  CredentialResponse,
  PermissionMode,
  SessionStatus,
  LoadedSource,
  LoadedSkill,
  NewChatActionParams,
  LlmConnectionWithStatus,
  TestAutomationResult,
} from '../../shared/types'
import type { SessionStatus as SessionStatusConfig } from '@/config/session-status-config'
import type { SessionOptions, SessionOptionUpdates } from '../hooks/useSessionOptions'
import { defaultSessionOptions } from '../hooks/useSessionOptions'
import { sessionAtomFamily } from '../atoms/sessions'

export interface AppShellContextType {
  // 数据
  // 注意：这里没有直接放 sessions 列表；列表用 sessionMetaMapAtom，单个会话用 useSession(id)。
  // 这样可以避免闭包持有完整消息数组导致内存泄漏。
  /** 当前用户可见的所有工作空间 */
  workspaces: Workspace[]
  /** 当前激活的工作空间 ID；null 表示未选中任何工作空间 */
  activeWorkspaceId: string | null
  /** 当前工作空间的 slug，用于 SDK skill 资格判断（从工作空间路径派生） */
  activeWorkspaceSlug: string | null
  /** 所有 LLM 连接及其认证状态 */
  llmConnections: LlmConnectionWithStatus[]
  /** 当前工作空间的默认 LLM 连接 slug */
  workspaceDefaultLlmConnection?: string
  /** 从配置重新刷新 LLM 连接 */
  refreshLlmConnections: () => Promise<void>
  /** 各会话待处理的权限请求队列（sessionId -> 请求数组） */
  pendingPermissions: Map<string, PermissionRequest[]>
  /** 各会话待处理的凭据请求队列（sessionId -> 请求数组） */
  pendingCredentials: Map<string, CredentialRequest[]>
  /** 读取某个会话的草稿输入文本；从 ref 读取，不会触发重渲染 */
  getDraft: (sessionId: string) => string
  /** 读取某个会话草稿中持久化的附件引用（path + name），不执行文件 IO */
  getDraftAttachmentRefs: (sessionId: string) => import('@craft-agent/shared/config').DraftAttachmentRef[]
  /** 把持久化的附件引用转换成完整的 FileAttachment 对象（异步，会读取文件） */
  hydrateDraftAttachments: (sessionId: string) => Promise<FileAttachment[]>
  /** 当前工作空间所有已启用的 source（由 AppShell 组件提供） */
  enabledSources?: LoadedSource[]
  /** 当前工作空间所有 skill（由 AppShell 组件提供，用于 @mention） */
  skills?: LoadedSkill[]
  /** 当前会话的工作目录，用于项目级 skill 解析 */
  activeSessionWorkingDirectory?: string
  /** 所有标签配置（树形），用于标签菜单和角标展示 */
  labels?: import('@craft-agent/shared/labels').LabelConfig[]
  /** 会话标签变化时的回调 */
  onSessionLabelsChange?: (sessionId: string, labels: string[]) => void
  /**
   * 打开限定到某个任务范围的 All Sessions：用该任务的范围（即用户可在头部 chip 上清除的
   * 标签筛选，以及可选的项目筛选）替换视图当前的筛选条件，并选中该 session。
   * 用于看板磁贴/子任务点击以及创建任务之后。
   */
  onJumpToTaskSessions?: (sessionId: string, scope: { labelId: string; projectId?: string }) => void
  /** 可通过 Shift+Tab 循环切换的权限模式 */
  enabledModes?: PermissionMode[]
  /** 工作空间配置中的动态会话状态（AppShell 提供，默认空数组） */
  sessionStatuses?: SessionStatusConfig[]

  // 统一的会话选项 Map
  /** 所有会话级选项集中放在一个 Map 里；组件推荐用 useSessionOptionsFor() 访问 */
  sessionOptions: Map<string, SessionOptions>

  // 会话相关回调
  onCreateSession: (workspaceId: string, options?: import('../../shared/types').CreateSessionOptions) => Promise<Session>
  onSendMessage: (sessionId: string, message: string, attachments?: FileAttachment[], skillSlugs?: string[], badges?: import('@craft-agent/core').ContentBadge[]) => void
  onRenameSession: (sessionId: string, name: string) => void
  onFlagSession: (sessionId: string) => void
  onUnflagSession: (sessionId: string) => void
  onArchiveSession: (sessionId: string) => void
  onUnarchiveSession: (sessionId: string) => void
  onMarkSessionRead: (sessionId: string) => void
  onMarkSessionUnread: (sessionId: string) => void
  /** 记录用户正在查看哪个会话（用于未读状态机） */
  onSetActiveViewingSession: (sessionId: string) => void
  onSessionStatusChange: (sessionId: string, state: SessionStatus) => void
  onDeleteSession: (sessionId: string, skipConfirmation?: boolean) => Promise<boolean>

  // 权限处理
  onRespondToPermission?: (
    sessionId: string,
    requestId: string,
    allowed: boolean,
    alwaysAllow: boolean,
    options?: import('../../shared/types').PermissionResponseOptions
  ) => void

  // 凭据处理
  onRespondToCredential?: (
    sessionId: string,
    requestId: string,
    response: CredentialResponse
  ) => void

  // 文件/URL 处理：可以在标签页或外部应用中打开
  onOpenFile: (path: string) => void
  onOpenUrl: (url: string) => void

  // 工作空间
  onSelectWorkspace: (id: string, openInNewWindow?: boolean) => void | Promise<void>
  onRefreshWorkspaces?: () => void

  // 应用动作
  onOpenSettings: () => void
  onOpenKeyboardShortcuts: () => void
  onOpenStoredUserPreferences: () => void
  onReset: () => void

  // 统一的会话选项回调
  onSessionOptionsChange: (sessionId: string, updates: SessionOptionUpdates) => void

  // 输入草稿回调
  onInputChange: (sessionId: string, value: string) => void

  // 附件草稿回调：按会话持久化附件引用
  onAttachmentsChange: (sessionId: string, attachments: FileAttachment[]) => void

  // Source 选择回调（按会话），由 AppShell 组件提供
  onSessionSourcesChange?: (sessionId: string, sourceSlugs: string[]) => void

  // 打开新聊天，可指定 agent、名称、预填充输入
  openNewChat?: (params?: NewChatActionParams) => Promise<void>

  // 右侧边栏按钮（用于页面头部）
  rightSidebarButton?: React.ReactNode

  // 面板头部的左侧操作按钮（例如紧凑模式下的返回按钮）
  leadingAction?: React.ReactNode

  /** 当前面板是否是聚焦面板（多面板时用于视觉区分） */
  isFocusedPanel?: boolean

  /** 当前外壳是否处于紧凑/窄屏模式 */
  isCompactMode?: boolean

  // 会话列表搜索状态（用于 ChatDisplay 高亮）
  /** 来自会话列表的当前搜索词，用于 ChatDisplay 中高亮匹配 */
  sessionListSearchQuery?: string
  /** 是否处于搜索模式（即使搜索词为空也阻止焦点自动进入聊天输入框） */
  isSearchModeActive?: boolean
  /** 更新会话列表搜索词的回调 */
  setSessionListSearchQuery?: (query: string) => void
  /** ChatDisplay 的 ref，用于在匹配项之间导航 */
  chatDisplayRef?: React.RefObject<ChatDisplayHandle>
  /** ChatDisplay 匹配信息变化时的回调（用于即时更新 UI） */
  onChatMatchInfoChange?: (info: { sessionId: string | null; count: number; index: number; isHighlighting: boolean }) => void

  // 自动化管理
  /** 按 ID 测试某个自动化：执行动作并返回结果 */
  onTestAutomation?: (automationId: string) => void
  /** 按 ID 切换自动化的启用状态 */
  onToggleAutomation?: (automationId: string) => void
  /** 按 ID 复制某个自动化：克隆配置并加上 " Copy" 后缀 */
  onDuplicateAutomation?: (automationId: string) => void
  /** 按 ID 删除某个自动化：从 automations 配置中移除 */
  onDeleteAutomation?: (automationId: string) => void
  /** 自动化 ID 到最近测试结果的映射 */
  automationTestResults?: Record<string, import('../components/automations/types').TestResult>
  /** 获取某个自动化的执行历史 */
  getAutomationHistory?: (automationId: string) => Promise<import('../components/automations/types').ExecutionEntry[]>
  /** 重新执行失败自动化的 webhook 动作 */
  onReplayAutomation?: (automationId: string, event: string) => void
}

const AppShellContext = createContext<AppShellContextType | null>(null)

export function AppShellProvider({
  children,
  value,
}: {
  children: React.ReactNode
  value: AppShellContextType
}) {
  return <AppShellContext.Provider value={value}>{children}</AppShellContext.Provider>
}

/** 安全版 Hook：没在 Provider 内时返回 null，适用于 playground 等可选消费场景 */
export function useOptionalAppShellContext(): AppShellContextType | null {
  return useContext(AppShellContext)
}

export function useAppShellContext(): AppShellContextType {
  const context = useContext(AppShellContext)
  if (!context) {
    throw new Error('useAppShellContext must be used within an AppShellProvider')
  }
  return context
}

/**
 * 按会话 ID 获取单个会话
 * 使用 sessionAtomFamily 实现“按会话隔离”：只有这个会话变化时才会重渲染，
 * 解决流式输出时整个列表级联更新的问题。
 *
 * Jotai 的 atomFamily 类似一个工厂，每个 sessionId 对应一个独立的小状态单元。
 */
export function useSession(sessionId: string): Session | null {
  // 用 per-session atom 实现独立更新
  return useAtomValue(sessionAtomFamily(sessionId))
}

/**
 * 获取当前激活的工作空间
 */
export function useActiveWorkspace(): Workspace | null {
  const { workspaces, activeWorkspaceId } = useAppShellContext()
  if (!activeWorkspaceId) return null
  return workspaces.find((w) => w.id === activeWorkspaceId) || null
}

/**
 * 获取某个会话队列中的第一个待处理权限请求
 */
export function usePendingPermission(sessionId: string): PermissionRequest | undefined {
  const { pendingPermissions } = useAppShellContext()
  return pendingPermissions.get(sessionId)?.[0]
}

/**
 * 获取某个会话队列中的第一个待处理凭据请求
 */
export function usePendingCredential(sessionId: string): CredentialRequest | undefined {
  const { pendingCredentials } = useAppShellContext()
  return pendingCredentials.get(sessionId)?.[0]
}

/**
 * 获取并更新某个会话的选项
 * 这是组件访问 sessionOptions 的主要方式。
 *
 * 用法：
 *   const { options, setPermissionMode } = useSessionOptionsFor(sessionId)
 *   setPermissionMode('safe')
 */
export function useSessionOptionsFor(sessionId: string): {
  options: SessionOptions
  setOption: <K extends keyof SessionOptions>(key: K, value: SessionOptions[K]) => void
  setOptions: (updates: SessionOptionUpdates) => void
  setPermissionMode: (mode: PermissionMode) => void
  isSafeModeActive: () => boolean
} {
  const { sessionOptions, onSessionOptionsChange } = useAppShellContext()

  // 如果该会话还没有选项，使用默认值
  const options = sessionOptions.get(sessionId) ?? defaultSessionOptions

  // 更新单个选项；泛型 K 保证 key 和 value 类型对应
  const setOption = useCallback(<K extends keyof SessionOptions>(
    key: K,
    value: SessionOptions[K]
  ) => {
    onSessionOptionsChange(sessionId, { [key]: value })
  }, [sessionId, onSessionOptionsChange])

  // 批量更新多个选项
  const setOptions = useCallback((updates: SessionOptionUpdates) => {
    onSessionOptionsChange(sessionId, updates)
  }, [sessionId, onSessionOptionsChange])

  // 专门设置权限模式
  const setPermissionMode = useCallback((mode: PermissionMode) => {
    setOption('permissionMode', mode)
  }, [setOption])

  // 判断当前是否处于安全模式
  const isSafeModeActive = useCallback(() => {
    return options.permissionMode === 'safe'
  }, [options.permissionMode])

  return {
    options,
    setOption,
    setOptions,
    setPermissionMode,
    isSafeModeActive,
  }
}
