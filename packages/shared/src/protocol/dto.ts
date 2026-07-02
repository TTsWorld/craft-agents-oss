/**
 * 服务端 DTO 类型——RPC handler 与 SessionManager 使用的数据结构。
 *
 * 这些类型原先放在 apps/electron/src/shared/types.ts，
 * 现在抽取到 @craft-agent/shared/protocol，
 * 这样 @craft-agent/server-core 里的 handler 代码无需反向依赖 app 层。
 */

import type {
  Message,
  TypedError,
  ContentBadge,
  ToolDisplayMeta,
  AnnotationV1,
  PermissionRequest as BasePermissionRequest,
} from '@craft-agent/core/types'
import type { PermissionMode } from '../agent/mode-types'
import type { ThinkingLevel } from '../agent/thinking-levels'
import type { CustomEndpointConfig } from '../config/llm-connections'
import type {
  AuthRequest as SharedAuthRequest,
  CredentialInputMode as SharedCredentialInputMode,
  CredentialAuthRequest as SharedCredentialAuthRequest,
} from '../agent/index'

// 为方便 handler 复用，从 core 再导出 generateMessageId。
export { generateMessageId } from '@craft-agent/core/types'

// ---------------------------------------------------------------------------
// Session 类型
// ---------------------------------------------------------------------------

/**
 * 会话状态 ID，指向 workspace 配置里的某个 status。
 * 运行时会通过 validateSessionStatus() 校验；
 * 若对应的 status 不存在则回退为 'todo'。
 */
export type SessionStatus = string

// 内置状态 ID，相当于系统预设的几种任务状态。
export type BuiltInStatusId = 'todo' | 'in-progress' | 'needs-review' | 'done' | 'cancelled'

/**
 * Electron 端的 Session 类型（包含运行时状态）。
 * 在 core 的 Session 基础上扩展了 messages 数组与处理状态。
 */
export interface Session {
  id: string
  workspaceId: string
  workspaceName: string
  name?: string
  /** 第一条用户消息的预览（来自 JSONL header，用于懒加载会话）。 */
  preview?: string
  lastMessageAt: number
  messages: Message[]
  isProcessing: boolean
  isFlagged?: boolean
  /** 当前会话的权限模式（'safe' | 'ask' | 'allow-all'）。 */
  permissionMode?: PermissionMode
  sessionStatus?: SessionStatus
  /** 标签（可加多个，ID 或 "id::value" 形式）。 */
  labels?: string[]
  lastReadMessageId?: string
  /**
   * 显式未读标记：NEW badge 的唯一真相源。
   * 当助手完成回复而用户未在看该会话时设为 true；
   * 当用户查看会话（且不在处理中）时设为 false。
   */
  hasUnread?: boolean
  enabledSourceSlugs?: string[]
  workingDirectory?: string
  sessionFolderPath?: string
  sharedUrl?: string
  sharedId?: string
  model?: string
  llmConnection?: string
  thinkingLevel?: ThinkingLevel
  lastMessageRole?: 'user' | 'assistant' | 'plan' | 'tool' | 'error'
  lastFinalMessageId?: string
  isAsyncOperationOngoing?: boolean
  /** @deprecated 请改用 isAsyncOperationOngoing。 */
  isRegeneratingTitle?: boolean
  currentStatus?: {
    message: string
    statusType?: string
  }
  createdAt?: number
  messageCount?: number
  tokenUsage?: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
    contextTokens: number
    costUsd: number
    cacheReadTokens?: number
    cacheCreationTokens?: number
    /** 模型上下文窗口大小（来自 SDK modelUsage）。 */
    contextWindow?: number
  }
  /** 为 true 时该会话在列表中隐藏（例如 mini edit 会话）。 */
  hidden?: boolean
  isArchived?: boolean
  archivedAt?: number
  supportsBranching?: boolean
  /** Workspace-scoped project id this session is bound to (undefined = unbound) */
  projectId?: string
  /** Parent session id — when set, this session is a subtask of the parent (undefined = top-level task) */
  parentSessionId?: string
  /** Kanban board column id ('todo' | 'in-progress' | 'done'); independent of sessionStatus */
  kanbanColumn?: string
  /** Tasks Conductor: slug of the task spec this session belongs to. */
  taskSlug?: string
  /** Tasks Conductor: id of the run that spawned this child session (child nodes only). */
  taskRunId?: string
  /** Tasks Conductor: id of the DAG node this child session executes (child nodes only). */
  taskNodeId?: string
  /** Tasks Conductor: total DAG node count (orchestrator only) — stable board progress denominator. */
  taskNodeCount?: number
  /** Tasks Conductor: generate-time draft orchestrator, hidden from the board until adopted by createTask. */
  taskDraft?: boolean
}

