/**
 * 文件：session-manager-interface.ts
 * 位置：packages/server-core/src/handlers
 * 职责：定义会话生命周期引擎 ISessionManager 的抽象接口。
 *
 * 架构角色：
 *   - server-core 的 handler 只依赖该接口；具体实现由 Electron SessionManager、headless 等提供。
 *   - 这是 Agent 系统的“心脏”接口，覆盖会话 CRUD、消息收发、权限、计划、导入导出等。
 *   - 类似 Go 中定义一个巨大的 service interface，由不同运行时实现。
 *
 * Agent 开发关注点：
 *   - Session 是 Agent 运行的上下文：包含历史消息、工具状态、权限模式、模型连接等。
 *   - PermissionMode 决定 Agent 执行 tool 时是否需要用户确认（类似 Android 权限弹窗）。
 *   - 计划（plan）功能允许 Agent 先提出执行计划，用户确认后再执行。
 *   - executePromptAutomation 用于自动化/调度器场景：给定 prompt 自动创建 session 并运行。
 */

import type { Workspace, WorkspaceInfo, ActiveSessionInfo } from '@craft-agent/core/types'
import type { StoredAttachment, AnnotationV1 } from '@craft-agent/core/types'
import type { PermissionMode } from '@craft-agent/shared/agent/mode-types'
import type { ThinkingLevel } from '@craft-agent/shared/agent/thinking-levels'
import type { AuthResult } from '@craft-agent/shared/agent'
import type {
  Session,
  SessionStatus,
  CreateSessionOptions,
  FileAttachment,
  SendMessageOptions,
  PermissionResponseOptions,
  CredentialResponse,
  PermissionModeState,
  UnreadSummary,
  ShareResult,
} from '@craft-agent/shared/protocol'
import type { SessionBundle, DispatchMode } from '@craft-agent/shared/sessions'
import type { EventSink } from '../transport'

/**
 * 会话管理器接口。
 *
 * TS 特性：
 *   - 大量 `type` 导入，说明本文件只使用这些类型的形状，不依赖它们的运行时值。
 *   - 方法签名中的 `?` 表示可选参数；接口末尾 `setAutomationBinder?` 表示可选方法，
 *     实现类可以不提供。
 *   - 某些方法返回 `Promise<T>`，表示异步操作；调用处通常用 await。
 */
export interface ISessionManager {
  // ---------------------------------------------------------------------------
  // 生命周期
  // ---------------------------------------------------------------------------

  /** 等待初始化完成；未就绪时 handler 应阻塞。 */
  waitForInit(): Promise<void>
  /** 初始化会话管理器。 */
  initialize(): Promise<void>
  /** 清理资源。 */
  cleanup(): void
  /** 设置事件接收器，用于向客户端推送事件。 */
  setEventSink(sink: EventSink): void
  /** 刷出所有会话的挂起写入。 */
  flushAllSessions(): Promise<void>

  // ---------------------------------------------------------------------------
  // Session 增删改查（CRUD）
  // ---------------------------------------------------------------------------

  /** 获取会话列表；传入 workspaceId 则只返回该工作区。 */
  getSessions(workspaceId?: string): Session[]
  getSession(sessionId: string): Promise<Session | null>
  /** Creates a session and (unless `internal.emitCreatedEvent === false`) announces it to the
   *  renderer so it hydrates full metadata instead of fabricating a "New Chat" placeholder. */
  createSession(
    workspaceId: string,
    options?: CreateSessionOptions,
    internal?: { emitCreatedEvent?: boolean },
  ): Promise<Session>
  /** Resolved working directory of a live session (Tasks Conductor uses it so children inherit
   *  the orchestrator's cwd). */
  getSessionWorkingDirectory(sessionId: string): string | undefined
  deleteSession(sessionId: string): Promise<void>

  // ---------------------------------------------------------------------------
  // Session 状态管理
  // ---------------------------------------------------------------------------

