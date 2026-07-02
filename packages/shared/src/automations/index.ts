/**
 * Craft Agent Automations - 公共 API 入口
 *
 * 这是一个 barrel 文件，从各个子模块重新导出：
 * - types.ts：所有类型定义
 * - validation.ts：配置校验函数
 * - sdk-bridge.ts：SDK 环境变量构建
 * - utils.ts：共享工具（toSnakeCase、expandEnvVars 等）
 * - automation-system.ts：AutomationSystem 外观类（主入口）
 * - event-bus.ts：WorkspaceEventBus
 * - handlers/：PromptHandler、WebhookHandler、EventLogHandler
 */

// ============================================================================
// 类型
// ============================================================================

export type {
  AppEvent,
  AgentEvent,
  AutomationEvent,
  PromptAction,
  WebhookAction,
  WebhookHttpMethod,
  WebhookBodyFormat,
  WebhookAuth,
  AutomationAction,
  AutomationMatcher,
  AutomationsConfig,
  PromptReferences,
  PromptActionResult,
  WebhookActionResult,
  ActionExecutionResult,
  PendingPrompt,
  AutomationResult,
  AutomationsValidationResult,
  SdkAutomationInput,
  SdkAutomationCallback,
  SdkAutomationCallbackMatcher,
  SessionMetadataSnapshot,
  TimeCondition,
  StateCondition,
  LogicalCondition,
  AutomationCondition,
} from './types.ts';

export { APP_EVENTS, AGENT_EVENTS } from './types.ts';

// ============================================================================
// 校验
// ============================================================================

export {
  validateAutomationsConfig,
  validateAutomationsContent,
  validateAutomations,
} from './validation.ts';

// ============================================================================
// SDK Bridge（SDK 桥接）
// ============================================================================

export { buildEnvFromSdkInput } from './sdk-bridge.ts';

// ============================================================================
// 工具
// ============================================================================

export { parsePromptReferences } from './utils.ts';

// ============================================================================
// 子模块重新导出
// ============================================================================

// 事件日志
export { AutomationEventLogger, type LoggedAutomationEvent, type LoggedAutomationEventInput } from './event-logger.ts';

// Schema
export { AutomationsConfigSchema, AutomationConditionSchema, TimeConditionSchema, StateConditionSchema, zodErrorToIssues, VALID_EVENTS } from './schemas.ts';

// 条件求值器
export { evaluateConditions, type ConditionContext } from './conditions.ts';

// 安全工具
export { sanitizeForShell } from './security.ts';

// Webhook 执行工具
export { executeWebhookRequest, executeWithRetry, createWebhookHistoryEntry, createPromptHistoryEntry, type ExecuteWebhookOptions, type RetryConfig } from './webhook-utils.ts';

// 重试调度器
export { RetryScheduler, type RetryQueueEntry, type RetrySchedulerOptions } from './retry-scheduler.ts';

// 配置常量
export { AUTOMATIONS_CONFIG_FILE, AUTOMATIONS_HISTORY_FILE, AUTOMATIONS_RETRY_QUEUE_FILE, HISTORY_FIELD_MAX_LENGTH, AUTOMATION_HISTORY_MAX_RUNS_PER_MATCHER, AUTOMATION_HISTORY_MAX_ENTRIES } from './constants.ts';

// 历史存储
export { appendAutomationHistoryEntry, compactAutomationHistory, compactAutomationHistorySync } from './history-store.ts';

// 配置路径解析
export { resolveAutomationsConfigPath, generateShortId } from './resolve-config-path.ts';

// Cron 匹配
export { matchesCron } from './cron-matcher.ts';

// 事件总线
export {
  WorkspaceEventBus,
  type EventBus,
  type EventPayloadMap,
  type BaseEventPayload,
  type LabelEventPayload,
  type PermissionModeChangePayload,
  type FlagChangePayload,
  type SessionStatusChangePayload,
  type SchedulerTickPayload,
  type LabelConfigChangePayload,
  type GenericEventPayload,
  type EventHandler,
  type AnyEventHandler,
} from './event-bus.ts';

// AutomationSystem 外观类
export {
  AutomationSystem,
  type AutomationSystemOptions,
  type SessionMetadataSnapshot as AutomationSystemMetadataSnapshot,
} from './automation-system.ts';

// Handlers（处理器）
export {
  PromptHandler,
  EventLogHandler,
  WebhookHandler,
  type AutomationHandler,
  type PromptHandlerOptions,
  type EventLogHandlerOptions,
  type WebhookHandlerOptions,
  type AutomationsConfigProvider,
} from './handlers/index.ts';