// 创建会话时可选项。
export interface CreateSessionOptions {
  name?: string
  permissionMode?: PermissionMode
  /**
   * 推理/思考级别覆盖。设置后优先于 workspace 与全局默认值。
   * 对非推理模型（如 gpt-4o）会被底层 SDK 静默忽略——
   * Pi SDK catalog 中 `reasoning: false` 的模型不会附带 reasoning 参数。
   */
  thinkingLevel?: ThinkingLevel
  /**
   * 会话的工作目录：
   * - 'user_default' 或 undefined：使用 workspace 配置的默认目录
   * - 'none'：没有工作目录（仅 session 文件夹）
   * - 绝对路径字符串：使用指定路径
   */
  workingDirectory?: string | 'user_default' | 'none'
  model?: string
  llmConnection?: string
  systemPromptPreset?: 'default' | 'mini' | string
  hidden?: boolean
  sessionStatus?: SessionStatus
  labels?: string[]
  isFlagged?: boolean
  enabledSourceSlugs?: string[]
  /**
   * 从哪条消息分叉。这是一个硬上下文截断：
   * 新会话不能包含父会话后续消息的模型上下文。
   */
  branchFromMessageId?: string
  /** 与 branchFromMessageId 一起使用的父会话 ID。 */
  branchFromSessionId?: string
  /** Bind the new session to a workspace project (inherits project's workingDirectory). */
  projectId?: string
  /** Mark the new session as a subtask of this parent session (undefined = top-level task). */
  parentSessionId?: string
  /** Tasks Conductor: slug of the task spec this session belongs to (orchestrator + child nodes). */
  taskSlug?: string
  /** Tasks Conductor: id of the run that spawned this child session (child nodes only). */
  taskRunId?: string
  /** Tasks Conductor: id of the DAG node this child session executes (child nodes only). */
  taskNodeId?: string
  /** Tasks Conductor: mark the orchestrator as a generate-time draft (hidden until adopted by createTask). */
  taskDraft?: boolean
  /**
   * Apply the reserved "Task" label (valueType 'number') after creation. Top-level sessions
   * allocate the next task number; sessions with a `parentSessionId` inherit the parent's
   * number (labeling a plain-chat parent in the same pass). Task flows opt in; plain chats don't.
   */
  applyTaskLabel?: boolean
}

// 跨服务端/远程迁移会话时传输的 payload。
export interface RemoteSessionTransferPayload {
  sourceSessionId: string
  name?: string
  sessionStatus?: SessionStatus
  labels?: string[]
  permissionMode?: PermissionMode
  summary: string
}

export interface ImportRemoteSessionTransferResult {
  sessionId: string
}

// ---------------------------------------------------------------------------
// Tasks（Conductor）DTO —— tasks:* 频道的线缆契约。
// ---------------------------------------------------------------------------

export interface TaskValidationIssueDto {
  /** spec 内的点号路径，例如 "nodes.design.depends_on"。 */
  path: string
  message: string
  severity: 'error' | 'warning'
  suggestion?: string
}

export interface TaskValidationResultDto {
  valid: boolean
  errors: TaskValidationIssueDto[]
  warnings: TaskValidationIssueDto[]
  /** 预检估算：总节点数以及一次运行会派生多少个 session。 */
  estimate?: { nodeCount: number; sessionNodeCount: number }
}