  flagSession(sessionId: string): Promise<void>
  unflagSession(sessionId: string): Promise<void>
  archiveSession(sessionId: string): Promise<void>
  unarchiveSession(sessionId: string): Promise<void>
  renameSession(sessionId: string, name: string): Promise<void>
  setSessionStatus(sessionId: string, status: SessionStatus): Promise<void>
  markSessionRead(sessionId: string): Promise<void>
  markSessionUnread(sessionId: string): Promise<void>
  markAllSessionsRead(workspaceId: string): Promise<void>
  /** 标记当前用户正在查看的 session。 */
  setActiveViewingSession(sessionId: string | null, workspaceId: string): void
  clearActiveViewingSession(workspaceId: string): void

  // ---------------------------------------------------------------------------
  // Session 配置项
  // ---------------------------------------------------------------------------

  /** 设置会话的权限模式（如 allow-all、ask-every-time、explore）。 */
  setSessionPermissionMode(sessionId: string, mode: PermissionMode): void
  setSessionThinkingLevel(sessionId: string, level: ThinkingLevel): void
  updateWorkingDirectory(sessionId: string, path: string): void
  setSessionSources(sessionId: string, sourceSlugs: string[]): Promise<void>
  setSessionLabels(sessionId: string, labels: string[]): void
  /** Apply the reserved Task labeling (mint / inherit the per-task item label under the Task
   *  root). Returns the resolved ITEM label id, or undefined if the session is unknown.
   *  See SessionManager.applyTaskLabel. */
  applyTaskLabel(
    sessionId: string,
    opts?: { parentSessionId?: string },
  ): Promise<{ labelId: string } | undefined>
  setSessionProjectId(sessionId: string, projectId: string | null): Promise<void>
  setKanbanColumn(sessionId: string, column: string | null): Promise<void>
  setTaskNodeCount(sessionId: string, count: number): Promise<void>
  adoptGeneratedTaskOrchestrator(
    sessionId: string,
    taskSlug: string,
    reconcile?: { name?: string; projectId?: string; workingDirectory?: string; model?: string; llmConnection?: string; permissionMode?: PermissionMode },
  ): Promise<boolean>
  bindExistingSessionToTask(
    sessionId: string,
    taskSlug: string,
    reconcile?: { name?: string; projectId?: string; workingDirectory?: string; model?: string; llmConnection?: string; permissionMode?: PermissionMode },
  ): Promise<boolean>
  setSessionConnection(sessionId: string, connectionSlug: string): Promise<void>
  updateSessionModel(sessionId: string, workspaceId: string, model: string | null, connection?: string): Promise<void>

  // ---------------------------------------------------------------------------
  // 消息收发
  // ---------------------------------------------------------------------------

  /**
   * 向会话发送用户消息。
   *
   * 参数较多，注意可选参数：
   *   - attachments / storedAttachments：上传的文件或已持久化的附件。
   *   - options：发送选项（如是否静默、是否来自 gateway）。
   *   - existingMessageId：重试/替换已有消息。
   *   - onAck：消息确认回调。
   *   - rpcContext：RPC 调用上下文，用于追踪 callerClientId。
   */
  sendMessage(
    sessionId: string,
    message: string,
    attachments?: FileAttachment[],
    storedAttachments?: StoredAttachment[],
    options?: SendMessageOptions,
    existingMessageId?: string,
    _isAuthRetry?: boolean,
    onAck?: (messageId: string) => void,
    rpcContext?: { callerClientId?: string },
  ): Promise<void>
  cancelProcessing(sessionId: string, silent?: boolean): Promise<void>
  killShell(sessionId: string, shellId: string): Promise<{ success: boolean; error?: string }>
  getTaskOutput(taskId: string): Promise<string | null>

