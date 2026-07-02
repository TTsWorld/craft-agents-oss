/**
 * 事件处理器类型定义
 *
 * 定义集中式事件处理器所需的状态和事件类型。
 * 所有 Agent 事件都通过同一个纯函数处理，以保证状态转换一致。
 */

// import type 只导入类型，编译后不会生成真正的 import 语句，和 Go 的类型导入概念类似
import type { Session, Message, PermissionRequest, CredentialRequest, TypedError, PermissionMode, SessionStatus, AuthRequest, ToolDisplayMeta } from '../../shared/types'

/**
 * 流式状态：替代旧的 streamingTextRef，用于暂存尚未完成的消息片段
 *
 * export interface 表示这是一个对外暴露的结构类型，类似 Go 里的 exported struct。
 */
export interface StreamingState {
  content: string
  turnId?: string
  parentToolUseId?: string
}

/**
 * 完整的会话状态：把持久化的 Session 和临时的流式状态组合在一起
 */
export interface SessionState {
  session: Session
  streaming: StreamingState | null
}

/**
 * 文本片段事件：服务端持续推送的流式文本内容
 */
export interface TextDeltaEvent {
  type: 'text_delta'
  sessionId: string
  delta: string
  turnId?: string
}

/**
 * 文本完成事件：流式文本结束，把累积内容落盘为正式消息
 */
export interface TextCompleteEvent {
  type: 'text_complete'
  sessionId: string
  text: string
  turnId?: string
  isIntermediate?: boolean
  parentToolUseId?: string
  /** 主进程提供的时间戳，用于与会话持久化文件 session.jsonl 保持顺序一致 */
  timestamp?: number
  /** 主进程提供的权威消息 ID，保证持久化/分支一致性 */
  messageId?: string
}

/**
 * 工具开始事件：标识某个工具开始执行
 * 字段命名与 shared/types.ts 中的 SessionEvent 保持一致
 */
export interface ToolStartEvent {
  type: 'tool_start'
  sessionId: string
  toolUseId: string
  toolName: string
  toolInput?: Record<string, unknown>
  /** 主进程提供的时间戳，用于排序 */
  timestamp?: number
  turnId?: string
  parentToolUseId?: string
  toolIntent?: string
  toolDisplayName?: string
  /** 工具的展示元数据，包含 base64 图标，保证 viewer 端兼容 */
  toolDisplayMeta?: ToolDisplayMeta
}

/**
 * 工具结果事件：标识某个工具执行完成并返回结果
 */
export interface ToolResultEvent {
  type: 'tool_result'
  sessionId: string
  toolUseId: string
  toolName?: string
  result: string
  isError?: boolean
  turnId?: string
  parentToolUseId?: string
  /** 主进程提供的时间戳，用于排序 */
  timestamp?: number
}

/**
 * 完成事件：Agent 一轮循环结束
 */
export interface CompleteEvent {
  type: 'complete'
  sessionId: string
  tokenUsage?: Session['tokenUsage']
  /** 是否未读：由主进程根据窗口是否处于活跃状态决定 */
  hasUnread?: boolean
  /**
   * WS2 keep-alive: true when the session's persistent query stays open across
   * turns (`CRAFT_KEEP_BG_AGENTS_ALIVE`). When set, the turn ending does NOT tear
   * down background sub-agents — so the chip orphan-backstop must NOT fire on this
   * `complete`; a real `task_completed` will arrive when the agent actually finishes.
   */
  backgroundTasksAlive?: boolean
}

/**
 * 错误事件：Agent 运行过程中出现普通错误
 */
export interface ErrorEvent {
  type: 'error'
  sessionId: string
  error: string
  code?: string
  title?: string
  details?: string
  original?: string
  /** 主进程提供的时间戳，用于排序 */
  timestamp?: number
}

/**
 * 权限请求事件
 * 形状与 shared/types.ts 中的 SessionEvent 保持一致
 */
export interface PermissionRequestEvent {
  type: 'permission_request'
  sessionId: string
  request: PermissionRequest
}