export interface TaskCreateRequest {
  /** task.yaml 源文本（权威来源）。 */
  yaml: string
  /**
   * 当此 YAML 由 `tasks:generate` 编排器生成时，该隐藏草稿 session 的 id。
   * tasks:create 会就地提升它（清除 taskDraft、绑定 taskSlug），
   * 而不是另起一个顶级 session —— 避免出现重复的看板卡片（#bug1）。
   * 仅当草稿仍未被采纳且 slug 匹配时生效；否则忽略。
   */
  orchestratorSessionId?: string
  /**
   * 编辑模式绑定：用户正在把 spec 保存到的一个已存在、看板上可见的 session（如快速添加的卡片）
   * 的 id。tasks:create 会调用 `bindExistingSessionToTask`，绑定失败时硬报错 ——
   * 绝不能回退到创建新编排器（那会留下重复卡片）。与 `orchestratorSessionId` 不同，后者是采纳隐藏草稿。
   */
  attachToExistingSession?: string
}

export interface TaskCreateResult {
  /** 校验失败时为空字符串 —— 检查 `validation`。 */
  slug: string
  /** 持久化的父级/编排器 session（作者 + 最终验证者）。 */
  orchestratorSessionId: string
  validation: TaskValidationResultDto
  /**
   * 应用到编排器的保留 "Task" 标签的已解析 id。可能与字面量 'task' 不同
   *（用户自有的同名标签会强制生成新 slug 如 'task-2'），因此导航/过滤必须使用此 id。
   * 标签应用失败时为 undefined（容错）。
   */
  taskLabelId?: string
}

export interface TaskGenerateRequest {
  /** 编排器要转化为 task.yaml DAG 的自然语言目标。 */
  goal: string
  /** 任务/编排器 session 的可选工作标题。 */
  title?: string
  /** 编排器 session 的可选模型（默认为 session 默认模型）。 */
  model?: string
  /** 编排器 session 的可选工作目录（默认为 project/workspace cwd）。 */
  cwd?: string
  /** 要绑定到的项目，使草稿编排器基于该项目的 `<project_context>` 进行编写。 */
  projectId?: string
  /**
   * 服务 `model` 的 LLM 连接 slug。非默认模型（如 pi/*）必填 ——
   * 否则编写轮次无法解析后端并立即完成且无输出（无效 spec）。
   */
  llmConnection?: string
  /** 草稿编排器可使用的 task 级 source slug（省略 → workspace 默认）。 */
  enabledSourceSlugs?: string[]
  /** 草稿编排器的权限模式，使其编写轮次从一开始就匹配任务选择的自主程度，
   *  而非在采纳前一直运行在 workspace 默认模式。 */
  permissionMode?: PermissionMode
}

/**
 * `tasks:generate` 的同步确认。编排器 session 会立即创建（开销很小）并马上返回；
 * 编写好的 spec 稍后通过 `tasks:generated` 推送事件到达。这样即使编写耗时
 * 超出请求预算，RPC 也能远低于统一客户端超时。
 */
export interface TaskGenerateAck {
  /** 持久化的编排器 session，立即可达，确保其工作不会丢失。 */
  orchestratorSessionId: string
}

export interface TaskGenerateResult {
  /** 编写 spec 的持久化编排器 session（也负责处理修订）。 */
  orchestratorSessionId: string
  /** 编写出的 spec 的 slug；生成无效 spec 时为空。 */
  slug: string
  /** 有效时解析出的 TaskSpec（消费者从 @craft-agent/shared/tasks 转型）。 */
  spec?: unknown
  /** 编排器生成的原始 task.yaml —— 在编辑器中展示并可编辑。 */
  yaml: string
  validation: TaskValidationResultDto
  /** 在生成 spec 前就失败时设置（例如编排器轮次出错/超时）。 */
  error?: string
}

export interface TaskRunRequest {
  slug: string
  runId?: string
  orchestratorSessionId?: string
  params?: Record<string, unknown>
}

export interface TaskNodeRunStateDto {
  id: string
  /** pending | running | done | failed | cancelled | skipped */
  state: string
  sessionId?: string
  attempt: number
}

export interface TaskRunSnapshotDto {
  slug: string
  runId: string
  taskId: string
  /** running | paused | verifying | stopped | completed | failed */
  status: string
  orchestratorSessionId?: string
  nodes: TaskNodeRunStateDto[]
  /** 完成时观测到的每个子任务的（输入 + 输出）token 之和。 */
  tokensUsed: number
}

