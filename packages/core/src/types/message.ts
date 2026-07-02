/**
 * 消息类型定义。
 *
 * 这个文件是 Craft Agent 中最核心的类型文件之一，相当于 Golang 项目里常见的 `message.go`：
 * 定义了聊天消息、附件、工具调用、权限请求、错误、Agent 事件等全部核心数据结构。
 *
 * 对后端工程师来说，可以把这里理解为"领域模型层"：
 * - Message/StoredMessage 是聊天消息实体
 * - AgentEvent 是 Agent 运行过程中向 UI 推送的事件
 * - PermissionRequest/TypedError 是 Agent 与用户的交互契约
 */

/**
 * 消息角色（运行时展示用）。
 *
 * 类似一个枚举，TS 里用字符串联合类型（string literal union）表示，
 * 比 Golang 的 `const` + `iota` 更轻量，编译期就能检查非法值。
 */
export type MessageRole =
  | 'user'        // 用户发送的消息
  | 'assistant'   // 大模型/Agent 的回复
  | 'tool'        // 工具调用或工具结果
  | 'error'       // 错误提示
  | 'status'      // 状态提示（如 compacting）
  | 'info'        // 普通信息
  | 'warning'     // 警告信息
  | 'plan'        // 计划/方案消息
  | 'auth-request'; // 认证请求（需要用户输入凭证）

/**
 * 凭证输入模式。
 *
 * 不同 API/MCP 认证方式对应不同的 UI 输入框：
 * - bearer：单个 Token/API Key 输入框
 * - basic：用户名 + 密码
 * - header：自定义 Header 名 + 值
 * - query：URL query 参数
 * - multi-header：多个 Header 字段（如 DataDog 需要两个 key）
 */
export type CredentialInputMode =
  | 'bearer'
  | 'basic'
  | 'header'
  | 'query'
  | 'multi-header';

/**
 * 认证请求类型。
 *
 * Agent 需要连接外部服务时会触发认证流程，UI 根据这个类型展示不同的授权界面。
 */
export type AuthRequestType =
  | 'credential'     // 普通凭证
  | 'oauth'          // 通用 OAuth
  | 'oauth-google'   // Google OAuth
  | 'oauth-slack'    // Slack OAuth
  | 'oauth-microsoft'; // Microsoft OAuth

/**
 * 认证请求的状态机。
 */
export type AuthStatus = 'pending' | 'completed' | 'cancelled' | 'failed';

/**
 * 工具执行状态。
 *
 * Agent 调用外部工具（Bash、文件操作、MCP、API）时，UI 需要实时展示进度。
 */
export type ToolStatus = 'pending' | 'executing' | 'completed' | 'error' | 'backgrounded';

/**
 * 工具展示元数据。
 *
 * 在落盘时就把图标等信息写进去，这样 Craft 文档查看器（viewer）打开时不需要重新加载。
 * icon 用 base64 data URL，保证 Electron 端和 Web 端都能直接显示。
 */
export interface ToolDisplayMeta {
  /** 工具展示名，如 "Commit"、"Linear" */
  displayName: string;
  /** base64 编码的图标 data URL，建议 32x32px */
  iconDataUrl?: string;
  /** 工具功能描述 */
  description?: string;
  /** 分组/样式分类 */
  category?: 'skill' | 'source' | 'native' | 'mcp';
}

/**
 * 附件类型分类。
 */
export type AttachmentType = 'image' | 'text' | 'pdf' | 'office' | 'audio' | 'unknown';

/**
 * 用户消息里的附件预览（运行时，尚未落盘）。
 *
 * 这里可能包含 base64 缩略图；落盘时会转成 StoredAttachment，把文件存到本地磁盘。
 */
export interface MessageAttachment {
  type: AttachmentType;
  name: string;
  mimeType: string;
  size: number;
  base64?: string;  // 用于图片缩略图预览
}

/**
 * Content badge for inline display in user messages
 * Badges are self-contained with all display data (label, icon)
 */
export interface ContentBadge {
  /** Badge type - used for fallback icon if iconBase64 not available */
  type: 'source' | 'skill' | 'context' | 'command' | 'file' | 'folder';
  /** Display label (e.g., "Linear", "Commit") */
  label: string;
  /** Original text pattern (e.g., "@linear", "@commit") */
  rawText: string;
  /** Icon as data URL (e.g., "data:image/png;base64,...") - preserves mime type */
  iconDataUrl?: string;
  /** Start position in content string */
  start: number;
  /** End position in content string */
  end: number;
  /**
   * Collapsed label for context badges (e.g., "Edit: Permissions")
   * When set, the badge replaces the entire marked range with this label
   * and hides the original content
   */
  collapsedLabel?: string;
  /**
   * File path for file badges - stores the full path for click handler
   * Used when the badge represents a clickable file reference
   */
  filePath?: string;
}

