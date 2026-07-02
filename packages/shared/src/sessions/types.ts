/**
 * 会话类型定义
 *
 * Workspace 范围内会话相关的 TypeScript 类型。
 * 会话存储在 {workspaceRootPath}/sessions/{id}/session.jsonl
 *
 * JSONL 格式：
 * - 第 1 行：SessionHeader（元数据 + 预计算字段，加速列表加载）
 * - 第 2 行起：StoredMessage（每条消息一行）
 */

import type { PermissionMode } from '../agent/mode-manager.ts';
import type { ThinkingLevel } from '../agent/thinking-levels.ts';
import type { StoredAttachment, MessageRole, ToolStatus, AuthRequestType, AuthStatus, CredentialInputMode, StoredMessage } from '@craft-agent/core/types';

/**
 * 需要持久化到磁盘的会话字段列表。
 * 新增字段时只要同时改这里和下面的 SessionConfig interface，
 * pickSessionFields() 会自动让它进入 JSONL 读写流程。
 *
 * 重要：新增字段只需两步：
 * 1. 把字段名加到这个数组
 * 2. 在 SessionConfig interface 里声明
 * 3. 序列化/反序列化自动生效
 */
export const SESSION_PERSISTENT_FIELDS = [
  // 身份标识
  'id', 'workspaceRootPath', 'sdkSessionId', 'sdkCwd',
  // 时间戳
  'createdAt', 'lastUsedAt', 'lastMessageAt',
  // 展示
  'name', 'isFlagged', 'sessionStatus', 'labels', 'hidden',
  // 已读追踪
  'lastReadMessageId', 'hasUnread',
  // 配置
  'enabledSourceSlugs', 'permissionMode', 'previousPermissionMode', 'workingDirectory',
  // 模型/连接
  'model', 'llmConnection', 'connectionLocked', 'thinkingLevel',
  // 分享
  'sharedUrl', 'sharedId',
  // Plan 执行
  'pendingPlanExecution',
  // 归档
  'isArchived', 'archivedAt',
  // 分支
  'branchFromMessageId',
  'branchFromSdkSessionId',
  'branchFromSessionPath',
  'branchFromSdkCwd',
  'branchFromSdkTurnId',
  // 远程转移交接
  'transferredSessionSummary',
  'transferredSessionSummaryApplied',
  // 自动化来源
  'triggeredBy',
  // Project binding (workspace-scoped grouping)
  'projectId',
  // Kanban: task/subtask hierarchy + board column
  'parentSessionId',
  'kanbanColumn',
  // Tasks Conductor: link a session back to the task spec / run / DAG node that owns it
  'taskSlug',
  'taskRunId',
  'taskNodeId',
  'taskNodeCount',
  'taskDraft',
] as const;

/**
 * 单个持久化字段的类型。
 * typeof SESSION_PERSISTENT_FIELDS[number] 表示数组中所有字面量的联合类型，
 * 类似 Go 中从常量切片推导出的枚举字符串集合。
 */
export type SessionPersistentField = typeof SESSION_PERSISTENT_FIELDS[number];

/**
 * 会话状态（由用户控制，不会自动变化）。
 *
 * 它是一个动态状态 ID，引用 workspace 中的状态配置。
 * 运行时会通过 validateSessionStatus() 校验，不存在时回退到 'todo'。
 */
export type SessionStatus = string;

/**
 * 内置状态 ID（给 TypeScript 调用方用）。
 * 这些是默认状态，用户可以新增/删除自定义状态。
 */
export type BuiltInStatusId = 'todo' | 'in-progress' | 'needs-review' | 'done' | 'cancelled';

/**
 * 会话 token 使用量统计。
 */
export interface SessionTokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  contextTokens: number;
  costUsd: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  /** 模型上下文窗口大小（来自 SDK modelUsage） */
  contextWindow?: number;
}

/**
 * 落盘用的消息格式（从 @craft-agent/core 重新导出，方便本模块使用）。
 */
export type { StoredMessage } from '@craft-agent/core/types';

/**
 * 会话配置（会被持久化的元数据）。
 *
 * 可以理解为 Go 里一个带 JSON tag 的 struct，
 * 只是 TypeScript 用 interface 描述字段类型。
 */