export interface TaskGetResult {
  slug: string
  validation: TaskValidationResultDto
  /** 有效时解析出的 TaskSpec（来自 @craft-agent/shared/tasks）；消费者转型。 */
  spec?: unknown
  /** 提供了 runId 且已知时的活跃运行快照；否则为 null。 */
  run?: TaskRunSnapshotDto | null
}

/** 已完成/持久化运行中单个子任务的结果，用于编辑器的 Results 标签页。 */
export interface TaskResultNodeDto {
  id: string
  title: string
  /** pending | running | done | failed | cancelled | skipped */
  state: string
  /** 运行该节点的子 session，从运行日志恢复（可深入查看链接）。 */
  sessionId?: string
  /** 该节点记录的最终输出文本（来自 nodes/<id>.json），存在时提供。 */
  output?: string
}

/**
 * 存储层读取的任务运行结果 —— 结论 + 每个节点的最终输出，从持久化的运行产物中恢复
 *（run-log.jsonl、nodes/<id>.json、每次运行的 spec.json 快照）。与 `TaskRunSnapshotDto`
 * 不同，它能在重启后保留且不需要内存中的活跃运行。
 */
export interface TaskResultsDto {
  slug: string
  /** 检查的运行；任务从未运行过时为 null。 */
  runId: string | null
  /** 该任务的所有运行 id（最新在最后），用于运行选择器。 */
  runIds: string[]
  /** 最近的结论（为单结论消费者保留以向后兼容）。 */
  verdict?: { result: 'pass' | 'fail' | 'unparsed'; reason?: string; nodes?: string[] }
  /** 按顺序排列的所有结论（FAIL→修复循环会产生多个），用于 Results 历史视图。 */
  verdicts?: { result: 'pass' | 'fail' | 'unparsed'; reason?: string; nodes?: string[] }[]
  /** 修复循环核算：已消耗的尝试次数（= FAIL 结论数）和解析出的上限。 */
  repair?: { used: number; max: number }
  /** 从运行日志恢复的终止运行状态（completed | failed | stopped | …）。 */
  runStatus?: string
  /** 该运行的验收标准（来自每次运行的 spec 快照），显示在结论上方。 */
  acceptanceCriteria?: string
  nodes: TaskResultNodeDto[]
}

// 权限模式当前状态，包含切换来源与时间戳。
export interface PermissionModeState {
  permissionMode: PermissionMode
  previousPermissionMode?: PermissionMode
  transitionDisplay?: string
  modeVersion: number
  changedAt: string
  changedBy: 'user' | 'system' | 'restore' | 'automation' | 'unknown'
}

// ---------------------------------------------------------------------------
// Session 事件（主进程 → 渲染进程）
// ---------------------------------------------------------------------------