/**
 * Author metadata for annotations
 */
export interface AnnotationAuthor {
  id: string;
  name?: string;
  type?: 'user' | 'agent' | 'system';
}

/**
 * Annotation body payloads (extensible)
 */
export type AnnotationBody =
  | { type: 'highlight' }
  | { type: 'note'; text: string; format?: 'plain' | 'markdown' }
  | { type: 'tag'; value: string };

/**
 * Annotation intent (tight v1 semantics).
 */
export type AnnotationIntent = 'highlight' | 'comment' | 'question';

/**
 * Optional lifecycle status for annotation workflows.
 */
export type AnnotationStatus = 'pending' | 'acknowledged' | 'resolved' | 'dismissed';

/**
 * Block types for block selectors.
 */
export type AnnotationBlockType =
  | 'paragraph'
  | 'code'
  | 'latex'
  | 'mermaid'
  | 'datatable'
  | 'spreadsheet'
  | 'image-preview'
  | 'pdf-preview'
  | 'html-preview';

/**
 * Selector union used to anchor an annotation target.
 * Multiple selectors can be stored for robust fallback resolution.
 */
export type AnnotationSelector =
  | {
      type: 'text-quote';
      exact: string;
      prefix?: string;
      suffix?: string;
    }
  | {
      type: 'text-position';
      start: number;
      end: number;
      textVersion?: string;
    }
  | {
      type: 'block';
      blockType: AnnotationBlockType;
      path: string;
      blockId?: string;
    }
  | {
      type: 'xywh';
      unit: 'pixel' | 'percent';
      x: number;
      y: number;
      w: number;
      h: number;
      page?: number;
      rotation?: number;
    }
  | {
      type: 'table-cell';
      rowKey: string | number;
      columnKey: string;
    };

/**
 * Annotation target definition.
 */
export interface AnnotationTarget {
  source: {
    sessionId: string;
    messageId: string;
  };
  selectors: AnnotationSelector[];
}

/**
 * Persisted annotation payload (schema-versioned for migration safety).
 */
export interface AnnotationV1 {
  id: string;
  schemaVersion: 1;
  createdAt: number;
  updatedAt?: number;
  createdBy?: AnnotationAuthor;
  deletedAt?: number;
  body: AnnotationBody[];
  target: AnnotationTarget;
  /** Optional workflow intent (tight v1 semantics). */
  intent?: AnnotationIntent;
  /** Optional lifecycle status. */
  status?: AnnotationStatus;
  /** Optional reference to the conversation/thread around this annotation. */
  threadRef?: {
    threadId?: string;
    sessionId?: string;
  };
  style?: {
    color?: 'yellow' | 'green' | 'blue' | 'pink' | string;
    opacity?: number;
  };
  meta?: Record<string, unknown>;
}

/**
 * 已落盘的附件元数据（不再内嵌 base64）。
 *
 * 用户发送附件后，Electron 端会把文件复制到工作区目录，只存路径和元数据。
 * 这和 Golang 的 DTO 思路一样：运行时对象可以胖，持久化对象要瘦。
 */
export interface StoredAttachment {
  id: string;                    // 唯一标识
  type: AttachmentType;
  name: string;                  // 原始文件名
  mimeType: string;
  size: number;                  // 最终大小（缩放后）
  originalSize?: number;         // 缩放前原始大小
  storedPath: string;            // 本地磁盘完整路径
  thumbnailPath?: string;        // 系统生成的缩略图路径（图片/PDF/Office）
  thumbnailBase64?: string;      // 供渲染端显示的 base64 PNG 缩略图
  markdownPath?: string;         // Office 文件转换后的 markdown 路径，传给 Claude
  wasResized?: boolean;          // 是否因 Claude API 限制被自动缩放
  resizedBase64?: string;        // 缩放后的 base64，仅 wasResized=true 时使用
}

/**
 * 运行时消息类型（包含 isStreaming 等瞬态字段）。
 *
 * 这是整个应用里最常用的类型，相当于聊天消息的"领域实体"。
 * 注意 TS interface 所有字段默认都是可访问的，不像 Golang struct 字段可以强制小写私有；
 * 约定上可选字段用 `?` 标记。
 */
export interface Message {
  id: string;
  role: MessageRole;
  content: string;
  timestamp: number;