/**
 * 来源变更事件：会话启用的知识源/工具源列表发生变化
 */
export interface SourcesChangedEvent {
  type: 'sources_changed'
  sessionId: string
  enabledSourceSlugs: string[]
}

/**
 * 标签变更事件
 */
export interface LabelsChangedEvent {
  type: 'labels_changed'
  sessionId: string
  labels: string[]
}

/**
 * 项目 ID 变更事件：会话绑定/解绑到某个 workspace 项目
 */
export interface ProjectIdChangedEvent {
  type: 'project_id_changed'
  sessionId: string
  projectId: string | null
}

/**
 * 会话状态变更事件：外部元数据变更或 Agent 工具触发
 */
export interface SessionStatusChangedEvent {
  type: 'session_status_changed'
  sessionId: string
  sessionStatus?: string
}

/**
 * 会话元数据变更事件 —— 用于程序化元数据写入（taskNodeCount、kanbanColumn）的
 * 通用实时推送，这些写入不走 header 签名文件监听路径。
 */
export interface SessionMetadataChangedEvent {
  type: 'session_metadata_changed'
  sessionId: string
  changes: Partial<Pick<Session, 'taskNodeCount' | 'kanbanColumn' | 'taskDraft' | 'taskSlug' | 'projectId'>>
}

/**
 * 会话标星/取消标星事件：外部元数据变更
 */
export interface SessionFlaggedEvent {
  type: 'session_flagged'
  sessionId: string
}

export interface SessionUnflaggedEvent {
  type: 'session_unflagged'
  sessionId: string
}

/**
 * 会话归档/取消归档事件：外部元数据变更
 */
export interface SessionArchivedEvent {
  type: 'session_archived'
  sessionId: string
}

export interface SessionUnarchivedEvent {
  type: 'session_unarchived'
  sessionId: string
}

/**
 * 会话名称变更事件：外部元数据变更
 */
export interface NameChangedEvent {
  type: 'name_changed'
  sessionId: string
  name?: string
}

/**
 * 计划提交事件：Agent 把思考计划以消息形式加入会话
 */
export interface PlanSubmittedEvent {
  type: 'plan_submitted'
  sessionId: string
  message: Message
}

/**
 * 结构化错误事件
 */
export interface TypedErrorEvent {
  type: 'typed_error'
  sessionId: string
  error: TypedError
  /** 主进程提供的时间戳，用于排序 */
  timestamp?: number
}

/**
 * 状态事件：用于显示“压缩中”等状态
 */
export interface StatusEvent {
  type: 'status'
  sessionId: string
  message: string
  statusType?: 'compacting'
  /** 主进程提供的时间戳，用于排序 */
  timestamp?: number
}

/**
 * 信息事件：普通提示信息
 */
export interface InfoEvent {
  type: 'info'
  sessionId: string
  message: string
  statusType?: 'compaction_complete'
  level?: 'info' | 'warning' | 'error' | 'success'
  /** 主进程提供的时间戳，用于排序 */
  timestamp?: number
}

/**
 * 中断事件：Agent 被中断
 */
export interface InterruptedEvent {
  type: 'interrupted'
  sessionId: string
  message?: Message
  /** 已排队但尚未处理的消息文本：需要恢复到输入框中 */
  queuedMessages?: string[]
}

/**
 * 标题生成完成事件
 */
export interface TitleGeneratedEvent {
  type: 'title_generated'
  sessionId: string
  title: string
  preview?: string  // 第一条用户消息的预览，侧边栏标题回退用
}

/**
 * 标题正在生成事件：表示标题重新生成开始/结束
 * 用于在生成期间展示标题 shimmer 动画
 * @deprecated 请改用 AsyncOperationEvent
 */
export interface TitleRegeneratingEvent {
  type: 'title_regenerating'
  sessionId: string
  isRegenerating: boolean
}

/**
 * 通用异步操作状态事件
 * 用于分享、更新分享、撤销分享、标题重新生成等异步操作的 shimmer 动画
 */
export interface AsyncOperationEvent {
  type: 'async_operation'
  sessionId: string
  isOngoing: boolean
}