// turnId：API 返回 message.id 的关联 ID，一次 assistant 回复产生的所有事件共享它。
export type SessionEvent =
  | { type: 'text_delta'; sessionId: string; delta: string; turnId?: string }
  | { type: 'text_complete'; sessionId: string; text: string; isIntermediate?: boolean; turnId?: string; parentToolUseId?: string; timestamp?: number; messageId?: string }
  | { type: 'tool_start'; sessionId: string; toolName: string; toolUseId: string; toolInput: Record<string, unknown>; toolIntent?: string; toolDisplayName?: string; toolDisplayMeta?: ToolDisplayMeta; turnId?: string; parentToolUseId?: string; timestamp?: number }
  | { type: 'tool_result'; sessionId: string; toolUseId: string; toolName: string; result: string; turnId?: string; parentToolUseId?: string; isError?: boolean; timestamp?: number }
  | { type: 'error'; sessionId: string; error: string; timestamp?: number }
  | { type: 'typed_error'; sessionId: string; error: TypedError; timestamp?: number }
  | { type: 'complete'; sessionId: string; tokenUsage?: Session['tokenUsage']; hasUnread?: boolean; backgroundTasksAlive?: boolean }
  | { type: 'interrupted'; sessionId: string; message?: Message; queuedMessages?: string[] }
  | { type: 'status'; sessionId: string; message: string; statusType?: 'compacting' }
  | { type: 'info'; sessionId: string; message: string; statusType?: 'compaction_complete'; level?: 'info' | 'warning' | 'error' | 'success'; timestamp?: number }
  | { type: 'title_generated'; sessionId: string; title: string }
  | { type: 'title_regenerating'; sessionId: string; isRegenerating: boolean }
  | { type: 'async_operation'; sessionId: string; isOngoing: boolean }
  | { type: 'working_directory_changed'; sessionId: string; workingDirectory: string }
  | { type: 'permission_request'; sessionId: string; request: PermissionRequest }
  | { type: 'credential_request'; sessionId: string; request: CredentialRequest }
  | { type: 'permission_mode_changed'; sessionId: string; permissionMode: PermissionMode; previousPermissionMode?: PermissionMode; transitionDisplay?: string; modeVersion?: number; changedAt?: string; changedBy?: PermissionModeState['changedBy'] }
  | { type: 'plan_submitted'; sessionId: string; message: Message }
  | { type: 'sources_changed'; sessionId: string; enabledSourceSlugs: string[] }
  | { type: 'labels_changed'; sessionId: string; labels: string[] }
  | { type: 'project_id_changed'; sessionId: string; projectId: string | null }
  | { type: 'connection_changed'; sessionId: string; connectionSlug: string; supportsBranching?: boolean }
  | { type: 'task_backgrounded'; sessionId: string; toolUseId: string; taskId: string; intent?: string; turnId?: string; kind?: 'workflow'; workflowId?: string }
  | { type: 'shell_backgrounded'; sessionId: string; toolUseId: string; shellId: string; intent?: string; command?: string; turnId?: string }
  | { type: 'task_progress'; sessionId: string; toolUseId: string; elapsedSeconds: number; turnId?: string }
  | { type: 'task_completed'; sessionId: string; taskId: string; status: 'completed' | 'failed' | 'stopped'; outputFile?: string; summary?: string; turnId?: string }
  | { type: 'workflow_agent_completed'; sessionId: string; workflowId: string; agentId: string; turnId?: string }
  | { type: 'shell_killed'; sessionId: string; shellId: string }
  | { type: 'user_message'; sessionId: string; message: Message; status: 'accepted' | 'queued' | 'processing'; optimisticMessageId?: string }
  | { type: 'session_flagged'; sessionId: string }
  | { type: 'session_unflagged'; sessionId: string }
  | { type: 'session_archived'; sessionId: string }
  | { type: 'session_unarchived'; sessionId: string }
  | { type: 'name_changed'; sessionId: string; name?: string }
  | { type: 'session_model_changed'; sessionId: string; model: string | null }
  | { type: 'session_status_changed'; sessionId: string; sessionStatus: SessionStatus }
  | { type: 'session_metadata_changed'; sessionId: string; changes: Partial<Pick<Session, 'taskNodeCount' | 'kanbanColumn' | 'taskDraft' | 'taskSlug' | 'projectId'>> }
  | { type: 'session_deleted'; sessionId: string }
  | { type: 'session_created'; sessionId: string }
  | { type: 'session_shared'; sessionId: string; sharedUrl: string }
  | { type: 'session_unshared'; sessionId: string }
  | { type: 'auth_request'; sessionId: string; message: Message; request: SharedAuthRequest }
  | { type: 'auth_completed'; sessionId: string; requestId: string; success: boolean; cancelled?: boolean; error?: string }
  | { type: 'source_activated'; sessionId: string; sourceSlug: string; originalMessage: string }
  | { type: 'usage_update'; sessionId: string; tokenUsage: { inputTokens: number; contextWindow?: number } }
  | { type: 'message_annotations_updated'; sessionId: string; messageId: string; annotations: AnnotationV1[] }
  | { type: 'working_directory_error'; sessionId: string; error: string }

export interface SendMessageOptions {
  skillSlugs?: string[]
  badges?: ContentBadge[]
  optimisticMessageId?: string
  /**
   * When true, the message drives a turn (reaches the model) but is marked
   * `hidden` on the persisted `Message` so it never renders as a transcript
   * bubble. Used for system-generated nudges (e.g. WS2 background-task-completion
   * surfacing) that should wake the agent without looking user-authored.
   */
  hidden?: boolean
}