  // ---------- 工具调用相关字段 ----------
  toolName?: string;
  toolUseId?: string;
  toolInput?: Record<string, unknown>; // TS 版 map[string]any，key 是 string，值未知
  toolResult?: string;
  toolStatus?: ToolStatus;
  toolDuration?: number;
  toolIntent?: string;
  toolDisplayName?: string;
  /** 工具展示元数据（落盘时内嵌，方便 viewer 直接显示） */
  toolDisplayMeta?: ToolDisplayMeta;
  /** 父工具 ID，用于嵌套工具调用（如 Task 子代理里的子工具） */
  parentToolUseId?: string;

  // ---------- 后台任务相关字段 ----------
  taskId?: string;          // Task 工具的 run_in_background 任务 ID
  shellId?: string;         // Bash 工具的 run_in_background shell ID
  elapsedSeconds?: number;  // 实时进度秒数
  isBackground?: boolean;   // UI 用来区分后台任务消息

  // ---------- 附件与徽章 ----------
  attachments?: StoredAttachment[];
  badges?: ContentBadge[];  // @source / @skill 等内联徽章

  /** 消息上的批注/标注 */
  annotations?: AnnotationV1[];

  isError?: boolean;
  isStreaming?: boolean;

  /**
   * Pending 标记：
   * - 流式文本刚创建但尚未收到 text_complete 时设为 true
   * - 乐观更新用户消息时也会在 backend 确认前设为 true
   */
  isPending?: boolean;

  /** 当前 Agent 正在回复时，用户又发了一条消息，会进入队列等待处理 */
  isQueued?: boolean;

  /** 中间文本（工具调用之间的 commentary，不是最终回复） */
  isIntermediate?: boolean;
  // hidden：系统生成的、必须送达模型（驱动一次 turn）但绝不能在消息列表里渲染为气泡的消息。
  // 例如 WS2 的后台任务完成提醒——它会唤醒一个空闲 session 来展示已完成的后台 agent 结果。
  // 该字段在 groupMessagesByTurn 中被过滤掉，因此它永远不会以用户/助手气泡的形式出现（桌面端 + viewer）。
  hidden?: boolean;
  // Turn ID：来自 API message.id 的关联 ID，把一次 assistant turn 里的所有消息归为一组
  turnId?: string;

  /** 特殊状态消息类型，如 compacting（会话压缩中） */
  statusType?: 'compacting' | 'compaction_complete';

  /** 信息级别，决定图标和颜色 */
  infoLevel?: 'info' | 'warning' | 'error' | 'success';

  // ---------- 类型化错误相关字段 ----------
  errorCode?: string;
  errorTitle?: string;
  errorDetails?: string[];
  errorOriginal?: string;
  errorCanRetry?: boolean;
  errorActions?: Array<{
    key: string;
    label: string;
    action?: 'retry' | 'settings' | 'reauth' | 'open_url' | 'reconnect_source';
    url?: string;
    sourceSlug?: string;
  }>;

  // ---------- Plan 消息相关字段 ----------
  planPath?: string;  // Plan markdown 文件路径

  // ---------- 认证请求相关字段（role='auth-request'） ----------
  authRequestId?: string;
  authRequestType?: AuthRequestType;
  authSourceSlug?: string;
  authSourceName?: string;
  authStatus?: AuthStatus;
  authCredentialMode?: CredentialInputMode;
  authHeaderName?: string;
  authHeaderNames?: string[];
  authLabels?: {
    credential?: string;
    username?: string;
    password?: string;
  };
  authDescription?: string;
  authHint?: string;
  authSourceUrl?: string;         // 供 1Password 等密码管理器做域名匹配
  authPasswordRequired?: boolean; // basic 认证时密码是否必填，默认 true
  authError?: string;
  authEmail?: string;             // OAuth 后返回的邮箱
  authWorkspace?: string;         // Slack OAuth 后返回的工作区
}

/**
 * 持久化消息格式。
 *
 * 与 Message 相比，去掉了 isStreaming、isPending 等运行时瞬态字段，
 * 并把 `role` 改名为 `type`（历史原因）。
 */
export interface StoredMessage {
  id: string;
  type: MessageRole;
  content: string;
  timestamp?: number;

  // 工具调用相关字段（与 Message 对应）
  toolName?: string;
  toolUseId?: string;
  toolInput?: Record<string, unknown>;
  toolResult?: string;
  toolStatus?: ToolStatus;
  toolDuration?: number;
  toolIntent?: string;
  toolDisplayName?: string;
  toolDisplayMeta?: ToolDisplayMeta;
  parentToolUseId?: string;

  // 后台任务字段（需要持久化，方便恢复后继续显示进度）
  taskId?: string;
  shellId?: string;
  elapsedSeconds?: number;
  isBackground?: boolean;
  isError?: boolean;