export interface SessionConfig {
  id: string;
  /** SDK session ID（收到第一条消息后才会被捕获） */
  sdkSessionId?: string;
  /** 该会话所属的 workspace 根目录 */
  workspaceRootPath: string;
  /** 用户自定义名称（可选） */
  name?: string;
  createdAt: number;
  lastUsedAt: number;
  /**
   * 最后一条有意义消息的时间戳（用户或最终 assistant 消息）。
   * 用于会话列表按日期分组。
   * 与 lastUsedAt 不同，后者记录任何访问（自动保存、打开查看等）。
   */
  lastMessageAt?: number;
  /** 是否标记为 flagged */
  isFlagged?: boolean;
  /** 该会话的权限模式：'safe'、'ask'、'allow-all' */
  permissionMode?: PermissionMode;
  /** 上一个权限模式（用于跨重启保留 modeTransition 上下文） */
  previousPermissionMode?: PermissionMode;
  /** 用户控制的状态，决定会话显示在收件箱还是已完成 */
  sessionStatus?: SessionStatus;
  /** 会话标签（可以是纯 ID，也可以是 "id::value" 形式） */
  labels?: string[];
  /** 用户已读的最后一条消息 ID */
  lastReadMessageId?: string;
  /**
   * 明确的未读标记，是 NEW 角标的唯一真相源。
   * assistant 完成消息而用户没有查看时设为 true；
   * 用户查看会话且不在处理中时设为 false。
   */
  hasUnread?: boolean;
  /** 该会话启用的 source slug 列表（source 即 agent 可读取的知识来源） */
  enabledSourceSlugs?: string[];
  /** 该会话的工作目录，agent 执行 bash 命令和上下文会用到 */
  workingDirectory?: string;
  /**
   * 用于 SDK 会话存储的 cwd，创建时确定，之后不再改变。
   * 这样即使 workingDirectory 改变，SDK 仍能找到会话 transcript。
   */
  sdkCwd?: string;
  /** 通过 viewer 分享后的访问 URL */
  sharedUrl?: string;
  /** viewer 中的分享 ID（用于撤销分享） */
  sharedId?: string;
  /** 该会话使用的模型（设置后覆盖全局配置） */
  model?: string;
  /** 该会话使用的 LLM 连接 slug（第一条消息后锁定） */
  llmConnection?: string;
  /** 连接是否已锁定（首次创建 agent 后不可再改） */
  connectionLocked?: boolean;
  /** 该会话的思考级别：'off'、'think'、'max' */
  thinkingLevel?: ThinkingLevel;
  /**
   * Pending plan execution 状态，跟踪 "Accept & Compact" 流程。
   * 设置后表示 compaction 完成后需要执行某个 plan。
   * 在以下情况清除：成功执行、收到新用户消息、手动清除。
   */
  pendingPlanExecution?: {
    /** 要执行的 plan 文件路径 */
    planPath: string;
    /** accept 时刻捕获的 draft input 快照（可选） */
    draftInputSnapshot?: string;
    /** 是否还在等待 compaction 完成 */
    awaitingCompaction: boolean;
    /** 是否已经从 UI 发起执行 */
    executionDispatched?: boolean;
  };
  /** 为 true 时会话不显示在列表（例如 mini edit 会话） */
  hidden?: boolean;
  /** 是否已归档 */
  isArchived?: boolean;
  /** 归档时间戳（用于保留策略） */
  archivedAt?: number;
  /**
   * 该会话从哪条消息 ID 分出来的。
   * 分支语义是硬截断：模型上下文不能包含这条消息之后父会话的内容。
   */
  branchFromMessageId?: string;
  /**
   * 父会话的 SDK session ID（可选，仅部分 provider 策略支持严格的 SDK 级 fork）。
   */
  branchFromSdkSessionId?: string;
  /**
   * 父会话的存储路径（可选，仅 provider 级 fork 需要读取父会话文件时使用）。
   */
  branchFromSessionPath?: string;
  /**
   * 父会话的 sdkCwd（可选）。
   * SDK 会话文件按 CWD 存放（~/.claude/projects/{cwd-hash}/），
   * 所以 fork 时子进程需要用父进程的 CWD 才能找到父会话文件。
   */
  branchFromSdkCwd?: string;
  /**
   * provider 原生的分支锚点。
   * - Claude：assistant 消息 UUID（作为 resumeSessionAt）
   * - Pi：session entry ID（配合 SessionManager.branch(anchor) 使用）
   */
  branchFromSdkTurnId?: string;
  /** 远程转移后首次 turn 注入的隐藏摘要。 */
  transferredSessionSummary?: string;
  /** 该摘要是否已经注入过。 */
  transferredSessionSummaryApplied?: boolean;
  /** 自动化创建的会话的元数据。 */
  triggeredBy?: { automationName?: string; event?: string; timestamp?: number };
  /** Workspace-scoped project id this session belongs to (undefined = unbound). */
  projectId?: string;
  /** Parent session id — when set, this session is a subtask of the parent (undefined = top-level task). */
  parentSessionId?: string;
  /** Kanban board column id ('todo' | 'in-progress' | 'done'). Drag-to-move target; independent of sessionStatus. */
  kanbanColumn?: string;
  /** Tasks Conductor: slug of the task spec this session belongs to (orchestrator + child nodes). */
  taskSlug?: string;
  /** Tasks Conductor: id of the run that spawned this child session (child nodes only). */
  taskRunId?: string;
  /** Tasks Conductor: id of the DAG node this child session executes (child nodes only). */
  taskNodeId?: string;
  /** Tasks Conductor: total DAG node count (orchestrator only) — board progress denominator that stays stable while children spawn lazily. */
  taskNodeCount?: number;
  /** Tasks Conductor: generate-time draft orchestrator. Hidden from the board until adopted (promoted) by createTask. */
  taskDraft?: boolean;
}