// ---------------------------------------------------------------------------
// Session 命令（合并多种操作）
// ---------------------------------------------------------------------------

// SessionCommand：对会话执行的一个命令，
// 通过 `type` 字段区分不同操作，类似 Go 的 tagged union（sum type）。
export type SessionCommand =
  | { type: 'flag' }
  | { type: 'unflag' }
  | { type: 'archive' }
  | { type: 'unarchive' }
  | { type: 'rename'; name: string }
  | { type: 'setSessionStatus'; state: SessionStatus }
  | { type: 'markRead' }
  | { type: 'markUnread' }
  | { type: 'setActiveViewing'; workspaceId: string }
  | { type: 'setPermissionMode'; mode: PermissionMode }
  | { type: 'setThinkingLevel'; level: ThinkingLevel }
  | { type: 'updateWorkingDirectory'; dir: string }
  | { type: 'setSources'; sourceSlugs: string[] }
  | { type: 'setLabels'; labels: string[] }
  | { type: 'setProjectId'; projectId: string | null }
  | { type: 'setKanbanColumn'; column: string | null }
  | { type: 'showInFinder' }
  | { type: 'copyPath' }
  | { type: 'shareToViewer' }
  | { type: 'updateShare' }
  | { type: 'revokeShare' }
  | { type: 'refreshTitle' }
  | { type: 'setConnection'; connectionSlug: string }
  | { type: 'setPendingPlanExecution'; planPath: string; draftInputSnapshot?: string }
  | { type: 'markCompactionComplete' }
  | { type: 'markPendingPlanExecutionDispatched' }
  | { type: 'clearPendingPlanExecution' }
  | { type: 'addAnnotation'; messageId: string; annotation: AnnotationV1 }
  | { type: 'removeAnnotation'; messageId: string; annotationId: string }
  | { type: 'updateAnnotation'; messageId: string; annotationId: string; patch: Partial<AnnotationV1> }

export interface NewChatActionParams {
  input?: string
  name?: string
}

// ---------------------------------------------------------------------------
// Permission / credential 类型
// ---------------------------------------------------------------------------

export type { BasePermissionRequest }

/**
 * 带 session 上下文的权限请求（多会话 Electron 应用）。
 * 继承自 core 的 BasePermissionRequest，并补充 sessionId。
 */
export interface PermissionRequest extends BasePermissionRequest {
  sessionId: string
}

export interface PermissionResponseOptions {
  rememberForMinutes?: number
}

// 为方便 handler，从 agent 模块重导出 credential 相关类型。
export type { SharedCredentialInputMode as CredentialInputMode }
export type CredentialRequest = SharedCredentialAuthRequest
export type { SharedAuthRequest as AuthRequest }

export interface CredentialResponse {
  type: 'credential'
  value?: string
  username?: string
  password?: string
  headers?: Record<string, string>
  cancelled: boolean
}

// ---------------------------------------------------------------------------
// 目录浏览类型（远程模式）
// ---------------------------------------------------------------------------

/** 服务端目录列表结果（用于远程目录浏览）。 */
export interface DirectoryListingResult {
  /** 规范化后的目录绝对路径（经过 resolve，未解析符号链接）。 */
  currentPath: string
  /** 父目录路径，已到根时为 null。 */
  parentPath: string | null
  /** 服务端计算好的面包屑分段，直接供 UI 展示。 */
  breadcrumbs: Array<{ name: string; path: string }>
  /** 服务端操作系统平台。 */
  platform: 'win32' | 'darwin' | 'linux'
  /** 服务端是否出于安全/性能原因截断了目录列表。 */
  truncated: boolean
  /** 截断前匹配的子目录总数。 */
  totalEntries: number
  /** 子目录条目。 */
  entries: Array<{ name: string; path: string; isSymlink: boolean }>
}

// ---------------------------------------------------------------------------
// 文件类型
// ---------------------------------------------------------------------------

export interface FileAttachment {
  type: 'image' | 'text' | 'pdf' | 'office' | 'audio' | 'unknown'
  path: string
  name: string
  mimeType: string
  base64?: string
  text?: string
  size: number
  thumbnailBase64?: string
}

