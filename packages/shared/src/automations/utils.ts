/**
 * 自动化系统共享工具
 *
 * 同时被旧式函数 API（index.ts）和新的事件总线 handler
 *（command-handler.ts、prompt-handler.ts）使用的公共辅助函数。
 */

import type { BaseEventPayload } from './event-bus.ts';
import type { AutomationEvent, AutomationMatcher, PromptReferences, AgentEvent, SdkAutomationInput } from './types.ts';
import { matchesCron } from './cron-matcher.ts';
import { sanitizeForShell } from './security.ts';
import { evaluateConditions } from './conditions.ts';

// ============================================================================
// 字符串工具
// ============================================================================

/**
 * 把 camelCase 转成 SNAKE_CASE。
 *
 * @example
 * toSnakeCase('newStatus') // 'new_status'
 * toSnakeCase('toolName')  // 'tool_name'
 */
export function toSnakeCase(str: string): string {
  return str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

/**
 * 展开字符串中的环境变量。
 * 支持 $VAR 和 ${VAR} 两种语法。
 *
 * @example
 * expandEnvVars('Hello $NAME', { NAME: 'World' }) // 'Hello World'
 * expandEnvVars('${GREETING} World', { GREETING: 'Hi' }) // 'Hi World'
 */
export function expandEnvVars(str: string, env: Record<string, string>): string {
  return str
    // 替换 ${VAR} 语法
    .replace(/\$\{([^}]+)\}/g, (_, varName) => env[varName] ?? '')
    // 替换 $VAR 语法（单词边界）
    .replace(/\$([A-Z_][A-Z0-9_]*)/gi, (_, varName) => env[varName] ?? '');
}

// ============================================================================
// Prompt 工具
// ============================================================================

/**
 * 从 prompt 中解析 @mention（source 和 skill 都使用 @name 语法）。
 *
 * 语法：
 * - @name - 引用 source 或 skill，例如 @linear、@github、@commit、@review-pr
 *
 * 引用不区分大小写，支持连字符（如 @my-source）。
 * 调用方需根据可用配置判断哪些是 source、哪些是 skill。
 */
export function parsePromptReferences(prompt: string): PromptReferences {
  const mentions: string[] = [];

  // 匹配 @name（单词字符和连字符）
  // 要求 @ 前面是空白或字符串开头，避免误匹配邮箱地址
  const matches = prompt.matchAll(/(?:^|[\s(])@([a-zA-Z][a-zA-Z0-9-]*)/g);
  for (const match of matches) {
    const captured = match[1];
    if (captured) {
      const mention = captured.toLowerCase();
      if (!mentions.includes(mention)) {
        mentions.push(mention);
      }
    }
  }

  return { mentions };
}

// ============================================================================
// 事件匹配工具
// ============================================================================

/**
 * 根据事件类型获取用于正则匹配的值。
 * 对工具事件会回退到 data.data?.tool_name。
 *
 * 同时接受普通数据对象（旧 API）和 BaseEventPayload（handler API）。
 */
export function getMatchValue(event: AutomationEvent, data: Record<string, unknown>): string {
  switch (event) {
    case 'LabelAdd':
    case 'LabelRemove':
      return String(data.label ?? '');
    case 'LabelConfigChange':
      return ''; // 永远匹配
    case 'PermissionModeChange':
      return String(data.newMode ?? '');
    case 'FlagChange':
      return String(data.isFlagged ?? false);
    case 'SessionStatusChange':
      return String(data.newStatus ?? data.newState ?? '');
    case 'PreToolUse':
    case 'PostToolUse':
      return String(data.toolName ?? (data.data as Record<string, unknown>)?.tool_name ?? '');
    case 'SchedulerTick':
      // SchedulerTick 使用 cron 匹配，不走正则
      return '';
    default:
      return JSON.stringify(data);
  }
}

/**
 * 为 SDK agent 事件获取匹配值。
 * 与 Claude SDK 的 fieldToMatch 对应：每种事件类型从 input 里取特定字段做匹配。
 */
export function getMatchValueForSdkInput(event: AgentEvent, input: SdkAutomationInput): string {
  switch (event) {
    case 'PreToolUse':
    case 'PostToolUse':
    case 'PostToolUseFailure':
    case 'PermissionRequest':
      return input.tool_name ?? '';
    case 'Notification':
      return input.message ?? '';
    case 'SessionStart':
      return input.source ?? '';
    case 'SubagentStart':
    case 'SubagentStop':
      return input.agent_type ?? '';
    default:
      // UserPromptSubmit、Stop、SessionEnd 没有有意义的匹配字段
      return '';
  }
}

export interface MatcherContext {
  /** 用于正则匹配的预计算值 */
  matchValue: string;
  /** 用于条件求值的 payload */
  payload: Record<string, unknown>;
  /** 时间条件的候选时区来源 */
  matcherTimezone?: string;
}

/**
 * matcher 的基础谓词（enabled 开关 + 正则/cron）。
 * 故意标记为内部函数，不要直接从业务代码调用。
 *
 * 请使用 matcherMatchesWithContext() 或它的适配器，避免绕过 condition 校验。
 */
function matchesBasePredicate(matcher: AutomationMatcher, event: AutomationEvent, matchValue: string): boolean {
  if (matcher.enabled === false) return false;
  if (event === 'SchedulerTick') {
    return !!matcher.cron && matchesCron(matcher.cron, matcher.timezone);
  }
  if (!matcher.matcher) return true; // 没有 matcher 表示匹配所有
  try {
    return new RegExp(matcher.matcher).test(matchValue);
  } catch {
    return false; // 正则非法则跳过
  }
}

/**
 * 所有自动化入口使用的标准 matcher 求值流程。
 */
export function matcherMatchesWithContext(
  matcher: AutomationMatcher,
  event: AutomationEvent,
  context: MatcherContext,
): boolean {
  if (!matchesBasePredicate(matcher, event, context.matchValue)) return false;

  if (matcher.conditions?.length) {
    return evaluateConditions(matcher.conditions, {
      payload: context.payload,
      matcherTimezone: context.matcherTimezone ?? matcher.timezone,
    });
  }

  return true;
}

/**
 * App 事件适配器：使用标准 matcher 求值。
 */
export function matcherMatches(matcher: AutomationMatcher, event: AutomationEvent, data: Record<string, unknown>): boolean {
  return matcherMatchesWithContext(matcher, event, {
    matchValue: getMatchValue(event, data),
    payload: data,
    matcherTimezone: matcher.timezone,
  });
}

/**
 * SDK agent 事件适配器：使用标准 matcher 求值。
 */
export function matcherMatchesSdk(matcher: AutomationMatcher, event: AgentEvent, input: SdkAutomationInput): boolean {
  return matcherMatchesWithContext(matcher, event, {
    matchValue: getMatchValueForSdkInput(event, input),
    payload: input as unknown as Record<string, unknown>,
    matcherTimezone: matcher.timezone,
  });
}

// ============================================================================
// 环境变量工具
// ============================================================================

/**
 * 获取 process.env 的干净版本，过滤掉 undefined 值。
 * 避免不安全的 `process.env as Record<string, string>` 把 undefined 变成字符串 "undefined"。
 */
export function cleanEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined)
  );
}