/**
 * 工作目录变更事件：用户通过 UI 主动切换
 */
export interface WorkingDirectoryChangedEvent {
  type: 'working_directory_changed'
  sessionId: string
  workingDirectory: string
}

/**
 * 工作目录错误事件：服务端拒绝该路径（跨平台、路径不存在等）
 */
export interface WorkingDirectoryErrorEvent {
  type: 'working_directory_error'
  sessionId: string
  error: string
}

/**
 * 权限模式变更事件
 */
export interface PermissionModeChangedEvent {
  type: 'permission_mode_changed'
  sessionId: string
  permissionMode: PermissionMode
  previousPermissionMode?: PermissionMode
  transitionDisplay?: string
  modeVersion?: number
  changedAt?: string
  changedBy?: 'user' | 'system' | 'restore' | 'automation' | 'unknown'
}

/**
 * 会话模型变更事件
 */
export interface SessionModelChangedEvent {
  type: 'session_model_changed'
  sessionId: string
  model: string | null
}

/**
 * LLM 连接变更事件：同步服务端会话的 llmConnection 到 renderer
 */
export interface LLMConnectionChangedEvent {
  type: 'connection_changed'
  sessionId: string
  connectionSlug: string
  supportsBranching?: boolean
}

/**
 * 凭据请求事件：提示用户输入凭据
 */
export interface CredentialRequestEvent {
  type: 'credential_request'
  sessionId: string
  request: CredentialRequest
}

/**
 * 任务进入后台事件：后台 Agent 已启动
 */
export interface TaskBackgroundedEvent {
  type: 'task_backgrounded'
  sessionId: string
  toolUseId: string
  taskId: string
  intent?: string
  turnId?: string
  /** 'workflow' marks a fan-out Workflow launch (many sub-agents); undefined = a single Agent/Task. */
  kind?: 'workflow'
  /** Workflow run id (wf_...) — correlates workflow_agent_completed events to this chip. */
  workflowId?: string
}

/**
 * Workflow agent completed - one sub-agent of a running Workflow finished.
 * Increments the owning workflow chip's completed-agent count.
 */
export interface WorkflowAgentCompletedEvent {
  type: 'workflow_agent_completed'
  sessionId: string
  workflowId: string
  agentId: string
  turnId?: string
}

/**
 * Shell 进入后台事件：后台 Bash shell 已启动
 */
export interface ShellBackgroundedEvent {
  type: 'shell_backgrounded'
  sessionId: string
  toolUseId: string
  shellId: string
  intent?: string
  turnId?: string
}

/**
 * 任务进度事件：后台任务的实时进度更新
 */
export interface TaskProgressEvent {
  type: 'task_progress'
  sessionId: string
  toolUseId: string
  elapsedSeconds: number
  turnId?: string
}

/**
 * 任务完成事件：后台任务执行结束
 * 更新对应工具消息的状态和摘要结果。
 */
export interface TaskCompletedEvent {
  type: 'task_completed'
  sessionId: string
  taskId: string
  status: 'completed' | 'failed' | 'stopped'
  outputFile?: string
  summary?: string
  turnId?: string
}

/**
 * 用户消息事件：后端对乐观用户消息的确认
 * 前端会先把用户消息立即显示出来，后端再通过这个事件确认/更新状态。
 */
export interface UserMessageEvent {
  type: 'user_message'
  sessionId: string
  message: Message
  status: 'accepted' | 'queued' | 'processing'
  /** 前端乐观消息 ID，用于可靠匹配 */
  optimisticMessageId?: string
}

/**
 * 消息批注更新事件
 */
export interface MessageAnnotationsUpdatedEvent {
  type: 'message_annotations_updated'
  sessionId: string
  messageId: string
  annotations: NonNullable<Message['annotations']>
}

/**
 * 会话分享事件：会话已被分享到 viewer
 */
export interface SessionSharedEvent {
  type: 'session_shared'
  sessionId: string
  sharedUrl: string
}

/**
 * 会话取消分享事件：会话分享已被撤销
 */