export interface SessionFile {
  name: string
  path: string
  type: 'file' | 'directory'
  size?: number
  children?: SessionFile[]
}

export interface FileSearchResult {
  name: string
  path: string
  type: 'file' | 'directory'
  relativePath: string
}

// ---------------------------------------------------------------------------
// LLM connection 类型
// ---------------------------------------------------------------------------

/**
 * 解析后的 Anthropic OAuth 身份（issue #838），来自 token exchange 响应。
 * 形状与 auth/claude-oauth.ts 中的 ClaudeOAuthIdentity 一致；
 * 放在协议层是为了让 DTO 与 auth 模块解耦。所有字段都是可选，便于容错。
 */
export interface ClaudeOAuthIdentityDto {
  account?: { uuid?: string; emailAddress?: string }
  organization?: { uuid?: string; name?: string }
}

export interface LlmConnectionSetup {
  slug: string
  credential?: string
  baseUrl?: string | null
  defaultModel?: string | null
  models?: string[] | null
  piAuthProvider?: string
  modelSelectionMode?: 'automaticallySyncedFromProvider' | 'userDefined3Tier'
  /** 为 true 时，若该连接不存在则拒绝设置（用于重新认证保护）。 */
  updateOnly?: boolean
  /** 自定义端点协议，用于任意 OpenAI/Anthropic 兼容 API。 */
  customEndpoint?: CustomEndpointConfig
  /** Pi+Bedrock（piAuthProvider='amazon-bedrock'）的 IAM 凭证。 */
  iamCredentials?: {
    accessKeyId: string
    secretAccessKey: string
    sessionToken?: string
  }
  /** Pi+Bedrock 的 AWS 区域。 */
  awsRegion?: string
  /** Bedrock 认证方式，决定 Pi+Bedrock 连接使用哪种认证。 */
  bedrockAuthMethod?: 'iam_credentials' | 'environment'
  /**
   * 解析后的 Anthropic OAuth 身份（issue #838），
   * 贯穿 setup 流程，使新建和重新认证都能持久化。可选且容错。
   */
  oauthIdentity?: ClaudeOAuthIdentityDto
}

export interface TestLlmConnectionParams {
  provider: 'anthropic' | 'pi'
  apiKey: string
  baseUrl?: string
  model?: string
  piAuthProvider?: string
  /** 可选的自定义端点协议提示，使 setup 测试与运行时路由保持一致。 */
  customEndpoint?: CustomEndpointConfig
}

export interface TestLlmConnectionResult {
  success: boolean
  error?: string
}

// ---------------------------------------------------------------------------
// Source / skill 类型
// ---------------------------------------------------------------------------

export interface SkillFile {
  name: string
  type: 'file' | 'directory'
  size?: number
  children?: SkillFile[]
}

export interface OAuthResult {
  success: boolean
  error?: string
}

// MCP（Model Context Protocol）验证结果。
export interface McpValidationResult {
  success: boolean
  error?: string
  tools?: string[]
}

// 单个 MCP tool 及其权限开关。
export interface McpToolWithPermission {
  name: string
  description?: string
  allowed: boolean
}

export interface McpToolsResult {
  success: boolean
  error?: string
  tools?: McpToolWithPermission[]
}

// ---------------------------------------------------------------------------
// 搜索类型
// ---------------------------------------------------------------------------

export interface SessionSearchMatch {
  sessionId: string
  lineNumber: number
  snippet: string
}

export interface SessionSearchResult {
  sessionId: string
  matchCount: number
  matches: SessionSearchMatch[]
}

// ---------------------------------------------------------------------------
// Session 结果类型
// ---------------------------------------------------------------------------

export interface UnreadSummary {
  totalUnreadSessions: number
  byWorkspace: Record<string, number>
  hasUnreadByWorkspace: Record<string, boolean>
}

export interface ShareResult {
  success: boolean
  url?: string
  error?: string
}

export interface RefreshTitleResult {
  success: boolean
  title?: string
  error?: string
}

// ---------------------------------------------------------------------------
// Plan 类型
// ---------------------------------------------------------------------------

export interface PlanStep {
  id: string
  description: string
  tools?: string[]
  status?: 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped'
}