/** 生成环境变量时要跳过的 payload 公共字段 */
const PAYLOAD_SKIP_KEYS = new Set(['sessionId', 'sessionName', 'workspaceId', 'timestamp']);

/**
 * 构建 prompt 和 webhook 动作共享的基础 CRAFT_* 环境变量。
 * 包含事件信息、会话元数据、调度器时间以及 payload 字段（未做 shell 转义）。
 */
function buildBaseEventEnv(event: AutomationEvent, payload: BaseEventPayload): Record<string, string> {
  const env: Record<string, string> = {
    CRAFT_EVENT: event,
    CRAFT_EVENT_DATA: JSON.stringify(payload),
  };

  if (payload.sessionId) env.CRAFT_SESSION_ID = payload.sessionId;
  if (payload.sessionName) env.CRAFT_SESSION_NAME = payload.sessionName;
  if (payload.workspaceId) env.CRAFT_WORKSPACE_ID = payload.workspaceId;

  // 会话元数据 JSON
  const sessionMetadata: Record<string, string> = {};
  if (payload.sessionId) sessionMetadata.id = payload.sessionId;
  if (payload.sessionName) sessionMetadata.name = payload.sessionName;
  if (Object.keys(sessionMetadata).length > 0) {
    env.CRAFT_SESSION_METADATA = JSON.stringify(sessionMetadata);
  }

  // 调度器事件的本地时间
  if (event === 'SchedulerTick') {
    const now = new Date();
    env.CRAFT_LOCAL_TIME = now.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
    env.CRAFT_LOCAL_DATE = now.toISOString().split('T')[0]!;
  }

  // 把 payload 字段导出为 CRAFT_* 变量（原始值，调用方按需转义）
  for (const [key, value] of Object.entries(payload)) {
    if (PAYLOAD_SKIP_KEYS.has(key)) continue;
    const envKey = `CRAFT_${toSnakeCase(key).toUpperCase()}`;
    env[envKey] = typeof value === 'string' ? value : String(value);
  }

  return env;
}

/**
 * 从事件 payload 构建 prompt/命令动作用的环境变量。
 * 包含完整 process.env，并对用户可控值做 shell 安全转义。
 */
export function buildEnvFromPayload(event: AutomationEvent, payload: BaseEventPayload): Record<string, string> {
  const base = buildBaseEventEnv(event, payload);
  const env: Record<string, string> = { ...cleanEnv(), ...base };

  // 对 shell 上下文中的会话名做转义
  if (payload.sessionName) env.CRAFT_SESSION_NAME = sanitizeForShell(payload.sessionName);

  // 对 payload 字段值做 shell 转义
  for (const [key, value] of Object.entries(payload)) {
    if (PAYLOAD_SKIP_KEYS.has(key)) continue;
    const envKey = `CRAFT_${toSnakeCase(key).toUpperCase()}`;
    env[envKey] = typeof value === 'string' ? sanitizeForShell(value) : String(value);
  }

  return env;
}

/**
 * 构建 webhook 动作用的环境变量。
 *
 * 与 buildEnvFromPayload（用于 prompt 动作）不同，这里：
 * - 不展开整个 process.env（防止密钥泄露）
 * - 不做 shell 转义（HTTP 场景不需要）
 * - 只注入 process.env 中以 CRAFT_WH_ 开头的用户定义变量（webhook 密钥）
 * - 包含从事件 payload 派生的 CRAFT_* 系统变量
 *
 * 用户在 shell profile 里设置 webhook 密钥：
 *   export CRAFT_WH_SLACK_URL="https://hooks.slack.com/services/T.../B.../xxx"
 *   export CRAFT_WH_DISCORD_TOKEN="abc123"
 *
 * 然后在 automations.json 中引用：
 *   "url": "${CRAFT_WH_SLACK_URL}"
 *   "headers": { "Authorization": "Bearer ${CRAFT_WH_DISCORD_TOKEN}" }
 */
export function buildWebhookEnv(event: AutomationEvent, payload: BaseEventPayload): Record<string, string> {
  const env = buildBaseEventEnv(event, payload);

  // 用户定义的 webhook 密钥：process.env 中仅 CRAFT_WH_* 开头
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('CRAFT_WH_') && value !== undefined) {
      env[key] = value;
    }
  }

  return env;
}