  // --- Tasks Conductor seams (in-process; not renderer events, not agent-facing) ---
  /**
   * Subscribe to the in-process session-completion signal. Fires once per turn
   * when the session's message queue drains (true completion), carrying the stop
   * reason. Returns an unsubscribe function.
   */
  onSessionComplete(
    listener: (evt: import('../sessions/SessionManager').SessionCompletionEvent) => void,
  ): () => void
  /** Read a session's final assistant message text (Conductor output reader). */
  getSessionFinalText(sessionId: string): string | undefined
  addMessageAnnotation(sessionId: string, messageId: string, annotation: AnnotationV1): void
  removeMessageAnnotation(sessionId: string, messageId: string, annotationId: string): void
  updateMessageAnnotation(
    sessionId: string,
    messageId: string,
    annotationId: string,
    patch: Partial<AnnotationV1>,
  ): void

  // ---------------------------------------------------------------------------
  // 权限与凭证
  // ---------------------------------------------------------------------------

  /**
   * 响应权限请求。
   * allowed：是否允许；alwaysAllow：是否记住选择不再询问。
   */
  respondToPermission(
    sessionId: string,
    requestId: string,
    allowed: boolean,
    alwaysAllow: boolean,
    options?: PermissionResponseOptions,
  ): boolean
  respondToCredential(sessionId: string, requestId: string, response: CredentialResponse): Promise<boolean>
  getSessionPermissionModeState(sessionId: string): PermissionModeState | null

  // ---------------------------------------------------------------------------
  // 计划（Plan）
  // ---------------------------------------------------------------------------

  setPendingPlanExecution(sessionId: string, planPath: string, draftInputSnapshot?: string): Promise<void>
  markPendingPlanExecutionDispatched(sessionId: string): Promise<void>
  clearPendingPlanExecution(sessionId: string): Promise<void>
  getPendingPlanExecution(sessionId: string): { planPath: string; draftInputSnapshot?: string; awaitingCompaction: boolean; executionDispatched: boolean } | null
  markCompactionComplete(sessionId: string): Promise<void>

  /**
   * 接受计划并执行。
   * 对桌面 UI 的“Accept plan”按钮和 Telegram/WhatsApp 的 accept 按钮提供统一服务端语义。
   * 如果会话处于 Explore（安全）模式，会切换为 allow-all 以避免逐 tool 弹窗。
   */
  acceptPlan(sessionId: string, planPath?: string): Promise<void>

  // ---------------------------------------------------------------------------
  // 分享
  // ---------------------------------------------------------------------------

  shareToViewer(sessionId: string): Promise<ShareResult>
  updateShare(sessionId: string): Promise<ShareResult>
  revokeShare(sessionId: string): Promise<ShareResult>

  // ---------------------------------------------------------------------------
  // 导出 / 导入
  // ---------------------------------------------------------------------------

  /**
   * 导出会话为可移植 bundle。
   * 会先刷出挂起写入，再序列化会话数据 + 文件。
   * 要求会话必须先停止。
   */
  exportSession(sessionId: string, workspaceId: string): Promise<SessionBundle | null>

  /**
   * 导出会话为基于摘要的跨服务器传输载荷。
   * 生成 mini-model 摘要，而不是发送完整对话记录。
   */
  exportRemoteSessionTransfer(
    sessionId: string,
    workspaceId: string,
  ): Promise<import('@craft-agent/shared/protocol').RemoteSessionTransferPayload | null>

  /**
   * 导入会话 bundle 到目标 workspace。
   * 创建 session 目录、写入 JSONL 和文件、注册到内存。
   * 返回新 session ID 和兼容性警告。
   */
  importSession(
    workspaceId: string,
    bundle: SessionBundle,
    mode: DispatchMode,
  ): Promise<{ sessionId: string; warnings?: string[] }>

  /**
   * 导入基于摘要的远程传输载荷。
   */
  importRemoteSessionTransfer(
    workspaceId: string,
    payload: import('@craft-agent/shared/protocol').RemoteSessionTransferPayload,
  ): Promise<import('@craft-agent/shared/protocol').ImportRemoteSessionTransferResult>

  // ---------------------------------------------------------------------------
  // 工具方法
  // ---------------------------------------------------------------------------

  getSessionPath(sessionId: string): string | null
  refreshTitle(sessionId: string): Promise<{ success: boolean; title?: string; error?: string }>
  refreshBadge(): void
  getUnreadSummary(): UnreadSummary