export interface Plan {
  id: string
  title: string
  summary?: string
  steps: PlanStep[]
  questions?: string[]
  state?: 'creating' | 'refining' | 'ready' | 'executing' | 'completed' | 'cancelled'
  createdAt?: number
  updatedAt?: number
}

// ---------------------------------------------------------------------------
// System 类型
// ---------------------------------------------------------------------------

export interface GitBashStatus {
  found: boolean
  path: string | null
  platform: 'win32' | 'darwin' | 'linux'
}

export interface UpdateInfo {
  available: boolean
  currentVersion: string
  latestVersion: string | null
  downloadState: 'idle' | 'downloading' | 'ready' | 'installing' | 'error'
  downloadProgress: number
  error?: string
}

// ---------------------------------------------------------------------------
// Workspace 类型
// ---------------------------------------------------------------------------

export interface WorkspaceSettings {
  name?: string
  model?: string
  permissionMode?: PermissionMode
  cyclablePermissionModes?: PermissionMode[]
  thinkingLevel?: ThinkingLevel
  workingDirectory?: string
  localMcpEnabled?: boolean
  defaultLlmConnection?: string
  enabledSourceSlugs?: string[]
}

// ---------------------------------------------------------------------------
// Auth 结果类型
// ---------------------------------------------------------------------------

export interface ClaudeOAuthResult {
  success: boolean
  token?: string
  error?: string
  /**
   * 解析后的 Anthropic 身份（issue #838），转发给渲染进程，
   * 由渲染进程把它放进 SETUP payload 里持久化。
   * 仅当 token exchange 响应携带身份时才存在。
   */
  identity?: ClaudeOAuthIdentityDto
}

// ---------------------------------------------------------------------------
// Automation 类型
// ---------------------------------------------------------------------------

export type TestAutomationAction =
  | { type: 'prompt'; prompt: string; llmConnection?: string; model?: string; thinkingLevel?: ThinkingLevel }
  | { type: 'webhook'; url: string; method?: string; headers?: Record<string, string>; bodyFormat?: 'json' | 'form' | 'raw'; body?: unknown; captureResponse?: boolean; auth?: { type: 'basic'; username: string; password: string } | { type: 'bearer'; token: string } }

export interface TestAutomationPayload {
  workspaceId: string
  automationId?: string
  automationName?: string
  actions: TestAutomationAction[]
  permissionMode?: PermissionMode
  labels?: string[]
  /** 由 matcher 透传；测试运行会话配对 Telegram topic 时使用。 */
  telegramTopic?: string
}

export type TestAutomationActionResult =
  | { type: 'prompt'; success: boolean; stderr?: string; sessionId?: string; duration: number }
  | { type: 'webhook'; success: boolean; url: string; statusCode: number; error?: string; duration: number }

export interface TestAutomationResult {
  actions: TestAutomationActionResult[]
}

// ---------------------------------------------------------------------------
// Window 类型
// ---------------------------------------------------------------------------

export type WindowCloseRequestSource = 'keyboard-shortcut' | 'window-button' | 'unknown'

export interface WindowCloseRequest {
  source: WindowCloseRequestSource
}

// ---------------------------------------------------------------------------
// Browser / navigation 类型（BroadcastEventMap 使用的数据形状）
// ---------------------------------------------------------------------------

export interface BrowserInstanceInfo {
  id: string
  url: string
  title: string
  favicon: string | null
  isLoading: boolean
  canGoBack: boolean
  canGoForward: boolean
  boundSessionId: string | null
  ownerType: 'session' | 'manual'
  ownerSessionId: string | null
  isVisible: boolean
  agentControlActive: boolean
  themeColor: string | null
  /**
   * 拥有该浏览器实例的 workspace；未绑定的手动窗口为 null。
   * 渲染进程用 activeWorkspaceId 过滤标签条/状态徽标，
   * 避免 workspace A 的会话看到 workspace B 打开的窗口。
   * 缺失或 null 默认通过过滤，以保持旧版本主进程/渲染进程兼容。
   */
  workspaceId?: string | null
}

export interface DeepLinkNavigation {
  view?: string
  tabType?: string
  tabParams?: Record<string, string>
  action?: string
  actionParams?: Record<string, string>
}
