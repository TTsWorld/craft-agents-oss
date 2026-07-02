/**
 * 自动化系统类型定义
 *
 * 所有类型、接口和类型导出都集中在这里。
 */

import type { PermissionMode } from '../agent/mode-types.ts';
import type { ThinkingLevel } from '../agent/thinking-levels.ts';

// ============================================================================
// 事件类型
// ============================================================================

/** App 事件 - 由 Craft 内部处理 */
export type AppEvent =
  | 'LabelAdd'
  | 'LabelRemove'
  | 'LabelConfigChange'
  | 'PermissionModeChange'
  | 'FlagChange'
  | 'SessionStatusChange'
  | 'SchedulerTick';

/** Agent 事件 - 会传给 Claude SDK 的 hook */
export type AgentEvent =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'Notification'
  | 'UserPromptSubmit'
  | 'SessionStart'
  | 'SessionEnd'
  | 'Stop'
  | 'SubagentStart'
  | 'SubagentStop'
  | 'PreCompact'
  | 'PermissionRequest'
  | 'Setup';

export type AutomationEvent = AppEvent | AgentEvent;

export const APP_EVENTS: AppEvent[] = [
  'LabelAdd', 'LabelRemove', 'LabelConfigChange',
  'PermissionModeChange', 'FlagChange', 'SessionStatusChange', 'SchedulerTick'
];

export const AGENT_EVENTS: AgentEvent[] = [
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Notification',
  'UserPromptSubmit', 'SessionStart', 'SessionEnd', 'Stop',
  'SubagentStart', 'SubagentStop', 'PreCompact', 'PermissionRequest', 'Setup'
];

// ============================================================================
// 动作定义
// ============================================================================

/** Prompt 动作：向 Craft Agent 发送一条 prompt */
export interface PromptAction {
  type: 'prompt';
  prompt: string;
  /** 新建会话使用的 LLM connection slug（找不到则回退到默认） */
  llmConnection?: string;
  /** 新建会话使用的模型 ID（无效则回退到 provider 默认） */
  model?: string;
  /**
   * 新建会话的思考级别。
   * 省略时先回退 workspace 默认，再回退 DEFAULT_THINKING_LEVEL。
   */
  thinkingLevel?: ThinkingLevel;
}

/** Webhook 动作的 HTTP 方法 */
export type WebhookHttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** Webhook 动作的请求体格式 */
export type WebhookBodyFormat = 'json' | 'form' | 'raw';

/** Webhook 动作的认证简写 */
export type WebhookAuth =
  | { type: 'basic'; username: string; password: string }
  | { type: 'bearer'; token: string };

/** Webhook 动作：向某个端点发送 HTTP 请求 */
export interface WebhookAction {
  type: 'webhook';
  /** 目标 URL（http 或 https） */
  url: string;
  /** HTTP 方法，默认 POST */
  method?: WebhookHttpMethod;
  /** 请求头键值对 */
  headers?: Record<string, string>;
  /** 请求体格式：json 发 application/json，form 做 URL 编码，raw 原样发送 */
  bodyFormat?: WebhookBodyFormat;
  /** 请求体 - json/form 格式时为对象，raw 格式时为字符串 */
  body?: unknown;
  /** 是否在结果中截取响应体（最多 4KB），默认 false */
  captureResponse?: boolean;
  /** 认证简写（会先应用，再应用自定义 headers，因此 headers 可覆盖） */
  auth?: WebhookAuth;
}

export type AutomationAction = PromptAction | WebhookAction;

// ============================================================================
// 条件类型
// ============================================================================

/** 时间和星期条件 */
export interface TimeCondition {
  condition: 'time';
  /** 开始时间，24 小时制 HH:MM */
  after?: string;
  /** 结束时间，24 小时制 HH:MM */
  before?: string;
  /** 星期，3 字母小写：mon/tue/wed/thu/fri/sat/sun */
  weekday?: string[];
  /** IANA 时区（先回退 matcher 时区，再回退系统本地时区） */
  timezone?: string;
}

/** 状态/字段检查条件，支持 HA 风格的 from/to transition */
export interface StateCondition {
  condition: 'state';
  /** 要检查的字段名，例如 'permissionMode'、'sessionStatus'、'labels'、'isFlagged' */
  field: string;
  /** 精确值匹配 */
  value?: unknown;
  /** Transition：旧值（通过 TRANSITION_FIELDS 映射） */
  from?: unknown;
  /** Transition：新值（通过 TRANSITION_FIELDS 映射） */
  to?: unknown;
  /** 数组包含检查 */
  contains?: string;
  /** 取反：匹配除该值外的任何值 */
  not_value?: unknown;
}

/** 逻辑组合条件（与/或/非） */
export interface LogicalCondition {
  condition: 'and' | 'or' | 'not';
  conditions: AutomationCondition[];
}

/** 所有条件类型的联合 */
export type AutomationCondition = TimeCondition | StateCondition | LogicalCondition;

// ============================================================================
// Matcher 定义
// ============================================================================