/**
 * 带完整对话数据的会话。
 */
export interface StoredSession extends SessionConfig {
  messages: StoredMessage[];
  tokenUsage: SessionTokenUsage;
}

/**
 * 会话 header —— session.jsonl 的第 1 行。
 *
 * 保存列表视图需要的全部元数据（保存时预计算）。
 * 这样列表加载时不用解析消息内容，直接读第一行即可。
 */
export interface SessionHeader {
  id: string;
  /** SDK session ID（第一条消息后捕获） */
  sdkSessionId?: string;
  /** workspace 根目录（以可移植路径存储，如 ~/.craft-agent/...） */
  workspaceRootPath: string;
  /** 用户自定义名称（可选） */
  name?: string;
  createdAt: number;
  lastUsedAt: number;
  /** 最后一条有意义消息的时间戳——与 lastUsedAt 分开保存，保证跨重启日期分组稳定。 */
  lastMessageAt?: number;
  /** 是否标记为 flagged */
  isFlagged?: boolean;
  /** 该会话的权限模式：'safe'、'ask'、'allow-all' */
  permissionMode?: PermissionMode;
  /** 上一个权限模式（用于跨重启保留 modeTransition 上下文） */
  previousPermissionMode?: PermissionMode;
  /** 用户控制的状态，决定收件箱 vs 已完成 */
  sessionStatus?: SessionStatus;
  /** 会话标签 */
  labels?: string[];
  /** 用户已读的最后一条消息 ID */
  lastReadMessageId?: string;
  /**
   * 明确的未读标记，是 NEW 角标的唯一真相源。
   * assistant 完成消息而用户没有查看时设为 true；
   * 用户查看会话且不在处理中时设为 false。
   */
  hasUnread?: boolean;
  /** 该会话启用的 source slug 列表 */
  enabledSourceSlugs?: string[];
  /** 该会话的工作目录 */
  workingDirectory?: string;
  /** SDK 会话存储用的 cwd，创建时确定，之后不再改变 */
  sdkCwd?: string;
  /** 通过 viewer 分享后的 URL */
  sharedUrl?: string;
  /** viewer 中的分享 ID */
  sharedId?: string;
  /** 该会话使用的模型 */
  model?: string;
  /** 该会话使用的 LLM 连接 slug */
  llmConnection?: string;
  /** 连接是否已锁定 */
  connectionLocked?: boolean;
  /** 该会话的思考级别 */
  thinkingLevel?: ThinkingLevel;
  /**
   * Pending plan execution 状态。
   * 设置后表示 compaction 完成后需要执行某个 plan。
   */
  pendingPlanExecution?: {
    /** 要执行的 plan 文件路径 */
    planPath: string;
    /** accept 时刻捕获的 draft input 快照（可选） */
    draftInputSnapshot?: string;
    /** 是否还在等待 compaction 完成 */
    awaitingCompaction: boolean;
    /** 是否已经从 UI 发起执行 */
    executionDispatched?: boolean;
  };
  /** 为 true 时不在会话列表显示 */
  hidden?: boolean;
  /** 是否已归档 */
  isArchived?: boolean;
  /** 归档时间戳 */
  archivedAt?: number;
  /** 远程转移后注入的隐藏摘要。 */
  transferredSessionSummary?: string;
  /** 该摘要是否已经注入过。 */
  transferredSessionSummaryApplied?: boolean;
  /** 自动化创建的会话的元数据。 */
  triggeredBy?: { automationName?: string; event?: string; timestamp?: number };
  /** 该 session 所属的 workspace 级项目 id（undefined = 未绑定）。 */
  projectId?: string;
  /** 父 session id —— 设置后表示该 session 是父任务的子任务（undefined = 顶级任务）。 */
  parentSessionId?: string;
  /** 看板列 id（'todo' | 'in-progress' | 'done'）。拖拽移动的目标；与 sessionStatus 独立。 */
  kanbanColumn?: string;
  /** Tasks Conductor：该 session 所属的任务 spec slug（编排器 + 子节点）。 */
  taskSlug?: string;
  /** Tasks Conductor：派生该子 session 的运行的 id（仅子节点）。 */
  taskRunId?: string;
  /** Tasks Conductor：该子 session 执行的 DAG 节点 id（仅子节点）。 */
  taskNodeId?: string;
  /** Tasks Conductor：DAG 节点总数（仅编排器）—— 看板进度分母，在子节点惰性派生时保持稳定。 */
  taskNodeCount?: number;
  /** Tasks Conductor：生成时的草稿编排器。在看板中隐藏，直到被 createTask 采纳（提升）。 */
  taskDraft?: boolean;
  // 预计算字段，用于加速列表加载
  /** 会话消息总数 */
  messageCount: number;
  /** 最后一条消息的 role/type（列表角标用，不用加载全部消息） */
  lastMessageRole?: 'user' | 'assistant' | 'plan' | 'tool' | 'error';
  /** 第一条用户消息预览（前 150 字符） */
  preview?: string;
  /** token 使用统计 */
  tokenUsage: SessionTokenUsage;
  /** 最后一条非 intermediate assistant 消息的 ID（未读检测用） */
  lastFinalMessageId?: string;
}

