/**
 * App
 *
 * Electron renderer 进程的主组件，负责整个应用的生命周期与全局状态管理。
 *
 * 主要职责：
 * - 管理应用状态机：loading → onboarding / workspace-picker → ready
 * - 从 main 进程加载 workspace、session、LLM 连接、主题等数据
 * - 监听并分发 session 事件到 event-processor，同步 React state 与 Jotai atoms
 * - 处理后台任务、权限请求、凭证请求、session 刷新、断线重连恢复
 * - 通过 AppShellContext 向子组件提供统一的上下文与回调
 *
 * 对 Go 同学：可以把 App.tsx 理解为前端应用的“主控制器”，
 * main.tsx 只是入口，App.tsx 才真正协调所有子系统。
 */
import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useTheme } from '@/hooks/useTheme'
import type { ThemeOverrides } from '@config/theme'
import { useSetAtom, useStore, useAtomValue, useAtom } from 'jotai'
import type { Session, Workspace, SessionEvent, Message, FileAttachment, StoredAttachment, PermissionRequest, CredentialRequest, CredentialResponse, SetupNeeds, SessionStatus, NewChatActionParams, ContentBadge, LlmConnectionWithStatus, PermissionModeState } from '../shared/types'
import type { SessionDraft, DraftAttachmentRef } from '@craft-agent/shared/config'
import type { SessionOptions, SessionOptionUpdates } from './hooks/useSessionOptions'
import { defaultSessionOptions, mergeSessionOptions } from './hooks/useSessionOptions'
import { generateMessageId } from '../shared/types'
import { useEventProcessor } from './event-processor'
import type { AgentEvent, Effect } from './event-processor'
import { AppShell } from '@/components/app-shell/AppShell'
import type { AppShellContextType } from '@/context/AppShellContext'
import { OnboardingWizard, ReauthScreen } from '@/components/onboarding'
import { WorkspacePicker } from '@/components/workspace'
import { ResetConfirmationDialog } from '@/components/ResetConfirmationDialog'
import { SplashScreen } from '@/components/SplashScreen'
import { TooltipProvider } from '@craft-agent/ui'
import { FocusProvider } from '@/context/FocusContext'
import { ModalProvider } from '@/context/ModalContext'
import { DismissibleLayerProvider } from '@/context/DismissibleLayerContext'
import { useWindowCloseHandler } from '@/hooks/useWindowCloseHandler'
import { useOnboarding } from '@/hooks/useOnboarding'
import { useNotifications } from '@/hooks/useNotifications'
import { useSession } from '@/hooks/useSession'
import { useUpdateChecker } from '@/hooks/useUpdateChecker'
import { NavigationProvider } from '@/contexts/NavigationContext'
import { navigate, routes } from './lib/navigate'
import { attachmentFromContentRef, toDraftRef } from './lib/drafts'
import { stripMarkdown } from './utils/text'
import { coerceInputText } from './lib/input-text'
import { getSessionsToRefreshAfterStaleReconnect } from './lib/reconnect-recovery'
import { formatSessionLoadFailure, shouldTreatSessionLoadFailureAsTransportFallback } from './lib/session-load'
import { extractWorkspaceSlugFromPath } from '@craft-agent/shared/utils/workspace-slug'
import { DEFAULT_THINKING_LEVEL } from '@craft-agent/shared/agent/thinking-levels'
import { initRendererPerf } from './lib/perf'
import {
  initializeSessionsAtom,
  addSessionAtom,
  removeSessionAtom,
  updateSessionAtom,
  replaceLoadedSessionAtom,
  refreshSessionsMetadataAtom,
  sessionAtomFamily,
  sessionMetaMapAtom,
  sessionIdsAtom,
  loadedSessionsAtom,
  forceSessionMessagesReloadAtom,
  backgroundTasksAtomFamily,
  extractSessionMeta,
  windowWorkspaceIdAtom,
  type SessionMeta,
  type BackgroundTask,
} from '@/atoms/sessions'
import { sourcesAtom } from '@/atoms/sources'
import { skillsAtom } from '@/atoms/skills'
import {
  showBackgroundFinishedChipAtom,
  pushBackgroundFinishedAtom,
} from '@/atoms/background-finished'
import { visibleSessionIdsAtom } from '@/atoms/panel-stack'
import { getSessionTitle } from '@/utils/session'
import { extractBadges } from '@/lib/mentions'
import { getDefaultStore } from 'jotai'
import {
  ShikiThemeProvider,
  PlatformProvider,
  ImagePreviewOverlay,
  PDFPreviewOverlay,
  CodePreviewOverlay,
  DocumentFormattedMarkdownOverlay,
  JSONPreviewOverlay,
} from '@craft-agent/ui'
import { useLinkInterceptor, type FilePreviewState } from '@/hooks/useLinkInterceptor'
import { useTransportConnectionState } from '@/hooks/useTransportConnectionState'
import { useStaleSessionRecovery } from '@/hooks/useStaleSessionRecovery'
import { TransportConnectionBanner, shouldShowTransportConnectionBanner } from '@/components/app-shell/TransportConnectionBanner'
import { getFileManagerName } from '@/lib/platform'
import { rendererLog } from '@/lib/logger'
import { ActionRegistryProvider } from '@/actions'
import { toast } from 'sonner'

/**
 * App 的顶层状态机，决定当前渲染哪个屏幕。
 * 典型流转：应用启动 → 'loading' → 检查 setup needs / workspace：
 *   - 未配置完成 → 'onboarding'（完成引导后 → 'ready'）
 *   - 已配置但没选 workspace（thin client）→ 'workspace-picker'（选完后 → 'ready'）
 *   - 已配置且已选 workspace → 'ready'
 * 完成后停留在 'ready'；'reauth' / reset 会把状态机拉回 'onboarding'。
 * 判定与切换集中在挂载时的 initialize() 里（见 useEffect）。
 */
type AppState =
  | 'loading' // 启动初始化中：正在检查鉴权状态（getSetupNeeds）/ 获取本窗口 workspace ID，渲染 SplashScreen
  | 'onboarding' // 首次使用或配置缺失：引导用户配置 LLM provider / 凭证，渲染 OnboardingWizard
  | 'reauth' // 鉴权过期、需要重新登录：渲染 ReauthScreen（目前流程未启用，保留分支）
  | 'workspace-picker' // 已配置但未选定 workspace（thin client 场景）：让用户选一个 workspace，渲染 WorkspacePicker
  | 'ready' // 一切就绪：渲染主界面 AppShell；数据（sessions 等）在此状态下开始加载


/** useStore() 返回的 Jotai store 类型 */
type JotaiStore = ReturnType<typeof getDefaultStore>

type SessionListRefreshOptions = {
  removeMissing?: boolean
  reason?: string
  selectedSessionId?: string | null
}

const SESSION_REFRESH_LOG_ID_LIMIT = 25

function summarizeIds(ids: Iterable<string>, limit = SESSION_REFRESH_LOG_ID_LIMIT) {
  const all = Array.from(ids)
  return {
    count: all.length,
    ids: all.slice(0, limit),
    truncated: all.length > limit,
  }
}

function workspaceDistribution(sessions: Iterable<{ workspaceId?: string }>): Record<string, number> {
  const distribution: Record<string, number> = {}
  for (const session of sessions) {
    const key = session.workspaceId || '(missing)'
    distribution[key] = (distribution[key] ?? 0) + 1
  }
  return distribution
}

/**
 * 处理来自 agent 的后台任务事件的辅助函数。
 * 根据事件类型更新 backgroundTasksAtomFamily。
 * 抽取出来是为了避免流式与非流式路径之间的代码重复。
 */
function handleBackgroundTaskEvent(
  store: JotaiStore,
  sessionId: string,
  event: { type: string },
  agentEvent: unknown
): void {
  // 用于属性访问的类型守卫
  const evt = agentEvent as Record<string, unknown>
  const backgroundTasksAtom = backgroundTasksAtomFamily(sessionId)

  if (event.type === 'task_backgrounded' && 'taskId' in evt && 'toolUseId' in evt) {
    const currentTasks = store.get(backgroundTasksAtom)
    const exists = currentTasks.some(t => t.toolUseId === evt.toolUseId)
    if (!exists) {
      const isWorkflow = evt.kind === 'workflow'
      store.set(backgroundTasksAtom, [
        ...currentTasks,
        {
          id: evt.taskId as string,
          type: isWorkflow ? ('workflow' as const) : ('agent' as const),
          toolUseId: evt.toolUseId as string,
          startTime: Date.now(),
          elapsedSeconds: 0,
          intent: evt.intent as string | undefined,
          status: 'running' as const,
          ...(isWorkflow ? { workflowId: evt.workflowId as string | undefined, agentsCompleted: 0 } : {}),
        },
      ])
    }
  } else if (event.type === 'workflow_agent_completed' && 'workflowId' in evt) {
    // 一个运行中的 Workflow 的子 agent 完成 —— 给所属 chip 的计数 +1。
    const currentTasks = store.get(backgroundTasksAtom)
    store.set(backgroundTasksAtom, currentTasks.map(t =>
      t.type === 'workflow' && t.workflowId === evt.workflowId
        ? { ...t, agentsCompleted: (t.agentsCompleted ?? 0) + 1 }
        : t
    ))
  } else if (event.type === 'shell_backgrounded' && 'shellId' in evt && 'toolUseId' in evt) {
    const currentTasks = store.get(backgroundTasksAtom)
    const exists = currentTasks.some(t => t.toolUseId === evt.toolUseId)
    if (!exists) {
      store.set(backgroundTasksAtom, [
        ...currentTasks,
        {
          id: evt.shellId as string,
          type: 'shell' as const,
          toolUseId: evt.toolUseId as string,
          startTime: Date.now(),
          elapsedSeconds: 0,
          intent: evt.intent as string | undefined,
          status: 'running' as const,
        },
      ])
    }
  } else if (event.type === 'task_progress' && 'toolUseId' in evt && 'elapsedSeconds' in evt) {
    const currentTasks = store.get(backgroundTasksAtom)
    store.set(backgroundTasksAtom, currentTasks.map(t =>
      t.toolUseId === evt.toolUseId
        ? { ...t, elapsedSeconds: evt.elapsedSeconds as number }
        : t
    ))
  } else if (event.type === 'task_completed' && 'taskId' in evt) {
    // 将 chip 切换为终态状态（保持可见，显示终态图标 + 点击可查看输出）。
    // ActiveTasksBar 的自动过期 ticker 会在短暂停留后清除它 —— 我们不再立即移除，
    // 这样用户能看到任务已完成，而不是 chip 直接消失。
    const status = (evt.status as BackgroundTask['status']) ?? 'completed'
    const currentTasks = store.get(backgroundTasksAtom)
    store.set(backgroundTasksAtom, currentTasks.map(t =>
      t.id === evt.taskId
        ? {
            ...t,
            status,
            completedAt: Date.now(),
            outputFile: (evt.outputFile as string | undefined) ?? t.outputFile,
            summary: (evt.summary as string | undefined) ?? t.summary,
          }
        : t
    ))
  } else if (event.type === 'shell_killed' && 'shellId' in evt) {
    // 将 shell 标记为停止（短暂停留后自动过期），而不是直接消失。
    const currentTasks = store.get(backgroundTasksAtom)
    store.set(backgroundTasksAtom, currentTasks.map(t =>
      t.id === evt.shellId
        ? { ...t, status: 'stopped' as const, completedAt: Date.now() }
        : t
    ))
  } else if (event.type === 'tool_result' && 'toolUseId' in evt) {
    // 任务完成时移除 —— 但如果这是初始后台化的结果则不移除。
    // 后台任务会立即返回 agentId/shell_id/backgroundTaskId，
    // 只有当任务真正完成时才应移除。
    const result = typeof evt.result === 'string' ? evt.result : JSON.stringify(evt.result)
    const isBackgroundingResult = result && (
      /agentId:\s*[a-zA-Z0-9_-]+/.test(result) ||
      /shell_id:\s*[a-zA-Z0-9_-]+/.test(result) ||
      /"backgroundTaskId":\s*"[a-zA-Z0-9_-]+"/.test(result)
    )
    if (!isBackgroundingResult) {
      const currentTasks = store.get(backgroundTasksAtom)
      store.set(backgroundTasksAtom, currentTasks.filter(t => t.toolUseId !== evt.toolUseId))
    }
  } else if (event.type === 'complete' || event.type === 'interrupted' || event.type === 'error') {
    // 孤儿兜底：当一个 turn 结束时，任何仍标记为 'running' 的 chip 都属于某个后台子 agent，
    // 而该子 agent 的 per-turn 子进程正在被销毁 —— 在默认（keep-alive 关闭）模型下，
    // 它几乎肯定已经死了。将其切换为 'orphaned'（视觉上可区分，且会自动过期），
    // 这样任务栏永远不会显示一个虚假的 "running"。这是让任务栏能够重新启用的可靠性修复。
    //
    // WS2 keep-alive：当主进程在 complete 事件中上报 `backgroundTasksAlive` 时，
    // 持久化查询会跨 turn 保持打开，任务确实存活 —— 所以不要在这里把它们标记为孤儿。
    // 它们会保持 'running'，直到收到真正的 `task_completed`（经由 turn 之间的后台 sink 路由）。
    // 如果没有这个保护，agent 仍在工作时 chip 就会谎报 "orphaned"。
    if (evt.backgroundTasksAlive === true) {
      return
    }
    const currentTasks = store.get(backgroundTasksAtom)
    if (currentTasks.some(t => t.status === 'running')) {
      store.set(backgroundTasksAtom, currentTasks.map(t =>
        t.status === 'running'
          ? { ...t, status: 'orphaned' as const, completedAt: Date.now() }
          : t
      ))
    }
  }
}