export interface SessionUnsharedEvent {
  type: 'session_unshared'
  sessionId: string
}

/**
 * 认证请求事件：统一认证流程（凭据或 OAuth）
 * 向会话中添加一条 auth-request 消息并显示内联认证 UI
 */
export interface AuthRequestEvent {
  type: 'auth_request'
  sessionId: string
  message: Message
  request: AuthRequest
}

/**
 * 认证完成事件：认证请求已完成（成功、失败或取消）
 * 更新 auth-request 消息的状态
 */
export interface AuthCompletedEvent {
  type: 'auth_completed'
  sessionId: string
  requestId: string
  success: boolean
  cancelled?: boolean
  error?: string
}

/**
 * 来源激活事件：某来源在回合中自动启用。
 * 服务端拥有自动重试的主导权，renderer 端仅把它当作 UI 反馈处理。
 */
export interface SourceActivatedEvent {
  type: 'source_activated'
  sessionId: string
  sourceSlug: string
  originalMessage: string
}

/**
 * 用量更新事件：处理过程中实时更新上下文用量
 * 让 UI 在 Agent 运行期间就能看到上下文增长，而不必等到 complete 事件。
 */
export interface UsageUpdateEvent {
  type: 'usage_update'
  sessionId: string
  tokenUsage: {
    inputTokens: number
    contextWindow?: number
  }
}

/**
 * 所有 Agent 事件的联合类型（Union Type）
 * 用 | 连接多个 interface，表示 AgentEvent 可以是其中任意一种。
 * 类似 Go 的 interface{}，但 TS 会在编译期检查具体字段。
 */
export type AgentEvent =
  | TextDeltaEvent
  | TextCompleteEvent
  | ToolStartEvent
  | ToolResultEvent
  | CompleteEvent
  | ErrorEvent
  | TypedErrorEvent
  | PermissionRequestEvent
  | CredentialRequestEvent
  | SourcesChangedEvent
  | LabelsChangedEvent
  | ProjectIdChangedEvent
  | SessionStatusChangedEvent
  | SessionMetadataChangedEvent
  | SessionFlaggedEvent
  | SessionUnflaggedEvent
  | SessionArchivedEvent
  | SessionUnarchivedEvent
  | NameChangedEvent
  | PlanSubmittedEvent
  | StatusEvent
  | InfoEvent
  | InterruptedEvent
  | TitleGeneratedEvent
  | TitleRegeneratingEvent
  | AsyncOperationEvent
  | WorkingDirectoryChangedEvent
  | WorkingDirectoryErrorEvent
  | PermissionModeChangedEvent
  | SessionModelChangedEvent
  | LLMConnectionChangedEvent
  | TaskBackgroundedEvent
  | ShellBackgroundedEvent
  | TaskProgressEvent
  | TaskCompletedEvent
  | WorkflowAgentCompletedEvent
  | UserMessageEvent
  | MessageAnnotationsUpdatedEvent
  | SessionSharedEvent
  | SessionUnsharedEvent
  | AuthRequestEvent
  | AuthCompletedEvent
  | SourceActivatedEvent
  | UsageUpdateEvent

/**
 * 需要在纯函数外部处理的副作用
 * 例如权限弹窗、凭据弹窗、标题生成、toast 错误等。
 */
export type Effect =
  | { type: 'permission_request'; request: PermissionRequest }
  | { type: 'credential_request'; request: CredentialRequest }
  | { type: 'generate_title'; sessionId: string; userMessage: string }
  | { type: 'permission_mode_changed'; sessionId: string; permissionMode: PermissionMode; previousPermissionMode?: PermissionMode; transitionDisplay?: string; modeVersion?: number; changedAt?: string; changedBy?: 'user' | 'system' | 'restore' | 'automation' | 'unknown' }
  | { type: 'restore_input'; text: string }
  | { type: 'toast_error'; message: string }

/**
 * 处理单个事件后的结果
 */
export interface ProcessResult {
  state: SessionState
  /** 待执行的副作用（如权限请求等） */
  effects: Effect[]
}