  attachments?: StoredAttachment[];
  badges?: ContentBadge[];
  annotations?: AnnotationV1[];

  /** Turn 分组，会话恢复后渲染 TurnCard 的关键字段 */
  isIntermediate?: boolean;
  turnId?: string;

  statusType?: 'compacting' | 'compaction_complete';
  infoLevel?: 'info' | 'warning' | 'error' | 'success';

  // 错误展示字段
  errorCode?: string;
  errorTitle?: string;
  errorDetails?: string[];
  errorOriginal?: string;
  errorCanRetry?: boolean;
  errorActions?: Array<{
    key: string;
    label: string;
    action?: 'retry' | 'settings' | 'reauth' | 'open_url' | 'reconnect_source';
    url?: string;
    sourceSlug?: string;
  }>;

  // Plan 与认证请求字段
  planPath?: string;
  authRequestId?: string;
  authRequestType?: AuthRequestType;
  authSourceSlug?: string;
  authSourceName?: string;
  authStatus?: AuthStatus;
  authCredentialMode?: CredentialInputMode;
  authHeaderName?: string;
  authHeaderNames?: string[];
  authLabels?: {
    credential?: string;
    username?: string;
    password?: string;
  };
  authDescription?: string;
  authHint?: string;
  authSourceUrl?: string;
  authPasswordRequired?: boolean;
  authError?: string;
  authEmail?: string;
  authWorkspace?: string;

  /** 排队中的用户消息也需要持久化，崩溃恢复后能继续处理 */
  isQueued?: boolean;
}

/**
 * Token 使用量统计。
 *
 * 对应 LLM API 返回的 usage 字段，用来计费、显示和限制上下文长度。
 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  contextTokens: number;
  costUsd: number;
  cacheReadTokens?: number;      // Anthropic prompt cache 读命中
  cacheCreationTokens?: number;  // Anthropic prompt cache 创建
}

/**
 * 错误恢复操作。
 *
 * Agent 遇到错误时，UI 会展示一个或多个可点击的恢复动作，
 * 比如"重试"、"打开设置"、"重新授权"。
 */
export interface RecoveryAction {
  /** 键盘快捷键（单个字母） */
  key: string;
  /** 动作描述 */
  label: string;
  /** 斜杠命令，如 '/settings' */
  command?: string;
  /** 动作类型，UI 据此做特殊处理 */
  action?: 'retry' | 'settings' | 'reauth' | 'open_url' | 'reconnect_source';
  /** open_url 动作要打开的链接 */
  url?: string;
  /** reconnect_source 动作对应的 source 标识 */
  sourceSlug?: string;
}

/**
 * Agent 错误的错误码枚举。
 *
 * 必须与 packages/shared/src/agent/errors.ts 里的 AgentError.code 保持一致。
 * 用字符串联合类型而不是 enum，是 TS 项目常见做法，生成的 JS 更干净。
 */
export type ErrorCode =
  | 'invalid_api_key'
  | 'invalid_credentials'
  | 'response_too_large'
  | 'expired_oauth_token'
  | 'token_expired'
  | 'rate_limited'
  | 'service_error'
  | 'service_unavailable'
  | 'network_error'
  | 'proxy_error'                  // 代理/防火墙/强制门户拦截
  | 'mcp_auth_required'
  | 'mcp_unreachable'
  | 'billing_error'
  | 'model_no_tool_support'        // 模型不支持 function calling
  | 'invalid_model'                // 模型 ID 不存在
  | 'data_policy_error'            // OpenRouter 数据策略限制
  | 'invalid_request'              // API 拒绝请求（如图片不合法）
  | 'image_too_large'              // 图片超过尺寸限制
  | 'provider_error'               // AI provider 自身问题
  | 'queued_message_replay_failed' // 活跃 turn 中排队的消息自动重放失败
  | 'sdk_binary_missing'           // SDK 子进程二进制缺失
  | 'sdk_cwd_missing'              // SDK 子进程工作目录缺失
  | 'unknown_error';

/**
 * Agent 返回的类型化错误。
 *
 * 相比普通 Error 对象，多了 code/actions/canRetry 等结构化信息，
 * 方便 UI 做针对性处理（如 rate_limited 显示倒计时重试）。
 */
export interface TypedError {
  code: ErrorCode;
  title: string;
  message: string;
  actions: RecoveryAction[];
  canRetry: boolean;
  retryDelayMs?: number;
  details?: string[];
  originalError?: string;
}

/**
 * 权限请求类型。
 *
 * Agent 执行有副作用的操作前（如执行 bash、写文件、调用 MCP 写入接口）会向用户申请权限。
 */