  // ---------------------------------------------------------------------------
  // Workspace 管理
  // ---------------------------------------------------------------------------

  getWorkspaces(): Workspace[]
  /** 返回客户端安全的工作区列表（去掉 rootPath）给远程客户端使用。 */
  getWorkspacesInfo(): WorkspaceInfo[]
  setupConfigWatcher(workspaceRootPath: string, workspaceId: string): void
  /**
   * 手动通知 ConfigWatcher 文件变化。
   *  临时解决方案：Bun 在 Linux 上的 fs.watch 检测不到原子重命名。
   */
  notifyConfigFileChange(workspaceRootPath: string, relativePath: string): void

  // ---------------------------------------------------------------------------
  // 服务器级可观测性
  // ---------------------------------------------------------------------------

  /** 有活跃后端进程的 session 数量。传入 workspaceId 可按工作区过滤。 */
  getActiveSessionCount(workspaceId?: string): number
  /** 某 workspace 的自动化摘要（已配置自动化数量 + 调度器状态）。 */
  getWorkspaceAutomationSummary(workspaceId: string): { automationCount: number; schedulerRunning: boolean }
  /** 所有 workspace 中有运行后端进程的 session 列表。 */
  getActiveSessionsInfo(): ActiveSessionInfo[]

  // ---------------------------------------------------------------------------
  // 认证
  // ---------------------------------------------------------------------------

  reinitializeAuth(connectionSlug?: string): Promise<void>
  /**
   * 把运行时更新（如能力开关）推送到所有使用该连接的活动 session。
   * 由 getOrCreateAgent 里的懒刷新路径兜底。
   */
  refreshConnectionRuntime(connectionSlug: string): Promise<void>
  completeAuthRequest(sessionId: string, result: AuthResult): Promise<void>
  executePromptAutomation(input: ExecutePromptAutomationInput): Promise<{ sessionId: string }>

  /**
   * 安装一个回调：当 executePromptAutomation 创建 session 且 matcher 声明了 telegramTopic 后调用。
   * 由 messaging-gateway 引导时注入，避免 SessionManager 直接引用 messaging 包造成循环依赖。
   *
   * 回调必须是“尽力而为”：失败不能阻塞 session。
   *
   * TS 特性：方法名后的 `?` 表示可选方法，实现类可以不提供。
   */
  setAutomationBinder?(
    fn: (input: { workspaceId: string; sessionId: string; topicName: string }) => Promise<void>,
  ): void
}

/**
 * executePromptAutomation 的输入参数。
 *
 * 设计演进：参数变多后从位置参数改为 options object，
 * 后续新增可选字段（thinkingLevel、cwd、权限覆盖等）不需要修改每个调用点。
 *
 * TS 特性：
 *   - 接口里大量 `?` 字段表示可选配置。
 *   - `telegramTopic` 与 messaging gateway 集成：当设置且 workspace 已配对超级群时，
 *     新 session 会被绑定到同名 topic（首次创建）。
 */
export interface ExecutePromptAutomationInput {
  workspaceId: string
  workspaceRootPath: string
  prompt: string
  labels?: string[]
  permissionMode?: PermissionMode
  mentions?: string[]
  llmConnection?: string
  model?: string
  /** 覆盖 workspace 默认的思考深度。 */
  thinkingLevel?: ThinkingLevel
  automationName?: string
  /**
   * 可选 Telegram forum topic 名称。
   * 设置且 workspace 已配对超级群时，新 session 会被绑定到该名称的 topic（首次自动创建）。
   * 前提不满足时静默忽略。
   */
  telegramTopic?: string
  /**
   * When `false`, `executePromptAutomation` returns as soon as the session is
   * created and the prompt is dispatched, instead of awaiting the whole turn.
   * Used by the automation **Test** action so a long run (tools / >30s output)
   * doesn't trip the RPC client timeout (craft-agents-oss#943). The session
   * still streams live and run errors are logged. Defaults to awaiting completion.
   */
  waitForCompletion?: boolean
}