function SessionLoadErrorScreen({
  message,
  onRetry,
}: {
  message: string
  onRetry: () => void
}) {
  const { t } = useTranslation()

  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="max-w-lg rounded-xl border border-border/50 bg-background shadow-minimal p-6 text-center">
        <h2 className="text-lg font-semibold text-foreground">{t("errors.failedToLoadSessions")}</h2>
        <p className="mt-2 text-sm text-foreground/60">
          {t("errors.failedToLoadSessionsDesc")}
        </p>
        <p className="mt-3 rounded-lg bg-foreground/5 px-3 py-2 text-left text-xs text-foreground/70 break-words">
          {message}
        </p>
        <button
          type="button"
          onClick={onRetry}
          className="mt-4 inline-flex h-8 items-center justify-center rounded-[8px] bg-foreground text-background px-3 text-sm font-medium hover:opacity-90 transition-opacity"
        >
          {t("errors.retryLoadingSessions")}
        </button>
      </div>
    </div>
  )
}

/** App：函数 */
export default function App() {
  const { t } = useTranslation()

  // 尽早初始化 renderer 性能追踪（debug 模式 = 从源码运行）
  // 使用空依赖的 useEffect，在任何 session 切换之前于挂载时运行一次
  useEffect(() => {
    window.electronAPI.isDebugMode().then((isDebug) => {
      initRendererPerf(isDebug)
    })
  }, [])

  // App 状态：loading -> 检查鉴权 -> onboarding 或 ready
  const [appState, setAppState] = useState<AppState>('loading')
  const [setupNeeds, setSetupNeeds] = useState<SetupNeeds | null>(null)

  // 用于隔离更新的 per-session Jotai atom setter
  // 注意：没有 sessionsAtom —— 我们不在任何地方存储 Session[] 数组，以防止内存泄漏。
  // 取而代之，我们使用：
  // - sessionMetaMapAtom：用于轻量级列表
  // - sessionAtomFamily(id)：用于单个 session 数据
  const initializeSessions = useSetAtom(initializeSessionsAtom)
  const addSession = useSetAtom(addSessionAtom)
  const removeSession = useSetAtom(removeSessionAtom)
  const updateSessionDirect = useSetAtom(updateSessionAtom)
  const replaceLoadedSession = useSetAtom(replaceLoadedSessionAtom)
  const store = useStore()

  // 用部分字段按 ID 更新 session 的辅助函数
  // 直接使用 per-session atom，而不是更新整个数组
  const updateSessionById = useCallback((
    sessionId: string,
    updates: Partial<Session> | ((session: Session) => Partial<Session>)
  ) => {
    updateSessionDirect(sessionId, (prev) => {
      if (!prev) return prev
      const partialUpdates = typeof updates === 'function' ? updates(prev) : updates
      return { ...prev, ...partialUpdates }
    })
  }, [updateSessionDirect])

  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  // 窗口的 workspace ID —— 共享 atom，使 Root/ThemeProvider 在切换时保持同步
  const [windowWorkspaceId, setWindowWorkspaceId] = useAtom(windowWorkspaceIdAtom)

  // 推导 workspace slug，用于 SDK skill 资格判定
  const windowWorkspaceSlug = useMemo(() => {
    if (!windowWorkspaceId) return null
    const workspace = workspaces.find(w => w.id === windowWorkspaceId)
    return workspace?.slug ?? windowWorkspaceId
  }, [windowWorkspaceId, workspaces])

  // 从 URL 参数获取初始 sessionId 和 focused 模式（用于「在新窗口打开」功能）
  const { initialSessionId, isFocusedMode } = useMemo(() => {
    const params = new URLSearchParams(window.location.search)
    return {
      initialSessionId: params.get('sessionId'),
      isFocusedMode: params.get('focused') === 'true',
    }
  }, [])

  // 推导远程 workspace ID，供 NavigationContext 做 session 匹配
  const windowRemoteWorkspaceId = useMemo(() => {
    if (!windowWorkspaceId) return null
    const workspace = workspaces.find(w => w.id === windowWorkspaceId)
    return workspace?.remoteServer?.remoteWorkspaceId ?? null
  }, [windowWorkspaceId, workspaces])

  // 带鉴权状态的 LLM 连接（用于选择 provider）
  const [llmConnections, setLlmConnections] = useState<LlmConnectionWithStatus[]>([])
  // workspace 的默认 LLM 连接（用于新 session）
  const [workspaceDefaultLlmConnection, setWorkspaceDefaultLlmConnection] = useState<string | undefined>()
  // 全局默认 LLM 连接 slug（来自 app 配置）
  const [defaultLlmConnectionSlug, setDefaultLlmConnectionSlug] = useState<string | undefined>()

  // 从默认 LLM 连接推导连接的默认 model 覆盖值
  const defaultConnection = useMemo(() => {
    return llmConnections.find(c => c.slug === defaultLlmConnectionSlug) ?? null
  }, [llmConnections, defaultLlmConnectionSlug])

  const [menuNewChatTrigger, setMenuNewChatTrigger] = useState(0)
  // per-session 的权限请求（用队列处理多个并发请求）
  const [pendingPermissions, setPendingPermissions] = useState<Map<string, PermissionRequest[]>>(new Map())
  // per-session 的凭证请求（用队列处理多个并发请求）
  const [pendingCredentials, setPendingCredentials] = useState<Map<string, CredentialRequest[]>>(new Map())
  // per-session 的草稿编辑器状态（文本 + 附件引用），跨模式切换、会话变更
  // 和应用重启保留。使用 ref 可避免输入时触发重渲染；附件以轻量引用
  // （path + name）存储，在 session 切换时通过 readFileAttachment() 水合。
  const sessionDraftsRef = useRef<Map<string, SessionDraft>>(new Map())
  // 所有 session 级设置的统一 session options
  const [sessionOptions, setSessionOptions] = useState<Map<string, SessionOptions>>(new Map())

  // 主题状态（仅 app 级）
  const [appTheme, setAppTheme] = useState<ThemeOverrides | null>(null)
  // 重置确认对话框
  const [showResetDialog, setShowResetDialog] = useState(false)

  // 自动更新状态
  const updateChecker = useUpdateChecker()

  // 启动屏状态 —— 追踪 app 是否完全就绪（所有数据已加载）
  const [sessionsLoaded, setSessionsLoaded] = useState(false)
  const [sessionLoadError, setSessionLoadError] = useState<string | null>(null)
  const [splashExiting, setSplashExiting] = useState(false)
  const [splashHidden, setSplashHidden] = useState(false)

  // 通知启用状态（来自 app 设置）
  const [notificationsEnabled, setNotificationsEnabled] = useState(true)

  // 用于 badge 提取的 sources 和 skills
  const sources = useAtomValue(sourcesAtom)
  const skills = useAtomValue(skillsAtom)

  // 计算 app 是否完全就绪（所有数据已加载）
  const isFullyReady = appState === 'ready' && sessionsLoaded

  // 完全就绪时触发启动屏退出动画
  useEffect(() => {
    if (isFullyReady && !splashExiting) {
      setSplashExiting(true)
    }
  }, [isFullyReady, splashExiting])

  // 启动屏退出动画完成时的处理函数
  const handleSplashExitComplete = useCallback(() => {
    setSplashHidden(true)
  }, [])

  // 通过 hook 应用主题（注入 CSS 变量）
  // shikiTheme 传给 ShikiThemeProvider，以确保在浅色系统模式下
  // dark-only 主题仍能获得正确的语法高亮主题
  const { shikiTheme, isDark } = useTheme({ appTheme })

  // sessionOptions 的 ref，用于在事件处理函数中访问当前值而无需重新注册
  const sessionOptionsRef = useRef(sessionOptions)
  // 让 ref 与 state 保持同步
  useEffect(() => {
    sessionOptionsRef.current = sessionOptions
  }, [sessionOptions])

  const applyPermissionModeState = useCallback((sessionId: string, state: PermissionModeState, source: 'event' | 'reconcile') => {
    setSessionOptions(prev => {
      const next = new Map(prev)
      const current = next.get(sessionId) ?? defaultSessionOptions
      const currentVersion = current.permissionModeVersion ?? -1

      if (state.modeVersion < currentVersion) {
        window.electronAPI.debugLog(
          '[ModeSync] Ignoring stale permission mode update',
          { sessionId, source, incoming: state.modeVersion, current: currentVersion }
        )
        return prev
      }

      if (
        state.modeVersion === currentVersion &&
        current.permissionMode !== state.permissionMode
      ) {
        window.electronAPI.debugLog(
          '[ModeSync] Equal modeVersion with differing mode detected, applying and requesting reconciliation',
          {
            sessionId,
            source,
            modeVersion: state.modeVersion,
            currentMode: current.permissionMode,
            incomingMode: state.permissionMode,
          }
        )
      }

      next.set(sessionId, {
        ...current,
        permissionMode: state.permissionMode,
        permissionModeVersion: state.modeVersion,
      })
      return next
    })
  }, [])

  const reconcilePermissionModeState = useCallback(async (sessionId: string) => {
    try {
      const state = await window.electronAPI.getSessionPermissionModeState(sessionId)
      if (!state) return
      applyPermissionModeState(sessionId, state, 'reconcile')
    } catch (error) {
      window.electronAPI.debugLog('[ModeSync] Failed to reconcile permission mode', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }, [applyPermissionModeState])

  // 事件处理 hook —— 通过纯函数处理所有 agent 事件
  const { processAgentEvent, clearStreamingState } = useEventProcessor()

  const syncSessionOptionsFromSession = useCallback((session: Session) => {
    setSessionOptions(prev => {
      const next = new Map(prev)
      const current = next.get(session.id)
      const merged = {
        ...defaultSessionOptions,
        ...current,
        permissionMode: session.permissionMode ?? defaultSessionOptions.permissionMode,
        thinkingLevel: session.thinkingLevel ?? DEFAULT_THINKING_LEVEL,
      }

      const hasNonDefaultMode = merged.permissionMode !== defaultSessionOptions.permissionMode
      const hasNonDefaultThinking = merged.thinkingLevel !== DEFAULT_THINKING_LEVEL

      if (!hasNonDefaultMode && !hasNonDefaultThinking && merged.permissionModeVersion == null) {
        next.delete(session.id)
      } else {
        next.set(session.id, merged)
      }

      return next
    })
  }, [])

  const refreshSessionFromServer = useCallback(async (sessionId: string): Promise<'refreshed' | 'preserved_stale_messages' | 'failed'> => {
    try {
      const fresh = await window.electronAPI.getSessionMessages(sessionId)
      if (!fresh) return 'failed'

      const prevSession = store.get(sessionAtomFamily(sessionId))
      const preservedStaleMessages = !!prevSession && prevSession.messages.length > 0 && (!fresh.messages || fresh.messages.length === 0)
      const nextSession = preservedStaleMessages
        ? { ...fresh, messages: prevSession.messages }
        : fresh

      clearStreamingState(sessionId)
      replaceLoadedSession(nextSession)
      syncSessionOptionsFromSession(nextSession)
      void reconcilePermissionModeState(sessionId)
      return preservedStaleMessages ? 'preserved_stale_messages' : 'refreshed'
    } catch (err) {
      console.error(`[App] Failed to refresh session ${sessionId}:`, err)
      return 'failed'
    }
  }, [clearStreamingState, replaceLoadedSession, syncSessionOptionsFromSession, reconcilePermissionModeState, store])

  const loadSessionsFromServer = useCallback(async () => {
    setSessionLoadError(null)

    try {
      const loadedSessions = await window.electronAPI.getSessions()

      // 初始化 per-session atoms 和 metadata map
      // 注意：没有使用 sessionsAtom —— session 只存在于 per-session atoms 中
      initializeSessions(loadedSessions)

      // 从 session 数据初始化统一的 sessionOptions
      const optionsMap = new Map<string, SessionOptions>()
      for (const s of loadedSessions) {
        const hasNonDefaultMode = s.permissionMode && s.permissionMode !== 'ask'
        const hasNonDefaultThinking = s.thinkingLevel && s.thinkingLevel !== DEFAULT_THINKING_LEVEL
        if (hasNonDefaultMode || hasNonDefaultThinking) {
          optionsMap.set(s.id, {
            permissionMode: s.permissionMode ?? 'ask',
            thinkingLevel: s.thinkingLevel ?? DEFAULT_THINKING_LEVEL,
          })
        }
      }
      setSessionOptions(optionsMap)

      await Promise.allSettled(
        loadedSessions.map((s) => reconcilePermissionModeState(s.id))
      )

      setSessionsLoaded(true)

      if (initialSessionId && windowWorkspaceId) {
        const session = loadedSessions.find(s => s.id === initialSessionId)
        if (session) {
          navigate(routes.view.allSessions(session.id))
        }
      }
    } catch (err) {
      console.error('[App] Failed to load sessions:', err)
      const transportState = await window.electronAPI.getTransportConnectionState().catch(() => null)

      if (shouldTreatSessionLoadFailureAsTransportFallback(transportState)) {
        console.error('[App] Treating session load failure as transport fallback:', transportState)
        setSessionsLoaded(true)
        setSessionLoadError(null)
        return
      }

      setSessionLoadError(formatSessionLoadFailure(err))
      setSessionsLoaded(true)
    }
  }, [initializeSessions, initialSessionId, reconcilePermissionModeState, windowWorkspaceId])

  const refreshSessionListMetadataFromServer = useCallback(async (options: SessionListRefreshOptions = {}): Promise<Map<string, SessionMeta> | null> => {
    const {
      removeMissing = true,
      reason = 'manual-or-authoritative',
      selectedSessionId = null,
    } = options
    const beforeMetaMap = store.get(sessionMetaMapAtom)
    const beforeIds = new Set(beforeMetaMap.keys())
    const transportState = await window.electronAPI.getTransportConnectionState().catch(() => null)

    try {
      const sessions = await window.electronAPI.getSessions()
      const returnedIds = new Set(sessions.map(s => s.id))
      const missingIds = Array.from(beforeIds).filter(id => !returnedIds.has(id))
      const addedIds = sessions.map(s => s.id).filter(id => !beforeIds.has(id))
      const logPayload = {
        reason,
        removeMissing,
        windowWorkspaceId,
        windowRemoteWorkspaceId,
        selectedSessionId,
        beforeCount: beforeIds.size,
        returnedCount: sessions.length,
        beforeIds: summarizeIds(beforeIds),
        returnedIds: summarizeIds(returnedIds),
        missingIds: summarizeIds(missingIds),
        addedIds: summarizeIds(addedIds),
        beforeWorkspaceIds: workspaceDistribution(beforeMetaMap.values()),
        returnedWorkspaceIds: workspaceDistribution(sessions),
        transportState,
      }

      rendererLog.info('[App] Session list metadata refresh result', logPayload)
      if (!removeMissing && missingIds.length > 0) {
        rendererLog.warn('[App] Non-destructive refresh preserved sessions omitted by getSessions(); this indicates a partial backend response or workspace-context mismatch', logPayload)
      }

      const loadedSessionIds = store.get(loadedSessionsAtom)

      // 单次事务性 atom 写入 —— 所有跨 atom 的变更都在一个 Jotai write 函数内完成，
      // 这样 React 订阅者看到的是一次一致的更新，而不是中间状态。
      const nextMetaMap = store.set(refreshSessionsMetadataAtom, { sessions, loadedSessionIds, removeMissing })

      // 在 atom 事务之后同步 app 级状态（React hooks / 非 atom 相关部分）
      for (const session of sessions) {
        syncSessionOptionsFromSession(session)
      }
      await Promise.allSettled(sessions.map(s => reconcilePermissionModeState(s.id)))

      return nextMetaMap
    } catch (err) {
      rendererLog.error('[App] Failed to refresh session list metadata after reconnect:', {
        reason,
        removeMissing,
        windowWorkspaceId,
        windowRemoteWorkspaceId,
        selectedSessionId,
        beforeCount: beforeIds.size,
        beforeIds: summarizeIds(beforeIds),
        beforeWorkspaceIds: workspaceDistribution(beforeMetaMap.values()),
        transportState,
        error: err,
      })
      return null
    }
  }, [store, syncSessionOptionsFromSession, reconcilePermissionModeState, windowWorkspaceId, windowRemoteWorkspaceId])

  // Stale session 看门狗 —— 捕获 reconnect 协议遗漏的卡住 session
  const { trackSessionActivity } = useStaleSessionRecovery({
    store,
    refreshSessionFromServer,
  })

  const DRAFT_SAVE_DEBOUNCE_MS = 500

  const resolveDefaultConnectionSlug = useCallback((connections: LlmConnectionWithStatus[]) => {
    return connections.find(c => c.isDefault)?.slug ?? connections[0]?.slug
  }, [])

  // 从配置刷新 LLM 连接（在 workspace 切换以及连接更新后调用）
  const refreshLlmConnections = useCallback(async () => {
    const connections = await window.electronAPI.listLlmConnectionsWithStatus()
    setLlmConnections(connections)
    setDefaultLlmConnectionSlug(resolveDefaultConnectionSlug(connections))
    // 同时刷新 workspace 默认值
    if (windowWorkspaceId) {
      const settings = await window.electronAPI.getWorkspaceSettings(windowWorkspaceId)
      setWorkspaceDefaultLlmConnection(settings?.defaultLlmConnection)
    }
  }, [resolveDefaultConnectionSlug, windowWorkspaceId])

  // 处理 onboarding 完成
  const handleOnboardingComplete = useCallback(async () => {
    try {
      // onboarding 之后重新加载 workspaces
      const ws = await window.electronAPI.getWorkspaces()
      if (ws.length > 0) {
        // 原地切换到 workspace（不关闭/重开窗口）
        await window.electronAPI.switchWorkspace(ws[0].id)
        setWindowWorkspaceId(ws[0].id)
        setWorkspaces(ws)
      } else {
        setWorkspaces(ws)
      }
    } catch (error) {
      console.error('[App] Failed to load workspaces after onboarding:', error)
      // 仍然切换到 ready —— app 可以通过 reconnect 恢复
    }
    setAppState('ready')
  }, [])

  // Onboarding hook —— onConfigSaved 在 billing 保存后立即触发，
  // 确保连接状态在向导关闭前更新。
  const onboarding = useOnboarding({
    onComplete: handleOnboardingComplete,
    onConfigSaved: refreshLlmConnections,
    initialSetupNeeds: setupNeeds || undefined,
  })

  // Reauth 登录处理函数 —— 占位（reauth 目前未使用）
  const handleReauthLogin = useCallback(async () => {
    // 重新检查 setup needs
    const needs = await window.electronAPI.getSetupNeeds()
    if (needs.isFullyConfigured) {
      setAppState('ready')
    } else {
      setSetupNeeds(needs)
      setAppState('onboarding')
    }
  }, [])

  // Reauth 重置处理函数 —— 打开重置确认对话框
  const handleReauthReset = useCallback(() => {
    setShowResetDialog(true)
  }, [])

  // 挂载时检查鉴权状态并获取窗口的 workspace ID
  useEffect(() => {
    const initialize = async () => {
      try {
        // 获取这个窗口的 workspace ID（由主进程通过 URL query 参数传入）
        const wsId = await window.electronAPI.getWindowWorkspace()
        setWindowWorkspaceId(wsId)

        const needs = await window.electronAPI.getSetupNeeds()
        setSetupNeeds(needs)

        if (needs.isFullyConfigured) {
          // 如果未选择 workspace（没有 CRAFT_WORKSPACE_ID 的瘦客户端），
          // 在进入主应用前显示 workspace 选择器
          if (!wsId) {
            setAppState('workspace-picker')
          } else {
            setAppState('ready')
          }
        } else {
          // 新用户或需要配置 —— 显示 onboarding
          setAppState('onboarding')
        }
      } catch (error) {
        console.error('Failed to check auth state:', error)
        // 如果检查失败，稳妥起见显示 onboarding
        setAppState('onboarding')
      }
    }

    initialize()
  }, [])

  // Session 选择状态
  const [sessionSelection, setSession] = useSession()

  // 通知系统 —— 显示原生 OS 通知和 badge 计数
  const handleNavigateToSession = useCallback((sessionId: string) => {
    // 通过中央路由导航到 session（使用 allSessions 过滤器）
    navigate(routes.view.allSessions(sessionId))
  }, [])

  const { isWindowFocused, showSessionNotification } = useNotifications({
    workspaceId: windowWorkspaceId,
    // 注意：sessions 已移除 —— hook 现在内部使用 sessionMetaMapAtom，
    // 防止闭包持有完整的消息数组
    onNavigateToSession: handleNavigateToSession,
    enabled: notificationsEnabled,
  })

  // app 就绪时加载 workspaces、sessions、model、通知设置和草稿
  useEffect(() => {
    if (appState !== 'ready') return

    window.electronAPI.getWorkspaces().then(setWorkspaces)
    window.electronAPI.getNotificationsEnabled().then(setNotificationsEnabled).catch(() => {})

    // 针对缺失系统依赖显示可操作的 toast（仅 Windows）
    window.electronAPI.getSystemWarnings().then((warnings) => {
      if (warnings.vcredistMissing) {
        toast.warning(t('toast.vcRedistNotFound'), {
          description: t('toast.vcRedistNotFoundDesc'),
          duration: Infinity,
          action: {
            label: 'Install',
            onClick: () => window.electronAPI.openUrl(warnings.downloadUrl ?? 'https://aka.ms/vs/17/release/vc_redist.x64.exe'),
          },
        })
      }
    }).catch(() => { /* non-fatal startup check */ })
    void loadSessionsFromServer()
    // 加载带鉴权状态的 LLM 连接
    window.electronAPI.listLlmConnectionsWithStatus().then((connections) => {
      setLlmConnections(connections)
      setDefaultLlmConnectionSlug(resolveDefaultConnectionSlug(connections))
    })
    // 将持久化的输入草稿加载到 ref（不需要重渲染）。
    // 此处不读取附件文件 —— 水合在 session 打开时惰性进行，
    // 这样 app 启动不会被读取潜在的大文件所拖延。
    window.electronAPI.getAllDrafts().then((drafts) => {
      if (Object.keys(drafts).length > 0) {
        sessionDraftsRef.current = new Map(Object.entries(drafts))
      }
    })
    // 加载 app 级主题
    window.electronAPI.getAppTheme().then(setAppTheme)
  }, [appState, loadSessionsFromServer, resolveDefaultConnectionSlug])

  // 订阅主题变更事件（theme.json 变更时实时更新）
  useEffect(() => {
    const cleanupApp = window.electronAPI.onAppThemeChange((theme) => {
      setAppTheme(theme)
    })
    return () => {
      cleanupApp()
    }
  }, [])

  // 订阅 LLM 连接变更事件（拉取 model 时实时更新）
  useEffect(() => {
    const cleanup = window.electronAPI.onLlmConnectionsChanged(() => {
      refreshLlmConnections()
    })
    return () => { cleanup() }
  }, [refreshLlmConnections])

  // workspace 变更时刷新 LLM 连接和 workspace 默认值
  useEffect(() => {
    if (windowWorkspaceId) {
      refreshLlmConnections()
    }
  }, [windowWorkspaceId, refreshLlmConnections])

  // 监听 session 事件 —— 使用集中式事件处理器以保证状态转换的一致性
  //
  // 事实源（SOURCE OF TRUTH）逻辑：
  // - 流式期间（atom.isProcessing = true）：Atom 是事实源
  //   所有事件都从 atom 读取并写入 atom，以此保留流式数据。
  // - 非流式期间：React state 是事实源
  //   事件读写 React state，后者通过 useEffect 同步到 atoms。
  // - Handoff 事件（complete、error 等）：结束流式，把 atom 同步回 React state
  //
  // 这比检查事件类型更简单、更健壮 —— 我们只需问
  // 「这个 session 当前正在流式吗？」并据此路由。
  useEffect(() => {
    // Handoff 事件标志着流式结束 —— 需要同步回 React state
    // 同时包含 todo_state_changed，使状态更新立即反映到侧边栏
    // 包含 async_operation，使 session 标题的 shimmer 效果实时更新
    const handoffEventTypes = new Set(['complete', 'error', 'interrupted', 'typed_error', 'session_status_changed', 'session_metadata_changed', 'session_flagged', 'session_unflagged', 'name_changed', 'labels_changed', 'project_id_changed', 'title_generated', 'async_operation'])

    // 处理副作用的辅助函数（两条路径逻辑相同）
    const handleEffects = (effects: Effect[], sessionId: string, eventType: string) => {
      for (const effect of effects) {
        switch (effect.type) {
          case 'permission_request': {
            setPendingPermissions(prevPerms => {
              const next = new Map(prevPerms)
              const existingQueue = next.get(sessionId) || []
              next.set(sessionId, [...existingQueue, effect.request])
              return next
            })

            // 针对需要审批的暂停发送原生通知（与完成通知相同的门控）
            const notifySession = store.get(sessionAtomFamily(sessionId))
            if (notifySession && !notifySession.hidden) {
              const isAdminPrompt = effect.request.type === 'admin_approval'
              const promptBody = isAdminPrompt
                ? `Admin approval required: ${effect.request.appName || effect.request.toolName}`
                : `Permission required: ${effect.request.toolName}`
              showSessionNotification(notifySession, promptBody)
            }
            break
          }
          case 'permission_mode_changed': {
            if (typeof effect.modeVersion === 'number' && effect.changedAt && effect.changedBy) {
              applyPermissionModeState(effect.sessionId, {
                permissionMode: effect.permissionMode,
                modeVersion: effect.modeVersion,
                changedAt: effect.changedAt,
                changedBy: effect.changedBy,
              }, 'event')
            } else {
              // 向后兼容：乐观地应用 mode，然后再对账权威状态。
              setSessionOptions(prevOpts => {
                const next = new Map(prevOpts)
                const current = next.get(effect.sessionId) ?? defaultSessionOptions
                next.set(effect.sessionId, { ...current, permissionMode: effect.permissionMode })
                return next
              })
              void reconcilePermissionModeState(effect.sessionId)
            }
            break
          }
          case 'credential_request': {
            setPendingCredentials(prevCreds => {
              const next = new Map(prevCreds)
              const existingQueue = next.get(sessionId) || []
              next.set(sessionId, [...existingQueue, effect.request])
              return next
            })
            break
          }
          case 'restore_input': {
            // 排队的消息在中断时已从聊天中移除 —— 把它们的文本恢复到输入框。
            // 追加到现有草稿（用户可能已经开始输入）而不是覆盖。
            const existingDraft = sessionDraftsRef.current.get(sessionId)
            const existingText = coerceInputText(existingDraft?.text)
            const restoredText = coerceInputText(effect.text)
            const restored = existingText
              ? `${existingText}\n\n${restoredText}`
              : restoredText
            handleInputChange(sessionId, restored)
            // handleInputChange 更新 ref，但 ChatPage 有自己的 local state。
            // 派发一个自定义事件，让 ChatPage 重新读取草稿。
            window.dispatchEvent(new CustomEvent('craft:restore-input', {
              detail: { sessionId, text: restored },
            }))
            break
          }
          case 'toast_error': {
            toast.error(effect.message, { duration: 5000 })
            break
          }
        }
      }

      // complete 时清除待处理的权限和凭证
      if (eventType === 'complete') {
        setPendingPermissions(prevPerms => {
          if (prevPerms.has(sessionId)) {
            const next = new Map(prevPerms)
            next.delete(sessionId)
            return next
          }
          return prevPerms
        })
        setPendingCredentials(prevCreds => {
          if (prevCreds.has(sessionId)) {
            const next = new Map(prevCreds)
            next.delete(sessionId)
            return next
          }
          return prevCreds
        })
      }
    }

    const cleanup = window.electronAPI.onSessionEvent((event: SessionEvent) => {
      if (!('sessionId' in event)) return

      const sessionId = event.sessionId
      const workspaceId = windowWorkspaceId ?? ''

      // Session 生命周期事件被显式处理（不交给 agent event processor）。
      if (event.type === 'session_created') {
        window.electronAPI.getSessionMessages(sessionId)
          .then((createdSession: Session | null) => {
            if (createdSession) {
              const existingMeta = store.get(sessionMetaMapAtom).has(sessionId)
              if (existingMeta) {
                replaceLoadedSession(createdSession)
              } else {
                addSession(createdSession)
              }
              syncSessionOptionsFromSession(createdSession)
              return
            }
            return window.electronAPI.getSessions().then(initializeSessions)
          })
          .catch((error: unknown) => console.error('Failed to handle session_created event:', error))
        return
      }

      if (event.type === 'session_deleted') {
        removeSession(sessionId)
        return
      }

      const agentEvent = event as unknown as AgentEvent

      // 为 stale session 看门狗追踪活动
      trackSessionActivity(sessionId)

      // compaction 完成时派发 window 事件
      // 这让 FreeFormInput 能在 compaction 之后排队执行 plan 执行消息
      // 注意：markCompactionComplete 在后端（sessions.ts）调用，以确保
      // 即使 compaction 期间发生 CMD+R 也能执行
      if (event.type === 'info' && event.statusType === 'compaction_complete') {
        window.dispatchEvent(new CustomEvent('craft:compaction-complete', {
          detail: { sessionId }
        }))
      }

      // 检查 session 当前是否在流式（atom 是事实源）
      const atomSession = store.get(sessionAtomFamily(sessionId))
      const isStreaming = atomSession?.isProcessing === true
      const isHandoff = handoffEventTypes.has(event.type)

      // 流式期间或 handoff 事件：以 atom 为事实源
      // 这确保流式期间所有事件都能看到完整状态
      if (isStreaming || isHandoff) {
        const currentSession = atomSession ?? null

        // 处理事件
        const { session: updatedSession, effects } = processAgentEvent(
          agentEvent,
          currentSession,
          workspaceId
        )

        // 直接更新 atom（UI 立即看到更新）
        updateSessionDirect(sessionId, () => updatedSession)

        // 处理副作用
        handleEffects(effects, sessionId, event.type)

        // 处理后台任务事件
        handleBackgroundTaskEvent(store, sessionId, event, agentEvent)

        // 对 handoff 事件，更新 metadata map 以供列表显示
        // 注意：没有 sessionsAtom 需要同步 —— atom 和 metadata 才是事实源
        if (isHandoff) {
          // 更新 metadata map
          const metaMap = store.get(sessionMetaMapAtom)
          const newMetaMap = new Map(metaMap)
          newMetaMap.set(sessionId, extractSessionMeta(updatedSession))
          store.set(sessionMetaMapAtom, newMetaMap)

          // complete 时显示通知（当窗口未聚焦时）
          // 跳过隐藏 session（mini-agent session）—— 它们不应触发通知
          if (event.type === 'complete' && !updatedSession.hidden) {
            // 取最后一条 assistant/plan 消息作为预览
            const lastMessage = updatedSession.messages.findLast(
              m => (m.role === 'assistant' || m.role === 'plan') && !m.isIntermediate
            )
            // 去掉 markdown，让 OS 通知显示干净纯文本
            const rawPreview = lastMessage?.content?.substring(0, 200) || undefined
            const preview = rawPreview ? stripMarkdown(rawPreview).substring(0, 100) || undefined : undefined
            showSessionNotification(updatedSession, preview)

            // OS 通知的应用内补充：当一个*后台* session（未在任何打开面板中显示的）
            // 完成时，在聊天上方排队一个 chip。上面的 OS 通知在窗口聚焦时被抑制，
            // 所以那时 chip 是唯一的完成信号。
            if (
              store.get(showBackgroundFinishedChipAtom) &&
              !store.get(visibleSessionIdsAtom).has(sessionId)
            ) {
              store.set(pushBackgroundFinishedAtom, {
                sessionId,
                title: getSessionTitle(updatedSession),
                finishedAt: Date.now(),
              })
            }
          }
        }

        return
      }

      // 非流式：直接使用 per-session atoms（没有 sessionsAtom）
      const currentSession = store.get(sessionAtomFamily(sessionId))

      const { session: updatedSession, effects } = processAgentEvent(
        agentEvent,
        currentSession,
        workspaceId
      )

      // 处理副作用
      handleEffects(effects, sessionId, event.type)

      // 处理后台任务事件
      handleBackgroundTaskEvent(store, sessionId, event, agentEvent)

      // 更新 per-session atom
      updateSessionDirect(sessionId, () => updatedSession)

      // 更新 metadata map
      const metaMap = store.get(sessionMetaMapAtom)
      const newMetaMap = new Map(metaMap)
      newMetaMap.set(sessionId, extractSessionMeta(updatedSession))
      store.set(sessionMetaMapAtom, newMetaMap)
    })

    return cleanup
  }, [
    processAgentEvent,
    trackSessionActivity,
    windowWorkspaceId,
    store,
    updateSessionDirect,
    replaceLoadedSession,
    showSessionNotification,
    initializeSessions,
    addSession,
    removeSession,
    syncSessionOptionsFromSession,
    applyPermissionModeState,
    reconcilePermissionModeState,
  ])

  // Transport 重连恢复 —— 在 stale 重连后刷新 session metadata 以及
  // active/processing session 的内容。
  useEffect(() => {
    const cleanup = window.electronAPI.onReconnected(async (isStale: boolean) => {
      if (!isStale) {
        // 服务器重放了缓冲事件 —— 我们已追上进度，无需处理
        console.info('[App] Reconnected with event replay — no refresh needed')
        return
      }

      console.warn('[App] Stale reconnect — refreshing session metadata and active/processing sessions')

      const refreshedMetaMap = await refreshSessionListMetadataFromServer({
        removeMissing: false,
        reason: 'stale-reconnect',
        selectedSessionId: sessionSelection.selected,
      })
      const metaMap = refreshedMetaMap ?? store.get(sessionMetaMapAtom)
      const refreshIds = getSessionsToRefreshAfterStaleReconnect(metaMap, sessionSelection.selected)

      console.info(`[App] Stale reconnect — refreshing ${refreshIds.length} session(s):`, refreshIds)

      // 只为 active session 以及 metadata 刷新后仍标记为 processing 的 session
      // 刷新完整消息内容。
      for (const sessionId of refreshIds) {
        let refreshResult = await refreshSessionFromServer(sessionId)
        if (refreshResult !== 'refreshed') {
          // 服务器可能需要时间在重连后重启 session 子进程，
          // 或者可能仍在惰性加载 session 消息。
          for (const delay of [2000, 4000]) {
            console.warn(`[App] Retrying session refresh for ${sessionId} after ${delay}ms (${refreshResult})`)
            await new Promise(r => setTimeout(r, delay))
            refreshResult = await refreshSessionFromServer(sessionId)
            if (refreshResult === 'refreshed') break
          }
        }
      }

      // 最终兜底：如果 active session 仍为空，即使该 session 已标记为 loaded，
      // 也强制重新加载。
      if (sessionSelection.selected) {
        const session = store.get(sessionAtomFamily(sessionSelection.selected))
        if (session && (!session.messages || session.messages.length === 0)) {
          console.warn('[App] Active session still has no messages after stale reconnect refresh — forcing message reload')
          await store.set(forceSessionMessagesReloadAtom, sessionSelection.selected)
        } else if (session) {
          console.info(`[App] Stale reconnect recovery complete — active session has ${session.messages?.length ?? 0} messages`)
        }
      }

    })

    return cleanup
  }, [store, sessionSelection.selected, refreshSessionFromServer, refreshSessionListMetadataFromServer])

  // 监听菜单栏事件
  useEffect(() => {
    const unsubNewChat = window.electronAPI.onMenuNewChat(() => {
      setMenuNewChatTrigger(n => n + 1)
    })
    const unsubSettings = window.electronAPI.onMenuOpenSettings(() => {
      handleOpenSettings()
    })
    const unsubShortcuts = window.electronAPI.onMenuKeyboardShortcuts(() => {
      navigate(routes.view.settings('shortcuts'))
    })
    return () => {
      unsubNewChat()
      unsubSettings()
      unsubShortcuts()
    }
  }, [])

  const handleCreateSession = useCallback(async (workspaceId: string, options?: import('../shared/types').CreateSessionOptions): Promise<Session> => {
    const session = await window.electronAPI.createSession(workspaceId, options)
    // 添加到 per-session atom 和 metadata map（没有 sessionsAtom）
    addSession(session)
    syncSessionOptionsFromSession(session)

    return session
  }, [addSession, syncSessionOptionsFromSession])

  // 深链导航在 handleInputChange 定义之后初始化

  const handleDeleteSession = useCallback(async (sessionId: string, skipConfirmation = false): Promise<boolean> => {
    // 删除前显示确认对话框（除非跳过或 session 为空）
    if (!skipConfirmation) {
      // 使用 Jotai store 中的 session metadata 检查 session 是否有任何消息
      // 我们用 store.get() 而不是闭包捕获 sessions，以防止内存泄漏
      // （闭包会持有完整的 sessions 数组及其所有消息）
      const metaMap = store.get(sessionMetaMapAtom)
      const meta = metaMap.get(sessionId)
      // 如果 session 没有 lastFinalMessageId（没有 assistant 回复）且没有 name（在首条用户消息时设置），则视为空
      const isEmpty = !meta || (!meta.lastFinalMessageId && !meta.name)

      if (!isEmpty) {
        const confirmed = await window.electronAPI.showDeleteSessionConfirmation(meta?.name || 'Untitled')
        if (!confirmed) return false
      }
    }

    await window.electronAPI.deleteSession(sessionId)
    // 从 per-session atom 和 metadata map 移除（没有 sessionsAtom）
    removeSession(sessionId)
    return true
  }, [store, removeSession])

  // 空 session 的自动删除处理函数（fire-and-forget，无确认）
  const handleAutoDeleteEmptySession = useCallback((sessionId: string) => {
    window.electronAPI.deleteSession(sessionId)
    removeSession(sessionId)
  }, [removeSession])

  const handleFlagSession = useCallback((sessionId: string) => {
    updateSessionById(sessionId, { isFlagged: true })
    window.electronAPI.sessionCommand(sessionId, { type: 'flag' })
  }, [updateSessionById])

  const handleUnflagSession = useCallback((sessionId: string) => {
    updateSessionById(sessionId, { isFlagged: false })
    window.electronAPI.sessionCommand(sessionId, { type: 'unflag' })
  }, [updateSessionById])

  const handleArchiveSession = useCallback((sessionId: string) => {
    updateSessionById(sessionId, { isArchived: true, archivedAt: Date.now() })
    window.electronAPI.sessionCommand(sessionId, { type: 'archive' })
  }, [updateSessionById])

  const handleUnarchiveSession = useCallback((sessionId: string) => {
    updateSessionById(sessionId, { isArchived: false, archivedAt: undefined })
    window.electronAPI.sessionCommand(sessionId, { type: 'unarchive' })
  }, [updateSessionById])

  /**
   * 设置用户当前正在查看的 session（用于未读状态机）。
   * 在用户导航到某个 session 时调用。主进程据此判断
   * 是否将新的 assistant 消息标记为未读。
   */
  const handleSetActiveViewingSession = useCallback((sessionId: string) => {
    // 乐观 UI 更新：立即清除 hasUnread
    updateSessionById(sessionId, { hasUnread: false })
    // 告知主进程用户正在查看这个 session
    window.electronAPI.sessionCommand(sessionId, { type: 'setActiveViewing', workspaceId: windowWorkspaceId ?? '' })
  }, [updateSessionById, windowWorkspaceId])

  const handleMarkSessionRead = useCallback((sessionId: string) => {
    // 更新 hasUnread 标志（NEW badge 的事实源）
    // 同时更新 lastReadMessageId 以向后兼容
    updateSessionById(sessionId, (s) => {
      const lastFinalId = s.messages.findLast(
        m => (m.role === 'assistant' || m.role === 'plan') && !m.isIntermediate
      )?.id
      return {
        hasUnread: false,
        ...(lastFinalId ? { lastReadMessageId: lastFinalId } : {}),
      }
    })
    window.electronAPI.sessionCommand(sessionId, { type: 'markRead' })
  }, [updateSessionById])

  const handleMarkSessionUnread = useCallback((sessionId: string) => {
    // Set hasUnread flag (primary source of truth for NEW badge)
    updateSessionById(sessionId, { hasUnread: true, lastReadMessageId: undefined })
    window.electronAPI.sessionCommand(sessionId, { type: 'markUnread' })
  }, [updateSessionById])

  const handleSessionStatusChange = useCallback((sessionId: string, state: SessionStatus) => {
    updateSessionById(sessionId, { sessionStatus: state })
    window.electronAPI.sessionCommand(sessionId, { type: 'setSessionStatus', state })
  }, [updateSessionById])

  const handleRenameSession = useCallback((sessionId: string, name: string) => {
    updateSessionById(sessionId, { name })
    window.electronAPI.sessionCommand(sessionId, { type: 'rename', name })
  }, [updateSessionById])

  const handleSendMessage = useCallback(async (sessionId: string, message: string, attachments?: FileAttachment[], skillSlugs?: string[], externalBadges?: ContentBadge[]) => {
    try {
      // 捕获发送前的处理状态，以便我们能把流式中发送标记为
      // queued badge（#616 后续 —— 覆盖 Pi steer 路径，它返回的是
      // status 'accepted' 而非 'queued'）。
      const sendingMidStream = store.get(sessionAtomFamily(sessionId))?.isProcessing === true

      // 第 1 步：存储附件并获取持久化 metadata
      let storedAttachments: StoredAttachment[] | undefined
      let processedAttachments: FileAttachment[] | undefined

      if (attachments?.length) {
        // 将每个附件存储到磁盘（生成缩略图，把 Office 转为 markdown）
        // 使用 allSettled，这样一个失败不会让所有附件都失败
        const storeResults = await Promise.allSettled(
          attachments.map(a => window.electronAPI.storeAttachment(sessionId, a))
        )

        // 过滤成功的存储，对失败的发出警告
        storedAttachments = []
        const successfulAttachments: FileAttachment[] = []
        storeResults.forEach((result, i) => {
          if (result.status === 'fulfilled') {
            storedAttachments!.push(result.value)
            successfulAttachments.push(attachments[i])
          } else {
            console.warn(`Failed to store attachment "${attachments[i].name}":`, result.reason)
          }
        })

        // 就失败的附件通知用户
        const failedCount = storeResults.filter(r => r.status === 'rejected').length
        if (failedCount > 0) {
          console.warn(`${failedCount} attachment(s) failed to store`)
          // 在 session 中添加警告消息，让用户知道部分附件未包含
          const failedNames = attachments
            .filter((_, i) => storeResults[i].status === 'rejected')
            .map(a => a.name)
            .join(', ')
          updateSessionById(sessionId, (s) => ({
            messages: [...s.messages, {
              id: generateMessageId(),
              role: 'warning' as const,
              content: `⚠️ ${failedCount} attachment(s) could not be stored and will not be sent: ${failedNames}`,
              timestamp: Date.now()
            }]
          }))
        }

        // 第 2 步：为 Claude 创建处理后的附件
        // - Office 文件：转换为带 markdown 内容的文本
        // - 其他：使用原始 FileAttachment
        // - 全部：包含 storedPath，让 agent 知道文件存储位置
        // - 已缩放图片：使用 resizedBase64 而非原始大 base64
        processedAttachments = await Promise.all(
          successfulAttachments.map(async (att, i) => {
            const stored = storedAttachments?.[i]
            if (!stored) {
              console.error(`Missing stored attachment at index ${i}`)
              return att // 回退到原始附件
            }
            // 为所有附件类型包含 storedPath 和 markdownPath
            // agent 会用 Read 工具通过这些路径访问 text/office 文件
            // 如果图片被缩放过，对 Claude API 使用缩放后的 base64
            return {
              ...att,
              storedPath: stored.storedPath,
              markdownPath: stored.markdownPath,
              // 如果可用则使用缩放后的 base64（针对超过大小限制的图片）
              base64: stored.resizedBase64 ?? att.base64,
            }
          })
        )
      }

      // 第 3 步：从 mentions（sources/skills）提取带内嵌图标的 badge
      // badge 是自包含的，用于在 UserMessageBubble 和 viewer 中显示
      // 与任何外部提供的 badge（例如来自 EditPopover context badge）合并
      // 用 workspace slug（而非 UUID）做 skill 资格判定 —— SDK 期望 "workspaceSlug:skillSlug"
      const mentionBadges: ContentBadge[] = windowWorkspaceSlug
        ? extractBadges(message, skills, sources, windowWorkspaceSlug)
        : []
      const badges: ContentBadge[] = [...(externalBadges || []), ...mentionBadges]

      // 第 4.1 步：检测 SDK slash 命令（如 /compact）并创建 command badge
      // 这让 /compact 渲染为内联 badge，而不是原始文本
      const commandMatch = message.match(/^\/([a-z]+)(\s|$)/i)
      if (commandMatch && commandMatch[1].toLowerCase() === 'compact') {
        const commandText = commandMatch[0].trimEnd() // "/compact"，去掉尾部空格
        badges.unshift({
          type: 'command',
          label: 'Compact',
          rawText: commandText,
          start: 0,
          end: commandText.length,
        })
      }

      // 第 4.2 步：检测 plan 执行消息并创建 file badge
      // 模式："Read the plan at <path> and execute it."
      // 这在压缩后接受 plan 时发送，显示为可点击的 file badge
      // 只有文件路径被替换为 badge —— 周围文本保持可见
      const planExecuteMatch = message.match(/^(Read the plan at )(.+?)( and execute it\.?)$/i)
      if (planExecuteMatch) {
        const prefix = planExecuteMatch[1]      // "Read the plan at "
        const filePath = planExecuteMatch[2]    // 实际路径
        const fileName = filePath.split('/').pop() || 'plan.md'
        badges.push({
          type: 'file',
          label: fileName,
          rawText: filePath,
          filePath: filePath,
          start: prefix.length,
          end: prefix.length + filePath.length,
        })
      }

      // 第 5 步：用 StoredAttachments 创建用户消息（供 UI 显示）
      // 标记为 isPending 以支持乐观 UI —— 将由 user_message 事件确认。
      // 把流式中发送标记为 queued，使气泡立即以虚线草稿样式渲染。
      // 对两种后端都适用：
      // Pi steer（服务器发出 status: 'accepted'，但 renderer 在该更新中
      // 保留 isQueued）和 Claude 队列（服务器发出 'queued' 加以确认）。
      // 由 'processing' 状态或当前 turn 结束时清除。
      const userMessage: Message = {
        id: generateMessageId(),
        role: 'user',
        content: message,
        timestamp: Date.now(),
        attachments: storedAttachments,
        badges: badges.length > 0 ? badges : undefined,
        isPending: true,  // 乐观 —— 将由后端确认
        isQueued: sendingMidStream,
      }

      // 乐观 UI 更新 —— 添加用户消息并设置处理状态
      updateSessionById(sessionId, (s) => ({
        messages: [...s.messages, userMessage],
        isProcessing: true,
        lastMessageAt: Date.now()
      }))

      // 第 6 步：发送给 Claude，附带处理后的附件 + 用于持久化的存储附件
      await window.electronAPI.sendMessage(sessionId, message, processedAttachments, storedAttachments, {
        skillSlugs,
        badges: badges.length > 0 ? badges : undefined,
        optimisticMessageId: userMessage.id,
      })
    } catch (error) {
      console.error('Failed to send message:', error)
      updateSessionById(sessionId, (s) => ({
        isProcessing: false,
        messages: [
          ...s.messages,
          {
            id: generateMessageId(),
            role: 'error' as const,
            content: `Failed to send message: ${error instanceof Error ? error.message : 'Unknown error'}`,
            timestamp: Date.now()
          }
        ]
      }))
    }
  }, [sessionOptions, updateSessionById, skills, sources, windowWorkspaceId])

  /**
   * 所有 session option 变更的统一处理函数。
   * 为每种 option 类型处理持久化和后端同步。
   */
  const handleSessionOptionsChange = useCallback((sessionId: string, updates: SessionOptionUpdates) => {
    setSessionOptions(prev => {
      const next = new Map(prev)
      const current = next.get(sessionId) ?? defaultSessionOptions
      next.set(sessionId, mergeSessionOptions(current, updates))
      return next
    })

    // 为特定 option 处理持久化/后端
    if (updates.permissionMode !== undefined) {
      // 把 permission mode 变更同步到后端
      window.electronAPI.sessionCommand(sessionId, { type: 'setPermissionMode', mode: updates.permissionMode })
    }
    if (updates.thinkingLevel !== undefined) {
      // 把 thinking level 变更同步到后端（session 级，持久化）
      window.electronAPI.sessionCommand(sessionId, { type: 'setThinkingLevel', level: updates.thinkingLevel })
    }
  }, [sessionOptions])

  // 处理 per-session 的输入草稿变更，带去抖持久化
  const draftSaveTimeoutRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  // 卸载时清理草稿保存定时器，防止内存泄漏
  useEffect(() => {
    return () => {
      draftSaveTimeoutRef.current.forEach(clearTimeout)
      draftSaveTimeoutRef.current.clear()
    }
  }, [])

  // 草稿文本的 getter —— 从 ref 读取，不触发重渲染
  const getDraft = useCallback((sessionId: string): string => {
    const draft = sessionDraftsRef.current.get(sessionId) as unknown
    const text = draft && typeof draft === 'object'
      ? (draft as { text?: unknown }).text
      : draft
    return coerceInputText(text)
  }, [])

  // 持久化附件引用的 getter（仅 path + name —— 不是已水合的文件）。
  // 需要 FileAttachment 对象的调用方应调用 hydrateDraftAttachments。
  const getDraftAttachmentRefs = useCallback((sessionId: string): DraftAttachmentRef[] => {
    const attachments = sessionDraftsRef.current.get(sessionId)?.attachments
    return Array.isArray(attachments) ? attachments : []
  }, [])

  // 把持久化的附件引用水合为完整的 FileAttachment 对象。
  //  - Track C（ref.content 已设置）：直接从内联字节重建。
  //  - Track P（仅 path）：通过 readUserAttachment RPC 从磁盘重新读取。
  // Track P 上缺失/移动的文件会静默丢弃并发出 console warn ——
  // 与任何其他编辑器在底层文件不存在时恢复草稿的 UX 相同。
  const hydrateDraftAttachments = useCallback(async (sessionId: string): Promise<FileAttachment[]> => {
    const attachments = sessionDraftsRef.current.get(sessionId)?.attachments
    const refs = Array.isArray(attachments) ? attachments : []
    if (refs.length === 0) return []
    const results = await Promise.all(
      refs.map(async (ref) => {
        if (ref.content) {
          return attachmentFromContentRef(ref)
        }
        try {
          const attachment = await window.electronAPI.readUserAttachment(ref.path)
          if (!attachment) {
            console.warn('[drafts] Attachment missing on restore, dropping:', ref.path)
            return null
          }
          return attachment
        } catch (err) {
          console.warn('[drafts] Failed to restore attachment, dropping:', ref.path, err)
          return null
        }
      })
    )
    return results.filter((a): a is FileAttachment => a !== null)
  }, [])

  // 把当前 ref 条目的去抖快照写入磁盘。
  const schedulePersistDraft = useCallback((sessionId: string) => {
    const existingTimeout = draftSaveTimeoutRef.current.get(sessionId)
    if (existingTimeout) {
      clearTimeout(existingTimeout)
    }
    const timeout = setTimeout(() => {
      const draft = sessionDraftsRef.current.get(sessionId) ?? { text: '' }
      window.electronAPI.setDraft(sessionId, draft)
      draftSaveTimeoutRef.current.delete(sessionId)
    }, DRAFT_SAVE_DEBOUNCE_MS)
    draftSaveTimeoutRef.current.set(sessionId, timeout)
  }, [])

  const handleInputChange = useCallback((sessionId: string, value: string) => {
    const text = coerceInputText(value)
    const existing = sessionDraftsRef.current.get(sessionId)
    const existingAttachments = Array.isArray(existing?.attachments) ? existing.attachments : []
    const nextDraft: SessionDraft = {
      text,
      ...(existingAttachments.length > 0
        ? { attachments: existingAttachments }
        : {}),
    }
    const isEmpty = !nextDraft.text && (!nextDraft.attachments || nextDraft.attachments.length === 0)
    if (isEmpty) {
      sessionDraftsRef.current.delete(sessionId)
    } else {
      sessionDraftsRef.current.set(sessionId, nextDraft)
    }
    schedulePersistDraft(sessionId)
  }, [schedulePersistDraft])

  const handleAttachmentsChange = useCallback((sessionId: string, attachments: FileAttachment[]) => {
    const existing = sessionDraftsRef.current.get(sessionId)
    const refs: DraftAttachmentRef[] = []
    for (const a of attachments) {
      const ref = toDraftRef(a)
      if (ref) {
        refs.push(ref)
      } else {
        console.warn('[drafts] attachment exceeds per-draft size cap, not persisted:', a.name, a.size)
      }
    }
    const nextDraft: SessionDraft = {
      text: coerceInputText(existing?.text),
      ...(refs.length > 0 ? { attachments: refs } : {}),
    }
    const isEmpty = !nextDraft.text && (!nextDraft.attachments || nextDraft.attachments.length === 0)
    if (isEmpty) {
      sessionDraftsRef.current.delete(sessionId)
    } else {
      sessionDraftsRef.current.set(sessionId, nextDraft)
    }
    schedulePersistDraft(sessionId)
  }, [schedulePersistDraft])

  // 打开新聊天 —— 创建 session 并选中它
  // 由组件通过 AppShellContext 使用，也用于编程式导航
  const openNewChat = useCallback(async (params: NewChatActionParams = {}) => {
    if (!windowWorkspaceId) {
      console.warn('[App] Cannot open new chat: no workspace ID')
      return
    }

    const session = await handleCreateSession(windowWorkspaceId)

    if (params.name) {
      await window.electronAPI.sessionCommand(session.id, { type: 'rename', name: params.name })
    }

    // 导航到聊天视图 —— 这会同时设置 selectedSession 和 activeView
    navigate(routes.view.allSessions(session.id))

    // 如果提供了输入则预填充（加一点延迟以确保组件已挂载）
    if (params.input) {
      setTimeout(() => handleInputChange(session.id, params.input!), 100)
    }
  }, [windowWorkspaceId, handleCreateSession, handleInputChange])

  const handleRespondToPermission = useCallback(async (
    sessionId: string,
    requestId: string,
    allowed: boolean,
    alwaysAllow: boolean,
    options?: import('../shared/types').PermissionResponseOptions,
  ) => {
    const success = await window.electronAPI.respondToPermission(sessionId, requestId, allowed, alwaysAllow, options)

    if (success) {
      // 只从队列移除第一个权限（即我们刚响应的那个）
      setPendingPermissions(prev => {
        const next = new Map(prev)
        const queue = next.get(sessionId) || []
        const remainingQueue = queue.slice(1) // 移除第一项
        if (remainingQueue.length === 0) {
          next.delete(sessionId)
        } else {
          next.set(sessionId, remainingQueue)
        }
        return next
      })
      // 注意：无需强制刷新 session —— per-session atoms 会自动更新
    } else {
      // 响应失败（agent/session 已不存在）—— 仍清除该权限，
      // 避免 UI 卡在过期的权限请求上
      setPendingPermissions(prev => {
        const next = new Map(prev)
        const queue = next.get(sessionId) || []
        const remainingQueue = queue.slice(1)
        if (remainingQueue.length === 0) {
          next.delete(sessionId)
        } else {
          next.set(sessionId, remainingQueue)
        }
        return next
      })
    }
  }, [])

  const handleRespondToCredential = useCallback(async (sessionId: string, requestId: string, response: CredentialResponse) => {
    const success = await window.electronAPI.respondToCredential(sessionId, requestId, response)

    if (success) {
      // 只从队列移除第一个凭证（即我们刚响应的那个）
      setPendingCredentials(prev => {
        const next = new Map(prev)
        const queue = next.get(sessionId) || []
        const remainingQueue = queue.slice(1) // 移除第一项
        if (remainingQueue.length === 0) {
          next.delete(sessionId)
        } else {
          next.set(sessionId, remainingQueue)
        }
        return next
      })
      // 注意：无需强制刷新 session —— per-session atoms 会自动更新
    } else {
      // 响应失败（agent/session 已不存在）—— 仍清除该凭证，
      // 避免 UI 卡在过期的凭证请求上
      setPendingCredentials(prev => {
        const next = new Map(prev)
        const queue = next.get(sessionId) || []
        const remainingQueue = queue.slice(1)
        if (remainingQueue.length === 0) {
          next.delete(sessionId)
        } else {
          next.set(sessionId, remainingQueue)
        }
        return next
      })
    }
  }, [])

  // 集中式链接拦截器：分类文件类型，并决定是显示应用内预览 overlay
  // 还是外部打开。取代了旧的、总是用外部应用打开的
  // handleOpenFile/handleOpenUrl。
  const linkInterceptor = useLinkInterceptor({
    openFileExternal: async (path) => {
      try {
        await window.electronAPI.openFile(path)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        console.error('Failed to open file:', error)
        toast.error(t('toast.failedToOpenFile'), {
          description: message,
        })
      }
    },
    openUrl: async (url) => {
      try {
        await window.electronAPI.openUrl(url)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        console.error('Failed to open URL:', error)
        // 被拦截 URL 的分类器已经解释了原因，并且（对 file:）
        // 会把用户指引到预览块。当消息已携带该指引时，
        // 不要再追加通用的「改用 Open File」提示。
        const hasRichGuidance = /URL blocked/.test(message)
        const tail = hasRichGuidance ? '' : '. If this is a local path, use Open File instead.'
        toast.error(t('toast.failedToOpenLink'), {
          description: `${message}${tail}`,
        })
      }
    },
    showInFolder: async (path) => {
      try {
        await window.electronAPI.showInFolder(path)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        console.error('Failed to show in folder:', error)
        toast.error(t("toast.failedToReveal", { fileManager: getFileManagerName() }), {
          description: message,
        })
      }
    },
    readFile: (path) => window.electronAPI.readFile(path),
    readFileDataUrl: (path) => window.electronAPI.readFileDataUrl(path),
    readFileBinary: (path) => window.electronAPI.readFileBinary(path),
  })

  const connectionState = useTransportConnectionState()
  const showTransportConnectionBanner = shouldShowTransportConnectionBanner(connectionState)

  const handleReconnectTransport = useCallback(() => {
    void window.electronAPI.reconnectTransport().catch((error) => {
      const message = error instanceof Error ? error.message : 'Unknown error'
      toast.error(t('toast.reconnectFailed'), { description: message })
    })
  }, [])

  const handleOpenFile = linkInterceptor.handleOpenFile
  const handleOpenUrl = linkInterceptor.handleOpenUrl

  const handleOpenSettings = useCallback(() => {
    navigate(routes.view.settings())
  }, [])

  const handleOpenKeyboardShortcuts = useCallback(() => {
    navigate(routes.view.settings('shortcuts'))
  }, [])

  const handleOpenStoredUserPreferences = useCallback(() => {
    navigate(routes.view.settings('preferences'))
  }, [])

  // 显示重置确认对话框
  const handleReset = useCallback(() => {
    setShowResetDialog(true)
  }, [])

  // 用户在对话框确认后执行重置
  const executeReset = useCallback(async () => {
    try {
      await window.electronAPI.logout()
      // 重置所有状态
      // 清除 session atoms —— 用空数组初始化会清除所有 per-session atoms
      initializeSessions([])
      setWorkspaces([])
      setWindowWorkspaceId(null)
      // 重置 setupNeeds，强制重新开始 onboarding
      setSetupNeeds({
        needsBillingConfig: true,
        needsCredentials: true,
        isFullyConfigured: false,
      })
      // 重置 onboarding hook 状态
      onboarding.reset()
      setAppState('onboarding')
    } catch (error) {
      console.error('Reset failed:', error)
    } finally {
      setShowResetDialog(false)
    }
  }, [onboarding, initializeSessions])

  // 处理 workspace 选择
  // - 默认：在同一窗口切换 workspace（窗口内切换）
  // - 带 openInNewWindow=true：在新窗口打开（或聚焦已有窗口）
  const handleSelectWorkspace = useCallback(async (workspaceId: string, openInNewWindow = false) => {
    // 如果选择的是当前 workspace，什么都不做
    if (workspaceId === windowWorkspaceId) return

    if (openInNewWindow) {
      // 打开（或聚焦）所选 workspace 的窗口
      window.electronAPI.openWorkspace(workspaceId)
    } else {
      // 在当前窗口切换 workspace
      // 1. 更新主进程的 window-workspace 映射
      await window.electronAPI.switchWorkspace(workspaceId)

      // 2. 更新 React state 以触发重渲染
      setWindowWorkspaceId(workspaceId)

      // 3. 清除选中的 session —— 旧 session 属于前一个 workspace，
      // 切换到新 workspace 时不应保持选中。这避免显示来自错误 workspace 的过期 session 数据。
      setSession({ selected: null })

      // 4. 清除待处理的权限/凭证（与新 workspace 无关）
      setPendingPermissions(new Map())
      setPendingCredentials(new Map())

      // 5. 清除前一个 workspace 的 session options
      // （session ID 是唯一 UUID，但清除可防止无界内存增长，
      // 并确保旧 workspace 的过期状态不残留）
      setSessionOptions(new Map())

      // 6. 清除前一个 workspace 的消息草稿
      // （防止反复切换 workspace 时的内存增长）
      sessionDraftsRef.current.clear()

      // 7. 把 sources 和 skills atoms 重置为空
      // （防止 workspace 切换时的过期数据闪烁 —— AppShell 会重新加载）
      store.set(sourcesAtom, [])
      store.set(skillsAtom, [])

      // 8. 在 workspace 切换之前清除 session atoms
      // 这避免前一个 workspace 的过期 session 数据被看到。
      store.set(sessionMetaMapAtom, new Map())
      store.set(sessionIdsAtom, [])

      // 注意：NavigationContext 检测到 workspaceId 变更，并从存储的
      // workspace URL 处理面板恢复（或默认到 allSessions）。
      // Sessions 和 theme 会由于 useEffect hook 中的 windowWorkspaceId 依赖而自动重新加载。
    }
  }, [windowWorkspaceId, setSession, store])

  // 按 slug 处理 workspace 切换（由 NavigationContext 在 ?ws= 变化的 popstate 时调用）
  const handleSwitchWorkspaceBySlug = useCallback((slug: string) => {
    const target = workspaces.find(w => w.slug === slug)
    if (target) {
      handleSelectWorkspace(target.id)
    }
  }, [workspaces, handleSelectWorkspace])

  // 处理 workspace 刷新（例如上传图标后）
  const handleRefreshWorkspaces = useCallback(() => {
    window.electronAPI.getWorkspaces().then(setWorkspaces)
  }, [])

  // 处理 onboarding 期间的取消
  const handleOnboardingCancel = useCallback(() => {
    onboarding.handleCancel()
  }, [onboarding])

  // 为 AppShell 组件构建 context value
  // 这个值做了 memoize，以防止不必要的重渲染
  // 重要：必须放在早返回之前，以保持 hook 顺序一致
  const appShellContextValue = useMemo<AppShellContextType>(() => ({
    // 数据
    // 注意：不含 sessions —— 列表用 sessionMetaMapAtom，
    // 单个 session 用 useSession(id) hook。这可防止内存泄漏。
    workspaces,
    activeWorkspaceId: windowWorkspaceId,
    activeWorkspaceSlug: windowWorkspaceSlug,
    llmConnections,
    workspaceDefaultLlmConnection,
    refreshLlmConnections,
    pendingPermissions,
    pendingCredentials,
    getDraft,
    getDraftAttachmentRefs,
    hydrateDraftAttachments,
    sessionOptions,
    // Session 回调
    onCreateSession: handleCreateSession,
    onSendMessage: handleSendMessage,
    onRenameSession: handleRenameSession,
    onFlagSession: handleFlagSession,
    onUnflagSession: handleUnflagSession,
    onArchiveSession: handleArchiveSession,
    onUnarchiveSession: handleUnarchiveSession,
    onMarkSessionRead: handleMarkSessionRead,
    onMarkSessionUnread: handleMarkSessionUnread,
    onSetActiveViewingSession: handleSetActiveViewingSession,
    onSessionStatusChange: handleSessionStatusChange,
    onDeleteSession: handleDeleteSession,
    onRespondToPermission: handleRespondToPermission,
    onRespondToCredential: handleRespondToCredential,
    // 文件/URL 处理函数
    onOpenFile: handleOpenFile,
    onOpenUrl: handleOpenUrl,
    // Workspace
    onSelectWorkspace: handleSelectWorkspace,
    onRefreshWorkspaces: handleRefreshWorkspaces,
    // App 操作
    onOpenSettings: handleOpenSettings,
    onOpenKeyboardShortcuts: handleOpenKeyboardShortcuts,
    onOpenStoredUserPreferences: handleOpenStoredUserPreferences,
    onReset: handleReset,
    // Session options
    onSessionOptionsChange: handleSessionOptionsChange,
    onInputChange: handleInputChange,
    onAttachmentsChange: handleAttachmentsChange,
    // 新聊天（通过深链导航）
    openNewChat,
  }), [
    // 注意：sessions 已移除以防内存泄漏 —— 组件改用 atoms
    workspaces,
    windowWorkspaceId,
    windowWorkspaceSlug,
    llmConnections,
    workspaceDefaultLlmConnection,
    refreshLlmConnections,
    pendingPermissions,
    pendingCredentials,
    getDraft,
    getDraftAttachmentRefs,
    hydrateDraftAttachments,
    sessionOptions,
    handleCreateSession,
    handleSendMessage,
    handleRenameSession,
    handleFlagSession,
    handleUnflagSession,
    handleArchiveSession,
    handleUnarchiveSession,
    handleMarkSessionRead,
    handleMarkSessionUnread,
    handleSetActiveViewingSession,
    handleSessionStatusChange,
    handleDeleteSession,
    handleRespondToPermission,
    handleRespondToCredential,
    handleOpenFile,
    handleOpenUrl,
    handleSelectWorkspace,
    handleRefreshWorkspaces,
    handleOpenSettings,
    handleOpenKeyboardShortcuts,
    handleOpenStoredUserPreferences,
    handleReset,
    handleSessionOptionsChange,
    handleInputChange,
    handleAttachmentsChange,
    openNewChat,
  ])

  // 供 @craft-agent/ui 组件（overlay 等）使用的平台操作
  // 做了 memoize，在这些回调不变时防止重渲染
  // 注意：必须放在早返回之前，以保持 hook 顺序一致
  const platformActions = useMemo(() => ({
    onOpenFile: handleOpenFile,
    onOpenUrl: handleOpenUrl,
    // 绕过链接拦截器 —— 直接在系统编辑器中打开文件。
    // 由 overlay header badge 使用（当已在查看某文件时，「打开」应启动编辑器）。
    onOpenFileExternal: linkInterceptor.openFileExternal,
    // 以 UTF-8 字符串读取文件内容（供 datatable/spreadsheet/html-preview 的 src 字段使用）
    onReadFile: (path: string) => window.electronAPI.readFile(path),
    // 以 data URL 读取文件（供图片预览块使用）
    onReadFileDataUrl: (path: string) => window.electronAPI.readFileDataUrl(path),
    // 以二进制 Uint8Array 读取文件（供 PDF 预览块使用）
    onReadFileBinary: (path: string) => window.electronAPI.readFileBinary(path),
    // 在系统文件管理器中显示文件（macOS 的 Finder、Windows 的 Explorer 等）
    onRevealInFinder: (path: string) => {
      window.electronAPI.showInFolder(path).catch(() => {})
    },
    // 平台相关的文件管理器名称，用于 UI 标签
    fileManagerName: getFileManagerName(),
    // 全屏 overlay 打开时隐藏/显示 macOS 交通灯按钮
    onSetTrafficLightsVisible: (visible: boolean) => {
      window.electronAPI.setTrafficLightsVisible(visible)
    },
  }), [handleOpenFile, handleOpenUrl, linkInterceptor.openFileExternal])

  // Loading 状态 —— 显示启动屏
  if (appState === 'loading') {
    return <SplashScreen isExiting={false} />
  }

  // Reauth 状态 —— session 过期，需要重新登录
  // ModalProvider + WindowCloseHandler 确保 Windows 上 X 按钮可用
  if (appState === 'reauth') {
    return (
      <DismissibleLayerProvider>
        <ModalProvider>
          <WindowCloseHandler />
          <ReauthScreen
            onLogin={handleReauthLogin}
            onReset={handleReauthReset}
          />
          <ResetConfirmationDialog
            open={showResetDialog}
            onConfirm={executeReset}
            onCancel={() => setShowResetDialog(false)}
          />
        </ModalProvider>
      </DismissibleLayerProvider>
    )
  }

  // Onboarding 状态
  // ModalProvider + WindowCloseHandler 确保 Windows 上 X 按钮可用
  // （没有这个，关闭 IPC 消息没有监听者，窗口会保持打开）
  if (appState === 'onboarding') {
    return (
      <DismissibleLayerProvider>
        <ModalProvider>
          <WindowCloseHandler />
          <OnboardingWizard
            state={onboarding.state}
            onContinue={onboarding.handleContinue}
            onBack={onboarding.handleBack}
            onSelectProvider={onboarding.handleSelectProvider}
            onSkipSetup={onboarding.handleSkipSetup}
            onSelectApiSetupMethod={onboarding.handleSelectApiSetupMethod}
            onSubmitCredential={onboarding.handleSubmitCredential}
            onSubmitLocalModel={onboarding.handleSubmitLocalModel}
            onStartOAuth={onboarding.handleStartOAuth}
            onFinish={onboarding.handleFinish}
            isWaitingForCode={onboarding.isWaitingForCode}
            onSubmitAuthCode={onboarding.handleSubmitAuthCode}
            onCancelOAuth={onboarding.handleCancelOAuth}
            copilotDeviceCode={onboarding.copilotDeviceCode}
            onBrowseGitBash={onboarding.handleBrowseGitBash}
            onUseGitBashPath={onboarding.handleUseGitBashPath}
            onRecheckGitBash={onboarding.handleRecheckGitBash}
            onClearError={onboarding.handleClearError}
          />
        </ModalProvider>
      </DismissibleLayerProvider>
    )
  }

  // Workspace 选择器 —— 未选择 workspace 的瘦客户端
  if (appState === 'workspace-picker') {
    return (
      <DismissibleLayerProvider>
        <ModalProvider>
          <WindowCloseHandler />
          <WorkspacePicker
            onSelectWorkspace={async (id) => {
              await window.electronAPI.switchWorkspace(id)
              setWindowWorkspaceId(id)
              setAppState('ready')
            }}
          />
        </ModalProvider>
      </DismissibleLayerProvider>
    )
  }

  // 在退出动画完成前一直显示启动屏
  const showSplash = !splashHidden

  // Ready 状态 —— 主应用，数据加载期间带启动屏 overlay
  return (
    <PlatformProvider actions={platformActions}>
    <ShikiThemeProvider shikiTheme={shikiTheme}>
      <ActionRegistryProvider>
      <FocusProvider>
        <DismissibleLayerProvider>
        <ModalProvider>
        <TooltipProvider delayDuration={0}>
        <NavigationProvider
          workspaceId={windowWorkspaceId}
          workspaceSlug={windowWorkspaceSlug}
          onSwitchWorkspaceBySlug={handleSwitchWorkspaceBySlug}
          onCreateSession={handleCreateSession}
          onInputChange={handleInputChange}
          getDraft={getDraft}
          onAutoDeleteEmptySession={handleAutoDeleteEmptySession}
          isReady={appState === 'ready'}
          isSessionsReady={sessionsLoaded}
          remoteWorkspaceId={windowRemoteWorkspaceId}
        >
          {/* 处理窗口关闭请求（X 按钮、Cmd+W）—— 若有打开的 modal 先关闭 */}
          <WindowCloseHandler />

          {/* 启动屏 overlay —— 完全就绪时淡出 */}
          {showSplash && (
            <SplashScreen
              isExiting={splashExiting}
              onExitComplete={handleSplashExitComplete}
            />
          )}

          {/* 主 UI —— 始终渲染，启动屏淡出后显露出来 */}
          <div
            className="h-full flex flex-col text-foreground"
            style={{ paddingTop: 'var(--topbar-height)' }}
          >
            {showTransportConnectionBanner && connectionState && (
              <TransportConnectionBanner
                state={connectionState}
                onRetry={handleReconnectTransport}
              />
            )}
            <div className="flex-1 min-h-0">
              {sessionLoadError ? (
                <SessionLoadErrorScreen
                  message={sessionLoadError}
                  onRetry={() => { void loadSessionsFromServer() }}
                />
              ) : (
                <AppShell
                  contextValue={appShellContextValue}
                  defaultLayout={[20, 32, 48]}
                  menuNewChatTrigger={menuNewChatTrigger}
                  isFocusedMode={isFocusedMode}
                />
              )}
            </div>
            <ResetConfirmationDialog
              open={showResetDialog}
              onConfirm={executeReset}
              onCancel={() => setShowResetDialog(false)}
            />
          </div>

          {/* 文件预览 overlay —— 当点击可预览文件时由链接拦截器渲染 */}
          {linkInterceptor.previewState && (
            <FilePreviewRenderer
              state={linkInterceptor.previewState}
              onClose={linkInterceptor.closePreview}
              loadDataUrl={linkInterceptor.readFileDataUrl}
              loadPdfData={linkInterceptor.readFileBinary}
              isDark={isDark}
            />
          )}
        </NavigationProvider>
        </TooltipProvider>
        </ModalProvider>
        </DismissibleLayerProvider>
      </FocusProvider>
      </ActionRegistryProvider>
    </ShikiThemeProvider>
    </PlatformProvider>
  )
}

/**
 * 处理窗口关闭请求的组件。
 * 必须位于 ModalProvider 内部，以访问 modal registry。
 */
function WindowCloseHandler() {
  useWindowCloseHandler()
  return null
}

/**
 * FilePreviewRenderer —— 把文件预览状态路由到正确的 overlay 组件。
 *
 * 处理来自链接拦截器的所有预览类型：
 * - image → ImagePreviewOverlay（二进制，经 data URL 加载）
 * - pdf → PDFPreviewOverlay（二进制，经 Chromium 查看器嵌入）
 * - code/text → CodePreviewOverlay（语法高亮）
 * - markdown → DocumentFormattedMarkdownOverlay
 * - json → JSONPreviewOverlay
 *
 * 带「打开」/「在 {文件管理器} 中显示」菜单的文件路径 badge
 * 由 PlatformContext 自动提供 —— 无需为每个 overlay 单独传 callback props。
 */
function FilePreviewRenderer({
  state,
  onClose,
  loadDataUrl,
  loadPdfData,
  isDark,
}: {
  state: FilePreviewState
  onClose: () => void
  loadDataUrl: (path: string) => Promise<string>
  loadPdfData: (path: string) => Promise<Uint8Array>
  isDark: boolean
}) {
  const theme = isDark ? 'dark' : 'light' as const

  switch (state.type) {
    case 'image':
      return (
        <ImagePreviewOverlay
          isOpen
          onClose={onClose}
          filePath={state.filePath}
          loadDataUrl={loadDataUrl}
          theme={theme}
        />
      )

    case 'pdf':
      return (
        <PDFPreviewOverlay
          isOpen
          onClose={onClose}
          filePath={state.filePath}
          loadPdfData={loadPdfData}
          theme={theme}
        />
      )

    case 'code':
    case 'text':
      return (
        <CodePreviewOverlay
          isOpen
          onClose={onClose}
          filePath={state.filePath}
          content={state.content ?? ''}
          language={state.type === 'code' ? state.language : 'plaintext'}
          mode="read"
          theme={theme}
          error={state.error}
        />
      )

    case 'markdown': {
      // 对 plans 文件夹中的 .md 文件显示 PLAN 头部（同时处理绝对和相对路径）
      const isPlanFile =
        (state.filePath.includes('/plans/') || state.filePath.startsWith('plans/')) &&
        state.filePath.endsWith('.md')
      return (
        <DocumentFormattedMarkdownOverlay
          isOpen
          onClose={onClose}
          content={state.content ?? ''}
          filePath={state.filePath}
          variant={isPlanFile ? 'plan' : 'response'}
        />
      )
    }

    case 'json': {
      // JSONPreviewOverlay 期望的是解析后的数据，而非原始字符串。
      // @uiw/react-json-view 遇到 null 值会崩溃，因此要加以保护。
      let parsedData: unknown = null
      try {
        if (state.content) parsedData = JSON.parse(state.content)
      } catch {
        // 如果解析失败，回退为以代码形式显示
        return (
          <CodePreviewOverlay
            isOpen
            onClose={onClose}
            filePath={state.filePath}
            content={state.content ?? ''}
            language="json"
            mode="read"
            theme={theme}
            error={state.error}
          />
        )
      }
      // 如果读取失败且内容为空，显示带读取错误的原始代码 overlay。
      if ((!state.content || !state.content.trim()) && state.error) {
        return (
          <CodePreviewOverlay
            isOpen
            onClose={onClose}
            filePath={state.filePath}
            content={state.content ?? ''}
            language="json"
            mode="read"
            theme={theme}
            error={state.error}
          />
        )
      }
      return (
        <JSONPreviewOverlay
          isOpen
          onClose={onClose}
          filePath={state.filePath}
          title={state.filePath.split('/').pop() ?? 'JSON'}
          data={parsedData}
          theme={theme}
          error={state.error}
        />
      )
    }

    default:
      return null
  }
}