/**
 * 会话元数据（轻量，用于列表）。
 */
export interface SessionMetadata {
  id: string;
  workspaceRootPath: string;
  name?: string;
  createdAt: number;
  lastUsedAt: number;
  /** 最后一条有意义消息的时间戳——用于日期分组。旧数据没有该字段时回退到 lastUsedAt。 */
  lastMessageAt?: number;
  messageCount: number;
  /** 第一条用户消息预览 */
  preview?: string;
  sdkSessionId?: string;
  /** 是否标记为 flagged */
  isFlagged?: boolean;
  /** 用户控制的状态 */
  sessionStatus?: SessionStatus;
  /** 会话标签 */
  labels?: string[];
  /** 显式的 per-session source 选择（缺省 = 跟随 workspace 默认值） */
  enabledSourceSlugs?: string[];
  /** 该会话的权限模式 */
  permissionMode?: PermissionMode;
  /** 上一个权限模式 */
  previousPermissionMode?: PermissionMode;
  /** 该会话的 plan 文件数量 */
  planCount?: number;
  /** 分享 URL */
  sharedUrl?: string;
  /** viewer 分享 ID */
  sharedId?: string;
  /** 工作目录 */
  workingDirectory?: string;
  /** SDK 会话存储用的 cwd，创建时确定，之后不再改变 */
  sdkCwd?: string;
  /** 最后一条消息的 role/type（列表角标用） */
  lastMessageRole?: 'user' | 'assistant' | 'plan' | 'tool' | 'error';
  /** 该会话使用的模型 */
  model?: string;
  /** 该会话使用的 LLM 连接 slug */
  llmConnection?: string;
  /** 连接是否已锁定 */
  connectionLocked?: boolean;
  /** 思考级别 */
  thinkingLevel?: ThinkingLevel;
  /** 用户已读的最后一条消息 ID */
  lastReadMessageId?: string;
  /** 最后一条非 intermediate assistant 消息 ID */
  lastFinalMessageId?: string;
  /**
   * 明确的未读标记。
   * assistant 完成消息而用户没有查看时设为 true；
   * 用户查看会话且不在处理中时设为 false。
   */
  hasUnread?: boolean;
  /** token 使用统计（来自 JSONL header，不加载消息即可获得） */
  tokenUsage?: SessionTokenUsage;
  /** 为 true 时不在列表显示 */
  hidden?: boolean;
  /** 是否已归档 */
  isArchived?: boolean;
  /** 归档时间戳 */
  archivedAt?: number;
  /** 该会话从哪条消息 ID 分出来的（硬上下文截断标记）。 */
  branchFromMessageId?: string;
  /** Workspace-scoped project id this session belongs to (undefined = unbound). */
  projectId?: string;
  /** Parent session id — when set, this session is a subtask of the parent (undefined = top-level task). */
  parentSessionId?: string;
  /** Kanban board column id ('todo' | 'in-progress' | 'done'). Drag-to-move target; independent of sessionStatus. */
  kanbanColumn?: string;
  /** Tasks Conductor: slug of the task spec this session belongs to (orchestrator + child nodes). */
  taskSlug?: string;
  /** Tasks Conductor: id of the run that spawned this child session (child nodes only). */
  taskRunId?: string;
  /** Tasks Conductor: id of the DAG node this child session executes (child nodes only). */
  taskNodeId?: string;
  /** Tasks Conductor: total DAG node count (orchestrator only) — board progress denominator that stays stable while children spawn lazily. */
  taskNodeCount?: number;
  /** Tasks Conductor: generate-time draft orchestrator. Hidden from the board until adopted (promoted) by createTask. */
  taskDraft?: boolean;
}