export type PermissionRequestType = 'bash' | 'file_write' | 'mcp_mutation' | 'api_mutation' | 'admin_approval';

/**
 * 权限请求数据。
 *
 * 例如执行 bash 命令前，Agent 会发一个 permission_request 事件，
 * UI 弹出确认框，用户同意后才会真正执行。
 */
export interface PermissionRequest {
  requestId: string;
  toolName: string;
  command?: string;  // bash 命令才有，MCP 工具可能没有
  description: string;
  type?: PermissionRequestType;
  appName?: string;
  reason?: string;
  impact?: string;
  requiresSystemPrompt?: boolean; // 是否需要系统级认证弹窗
  rememberForMinutes?: number;    // 记住授权的时间窗口
  commandHash?: string;           // 用于授权完整性校验
  approvalTtlSeconds?: number;    // 授权有效期
}

/**
 * Agent 完成一次 turn 时发出的用量数据。
 *
 * 注意：totalTokens/contextTokens 由消费端自行计算，这里只发原始字段。
 */
export interface AgentEventUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  costUsd?: number;
  contextWindow?: number; // 模型上下文窗口大小
}

/**
 * Agent 在聊天过程中发出的所有事件。
 *
 * 这是 Agent 层与 UI 层之间的核心通信协议。
 * 后端可以把 AgentEvent 理解为 SSE/WebSocket 推送的消息结构体，
 * UI 订阅这些事件并更新界面。
 *
 * turnId：来自 API message.id 的关联 ID，把一次 assistant turn 内的所有事件归为一组。
 */
export type AgentEvent =
  // 状态/信息事件
  | { type: 'status'; message: string }
  | { type: 'info'; message: string }

  // 文本流事件
  | { type: 'text_delta'; text: string; turnId?: string; parentToolUseId?: string }
  | { type: 'text_complete'; text: string; isIntermediate?: boolean; turnId?: string; parentToolUseId?: string; sdkMessageId?: string }

  // Pi SDK 专用：turn 锚点
  | { type: 'pi_turn_anchor'; sdkMessageId: string; sdkTurnAnchor: string }

  // 工具调用事件
  | { type: 'tool_start'; toolName: string; toolUseId: string; input: Record<string, unknown>; intent?: string; displayName?: string; turnId?: string; parentToolUseId?: string; toolDisplayMeta?: ToolDisplayMeta }
  | { type: 'tool_result'; toolUseId: string; toolName?: string; result: string; isError: boolean; input?: Record<string, unknown>; turnId?: string; parentToolUseId?: string }

  // 权限请求事件
  | {
      type: 'permission_request';
      requestId: string;
      toolName: string;
      command?: string;
      description: string;
      permissionType?: PermissionRequestType;
      appName?: string;
      reason?: string;
      impact?: string;
      requiresSystemPrompt?: boolean;
      rememberForMinutes?: number;
      commandHash?: string;
      approvalTtlSeconds?: number;
    }

  // 错误事件
  | { type: 'error'; message: string }
  | { type: 'typed_error'; error: TypedError }

  // Turn 完成事件
  | { type: 'complete'; usage?: AgentEventUsage }

  // 工作目录变更
  | { type: 'working_directory_changed'; workingDirectory: string }
  // 后台任务事件
  | { type: 'task_backgrounded'; toolUseId: string; taskId: string; intent?: string; turnId?: string; kind?: 'workflow'; workflowId?: string }
  | { type: 'shell_backgrounded'; toolUseId: string; shellId: string; intent?: string; command?: string; turnId?: string }
  | { type: 'task_progress'; toolUseId: string; elapsedSeconds: number; turnId?: string }
  | { type: 'task_completed'; taskId: string; status: 'completed' | 'failed' | 'stopped'; outputFile?: string; summary?: string; turnId?: string }
  | { type: 'workflow_agent_completed'; workflowId: string; agentId: string; turnId?: string }
  | { type: 'shell_killed'; shellId: string; turnId?: string }

  // Source 激活事件
  | { type: 'source_activated'; sourceSlug: string; originalMessage: string }

  // 用量更新
  | { type: 'usage_update'; usage: Pick<AgentEventUsage, 'inputTokens' | 'contextWindow'> }

  // 用户 steer 消息未送达
  | { type: 'steer_undelivered'; message: string };

/**
 * 生成唯一消息 ID。
 *
 * 用时间戳 + 随机数拼接，简单但足够唯一（同毫秒冲突概率极低）。
 * Golang 里你可能会用 uuid.NewString()，这里为了保持可读性用了更短的 ID。
 */
export function generateMessageId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
