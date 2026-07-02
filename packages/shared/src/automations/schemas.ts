/**
 * 自动化 Schema 定义
 *
 * 用 Zod 校验 automations.json 配置。
 * 从 index.ts 抽离出来，职责更清晰。
 */

import { z } from 'zod';
import type { ValidationIssue } from '../config/validators.ts';
import { APP_EVENTS, AGENT_EVENTS } from './types.ts';
import { THINKING_LEVEL_IDS, normalizeThinkingLevel } from '../agent/thinking-levels.ts';

// ============================================================================
// Zod Schema 定义
// ============================================================================

// 与 config/storage.ts 里的 workspace 默认模式保持一致：
// 旧的 'think' 值会被静默迁移为当前有效的思考级别。
const ThinkingLevelInputSchema = z
  .enum([...THINKING_LEVEL_IDS, 'think'])
  .transform((value) => normalizeThinkingLevel(value))
  .optional();

export const PromptActionSchema = z.object({
  type: z.literal('prompt'),
  prompt: z.string().min(1, 'Prompt cannot be empty'),
  llmConnection: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  thinkingLevel: ThinkingLevelInputSchema,
});

export const WebhookActionSchema = z.object({
  type: z.literal('webhook'),
  url: z.string().min(1, 'URL cannot be empty').refine(
    (url) => {
      // 允许环境变量模板 - 运行时展开后再校验
      if (url.includes('$')) return true;
      // 字面量 URL 必须是有效的 http/https
      try {
        const parsed = new URL(url);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
      } catch {
        return false;
      }
    },
    'URL must be a valid http/https URL or contain $VAR templates'
  ),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  bodyFormat: z.enum(['json', 'form', 'raw']).optional(),
  body: z.unknown().optional(),
  captureResponse: z.boolean().optional(),
  auth: z.union([
    z.object({
      type: z.literal('basic'),
      username: z.string().min(1),
      password: z.string(),
    }),
    z.object({
      type: z.literal('bearer'),
      token: z.string().min(1),
    }),
  ]).optional(),
});

/** 严格接受 prompt 和 webhook 动作；对遗留/未知动作类型透传而不报错 */
export const ActionDefinitionSchema = z.union([
  PromptActionSchema,
  WebhookActionSchema,
  z.object({ type: z.string() }).passthrough(),
]);

// ============================================================================
// 条件 Schemas
// ============================================================================

const VALID_WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

export const TimeConditionSchema = z.object({
  condition: z.literal('time'),
  after: z.string().regex(/^\d{2}:\d{2}$/, 'Must be HH:MM format').optional(),
  before: z.string().regex(/^\d{2}:\d{2}$/, 'Must be HH:MM format').optional(),
  weekday: z.array(z.enum(VALID_WEEKDAYS)).optional(),
  timezone: z.string().optional(),
});

export const StateConditionSchema = z.object({
  condition: z.literal('state'),
  field: z.string().min(1, 'Field name cannot be empty'),
  value: z.unknown().optional(),
  from: z.unknown().optional(),
  to: z.unknown().optional(),
  contains: z.string().optional(),
  not_value: z.unknown().optional(),
}).superRefine((data, ctx) => {
  const hasValue = data.value !== undefined;
  const hasFromOrTo = data.from !== undefined || data.to !== undefined;
  const hasContains = data.contains !== undefined;
  const hasNotValue = data.not_value !== undefined;

  const operatorCount =
    (hasValue ? 1 : 0) +
    (hasFromOrTo ? 1 : 0) +
    (hasContains ? 1 : 0) +
    (hasNotValue ? 1 : 0);

  if (operatorCount === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'State condition must have at least one operator (value, from/to, contains, or not_value)',
      path: ['field'],
    });
    return;
  }

  if (operatorCount > 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'State condition must use exactly one operator group (value, from/to, contains, or not_value)',
      path: ['field'],
    });
  }
});

export const AutomationConditionSchema: z.ZodType = z.lazy(() =>
  z.discriminatedUnion('condition', [
    TimeConditionSchema,
    StateConditionSchema,
    z.object({
      condition: z.enum(['and', 'or', 'not']),
      conditions: z.array(AutomationConditionSchema).min(1, 'Logical condition must have at least one sub-condition'),
    }),
  ])
);

// ============================================================================
// Matcher Schema 定义
// ============================================================================

export const AutomationMatcherSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  matcher: z.string().optional(),
  cron: z.string().optional(),
  timezone: z.string().optional(),
  permissionMode: z.enum(['safe', 'ask', 'allow-all']).optional(),
  labels: z.array(z.string()).optional(),
  enabled: z.boolean().optional(),
  conditions: z.array(AutomationConditionSchema).optional(),
  // Telegram 论坛主题名（1-128 字符）。运行时如果没有配对超级群或
  // Telegram 适配器未连接，会被静默忽略。
  telegramTopic: z.string().min(1).max(128).optional(),
  actions: z.array(ActionDefinitionSchema).min(1, 'At least one action required'),
});

/**
 * 已废弃的事件名别名。
 * 旧名在校验时被接受，并静默重写为规范名。
 * 运行时会输出 console.warn() 提醒用户更新配置。
 */
export const DEPRECATED_EVENT_ALIASES: Record<string, string> = {
  'TodoStateChange': 'SessionStatusChange',
};

/** 所有有效事件名：规范事件 + 废弃别名。由 types.ts 推导。 */
export const VALID_EVENTS: readonly string[] = [
  ...APP_EVENTS,
  ...AGENT_EVENTS,
  ...Object.keys(DEPRECATED_EVENT_ALIASES),
];

export const AutomationsConfigSchema = z.object({
  version: z.number().optional(),
  automations: z.record(z.string(), z.array(AutomationMatcherSchema)).optional(),
}).transform((data) => {
  const automations = data.automations ?? {};

  // 过滤无效事件名、重写废弃别名并警告
  const validAutomations: Record<string, z.infer<typeof AutomationMatcherSchema>[]> = {};
  const invalidEvents: string[] = [];

  for (const [event, matchers] of Object.entries(automations)) {
    if (VALID_EVENTS.includes(event)) {
      // 把废弃别名改写为规范名
      const canonical = DEPRECATED_EVENT_ALIASES[event];
      if (canonical) {
        console.warn(`[automations] Deprecated event name "${event}" — use "${canonical}" instead`);
        validAutomations[canonical] = [...(validAutomations[canonical] ?? []), ...matchers];
      } else {
        validAutomations[event] = [...(validAutomations[event] ?? []), ...matchers];
      }
    } else {
      invalidEvents.push(event);
    }
  }

  if (invalidEvents.length > 0) {
    console.warn(`[automations] Unknown event types ignored: ${invalidEvents.join(', ')}`);
  }

  return { version: data.version, automations: validAutomations };
});

// ============================================================================
// Schema 工具
// ============================================================================

/**
 * 把 Zod 错误转换为 ValidationIssue（与 validators.ts 的风格一致）。
 */
export function zodErrorToIssues(error: z.ZodError, file: string): ValidationIssue[] {
  return error.issues.map((issue) => ({
    file,
    path: issue.path.join('.') || 'root',
    message: issue.message,
    severity: 'error' as const,
  }));
}