export interface AutomationMatcher {
  /** 6 位十六进制短 ID，用于配置变更后仍能稳定标识同一个 matcher */
  id?: string;
  /** 可选显示名。省略时从第一个 action 推导。 */
  name?: string;
  /** 用于匹配事件数据的正则（SchedulerTick 不使用） */
  matcher?: string;
  /** SchedulerTick 事件使用的 cron 表达式（5 字段格式） */
  cron?: string;
  /** cron 求值使用的 IANA 时区，例如 "Europe/Budapest" */
  timezone?: string;
  /** prompt action 创建会话的权限模式 */
  permissionMode?: PermissionMode;
  /** prompt action 创建会话要附加的标签 */
  labels?: string[];
  /** 该 matcher 是否启用，默认 true；设为 false 可在不删除的情况下禁用 */
  enabled?: boolean;
  /** 可选条件：matcher 匹配后、action 触发前必须全部通过（AND） */
  conditions?: AutomationCondition[];
  /**
   * 可选 Telegram 论坛主题名。
   * 设置后，该 matcher 创建的会话会绑定到 workspace 配对超级群中的对应主题。
   * 首次使用时创建主题，之后复用；多个 matcher 使用相同值会共享一个主题。
   *
   * 以下情况会被静默忽略：
   *   - Settings → Messaging → Telegram 中没有配对超级群
   *   - Telegram 机器人未连接
   *   - 机器人在超级群中没有“管理主题”权限
   */
  telegramTopic?: string;
  actions: AutomationAction[];
}

export interface AutomationsConfig {
  automations: Partial<Record<AutomationEvent, AutomationMatcher[]>>;
}

// ============================================================================
// 动作结果
// ============================================================================

/** 从 prompt 中解析出的 @name 引用（source 和 skill 都用 @name 语法） */
export interface PromptReferences {
  /**
   * prompt 中找到的所有 @name 引用。
   * 可能是 source（如 @linear、@github）或 skill（如 @commit、@review-pr）。
   * 调用方需根据可用配置判断哪些是 source、哪些是 skill。
   */
  mentions: string[];
}

/** Prompt 动作的结果：把展开后的 prompt 返回给调用方执行 */
export interface PromptActionResult {
  type: 'prompt';
  prompt: string;
  /** 已替换环境变量的展开后 prompt */
  expandedPrompt: string;
  /** prompt 中引用的 source/skill */
  references: PromptReferences;
}

/** Webhook 动作的结果 */
export interface WebhookActionResult {
  type: 'webhook';
  /** 实际调用的 URL */
  url: string;
  /** 响应 HTTP 状态码 */
  statusCode: number;
  /** 请求是否成功（2xx 状态） */
  success: boolean;
  /** 失败时的错误信息 */
  error?: string;
  /** 尝试次数（1 表示未重试，2+ 表示重试过） */
  attempts?: number;
  /** 含重试在内的总耗时（毫秒） */
  durationMs?: number;
  /** 截取的响应体（仅在 captureResponse 为 true 时存在，最多 4KB） */
  responseBody?: string;
}

export type ActionExecutionResult = PromptActionResult | WebhookActionResult;

/** 待执行的 prompt 及其元数据 */
export interface PendingPrompt {
  /** 该 prompt 要发送到的会话 ID */
  sessionId: string | undefined;
  /** 来源 matcher ID */
  matcherId?: string;
  /** 人类可读的自动化名（来自 matcher.name 或推导） */
  automationName?: string;
  /** 展开后的 prompt 文本 */
  prompt: string;
  /**
   * prompt 中找到的所有 @mention（source 和 skill）。
   * 调用方需根据可用配置解析哪些是 source/skill。
   */
  mentions: string[];
  /** 要附加到新建会话的标签 */
  labels?: string[];
  /** 新建会话的权限模式（来自 matcher 配置） */
  permissionMode?: PermissionMode;
  /** 新建会话使用的 LLM connection slug（找不到则回退默认） */
  llmConnection?: string;
  /** 新建会话使用的模型 ID（无效则回退 provider 默认） */
  model?: string;
  /** 新建会话的思考级别（省略则回退 workspace 默认） */
  thinkingLevel?: ThinkingLevel;
  /** 新建会话要绑定的 Telegram 论坛主题名（仅在配对超级群时生效） */
  telegramTopic?: string;
}

export interface AutomationResult {
  event: string;
  matched: number;
  results: ActionExecutionResult[];
  /** 应由 Craft Agent 执行的 prompt（含元数据） */
  pendingPrompts: PendingPrompt[];
}

// ============================================================================
// 验证类型
// ============================================================================

/** 内部验证结果，包含解析后的配置 */
export type AutomationsValidationResult = {
  valid: boolean;
  errors: string[];
  config: AutomationsConfig | null;
};

// ============================================================================
// SDK 类型
// ============================================================================

/**
 * SDK 自动化输入类型 - 所有可能的 SDK 事件输入的联合。
 */
export interface SdkAutomationInput {
  hook_event_name: string;
  // 工具事件
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: string;
  tool_use_id?: string;
  // 会话事件
  source?: string;  // startup, resume, clear, compact
  model?: string;
  // 子代理事件
  agent_id?: string;
  agent_type?: string;
  // 用户 prompt 事件
  prompt?: string;
  // 通知事件
  message?: string;
  title?: string;
  // 错误事件
  error?: string;
}

/**
 * SDK 自动化回调签名（与 Claude SDK 的 HookCallback 类型对应）。
 */
export type SdkAutomationCallback = (
  input: SdkAutomationInput,
  toolUseId: string,
  options: { signal?: AbortSignal }
) => Promise<{ continue: boolean; reason?: string }>;

/**
 * SDK automation matcher 格式（与 Claude SDK 的 HookCallbackMatcher 类型对应）。
 * 注意：hooks 字段名保持与 Claude SDK 接口一致。
 */
export interface SdkAutomationCallbackMatcher {
  matcher?: string;
  timeout?: number;
  hooks: SdkAutomationCallback[];
}

// ============================================================================
// 会话元数据
// ============================================================================

/**
 * 轻量级会话元数据，仅包含会触发自动化的字段。
 * 用于前后两次快照 diff，判断要不要发事件。
 */
export interface SessionMetadataSnapshot {
  permissionMode?: string;
  labels?: string[];
  isFlagged?: boolean;
  sessionStatus?: string;
  /** 会话名称（用户定义或自动生成） */
  sessionName?: string;
}
