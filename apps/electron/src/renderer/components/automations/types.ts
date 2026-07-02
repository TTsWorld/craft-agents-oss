/**
 * Automation UI Types
 *
 * 自动化组件专用的 UI 类型。
 *
 * 架构说明：这些类型是从 packages/shared/src/automations/types.ts 镜像过来的。
 * renderer 运行在浏览器上下文，无法导入 @craft-agent/shared（它使用了 Node.js API，
 * 如 crypto、fs 等）。另外 automations 包也没有作为包入口导出。因此这些类型必须
 * 手动保持同步。
 * 详见 apps/electron/CLAUDE.md 中的“Common Mistake: Node.js APIs in Renderer”。
 */

import { computeNextRuns } from './utils'
import type { PermissionMode } from '../../../shared/types'
import type { ThinkingLevel } from '@craft-agent/shared/agent/thinking-levels'
import { DEFAULT_WEBHOOK_METHOD } from './constants'

// ============================================================================
// 自动化系统类型（从 packages/shared/src/automations/types.ts 镜像）
// ============================================================================

// App 事件：应用层生命周期或状态变化事件
export type AppEvent =
  | 'LabelAdd'
  | 'LabelRemove'
  | 'LabelConfigChange'
  | 'PermissionModeChange'
  | 'FlagChange'
  | 'TodoStateChange'
  | 'SessionStatusChange'
  | 'SchedulerTick'

// Agent 事件：Agent 运行过程中的各类钩子事件
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
  | 'Setup'

export type AutomationTrigger = AppEvent | AgentEvent

export const APP_EVENTS: AppEvent[] = [
  'LabelAdd', 'LabelRemove', 'LabelConfigChange',
  'PermissionModeChange', 'FlagChange', 'TodoStateChange', 'SessionStatusChange', 'SchedulerTick'
]

export const AGENT_EVENTS: AgentEvent[] = [
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Notification',
  'UserPromptSubmit', 'SessionStart', 'SessionEnd', 'Stop',
  'SubagentStart', 'SubagentStop', 'PreCompact', 'PermissionRequest', 'Setup'
]

// Prompt 动作：触发后会新建一个 session 并向其发送 prompt
export interface PromptAction {
  type: 'prompt'
  prompt: string
  /** 覆盖本次触发所创建 session 的 LLM 连接 slug */
  llmConnection?: string
  /** 覆盖本次触发所创建 session 的模型 ID */
  model?: string
  /** 覆盖本次触发所创建 session 的思考级别 */
  thinkingLevel?: ThinkingLevel
}

// Webhook 动作：触发后向指定 URL 发起 HTTP 请求
export interface WebhookAction {
  type: 'webhook'
  url: string
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  headers?: Record<string, string>
  bodyFormat?: 'json' | 'form' | 'raw'
  body?: unknown
  captureResponse?: boolean
  auth?: { type: 'basic'; username: string; password: string } | { type: 'bearer'; token: string }
}

export type AutomationAction = PromptAction | WebhookAction

// ============================================================================
// 条件类型（从 packages/shared/src/automations/types.ts 镜像）
// ============================================================================

export interface TimeConditionUI {
  condition: 'time'
  after?: string
  before?: string
  weekday?: string[]
  timezone?: string
}

export interface StateConditionUI {
  condition: 'state'
  field: string
  value?: unknown
  from?: unknown
  to?: unknown
  contains?: string
  not_value?: unknown
}

export interface LogicalConditionUI {
  condition: 'and' | 'or' | 'not'
  conditions: AutomationConditionUI[]
}

export type AutomationConditionUI = TimeConditionUI | StateConditionUI | LogicalConditionUI

/** 状态条件字段的人类可读名称 */
const FIELD_LABELS: Record<string, string> = {
  permissionMode: 'permission mode',
  sessionStatus: 'session status',
  isFlagged: 'flagged',
  labels: 'label',
  sessionName: 'session name',
}

/** 获取可读字段名，找不到时返回原始字段 */
function fieldLabel(field: string): string {
  return FIELD_LABELS[field] ?? field
}

/** 为单个叶子条件生成简短的人类可读说明 */
function describeLeaf(c: AutomationConditionUI): string {
  switch (c.condition) {
    case 'time': {
      const parts: string[] = []
      if (c.weekday?.length) parts.push(c.weekday.join(', '))
      if (c.after) parts.push(`after ${c.after}`)
      if (c.before) parts.push(`before ${c.before}`)
      if (c.timezone) parts.push(`(${c.timezone})`)
      return parts.length ? parts.join(' ') : 'any time'
    }
    case 'state': {
      const label = fieldLabel(c.field)
      if (c.from !== undefined || c.to !== undefined) {
        const from = c.from !== undefined ? String(c.from) : 'any'
        const to = c.to !== undefined ? String(c.to) : 'any'
        return `${label} changed from ${from} to ${to}`
      }
      if (c.contains) return `has ${label} "${c.contains}"`
      if (c.not_value !== undefined) {
        if (c.field === 'isFlagged') return c.not_value ? 'not flagged' : 'is flagged'
        return `${label} is not ${String(c.not_value)}`
      }
      if (c.value !== undefined) {
        if (c.field === 'isFlagged') return c.value ? 'is flagged' : 'not flagged'
        return `${label} is ${String(c.value)}`
      }
      return label
    }
    case 'and':
    case 'or':
    case 'not': {
      const sep = c.condition === 'not' ? ' and not ' : ` ${c.condition} `
      return c.conditions.map(describeLeaf).join(sep)
    }
    default:
      return 'unknown condition'
  }
}

/**
 * 把条件树扁平化为适合表格展示的行。
 * 逻辑条件会被展开，子条件以文本形式连接。
 * 返回 { label, description } 数组，供 Info_Table 渲染。
 */
export function flattenConditions(conditions: AutomationConditionUI[]): { label: string; description: string }[] {
  const rows: { label: string; description: string }[] = []
  for (const c of conditions) {
    if (c.condition === 'and' || c.condition === 'or' || c.condition === 'not') {
      // 扁平化：用逻辑运算符连接内部描述
      const sep = c.condition === 'not' ? ' and not ' : ` ${c.condition} `
      const inner = c.conditions.map(describeLeaf).join(sep)
      // 取第一个子条件的类型作为 label，没有则回退为 'Condition'
      const firstChild = c.conditions[0]
      const label = firstChild
        ? firstChild.condition === 'time' ? 'Time'
          : firstChild.condition === 'state' ? 'State'
          : 'Condition'
        : 'Condition'
      rows.push({ label, description: inner })
    } else {
      const label = c.condition === 'time' ? 'Time' : c.condition === 'state' ? 'State' : 'Condition'
      rows.push({ label, description: describeLeaf(c) })
    }
  }
  return rows
}

// ============================================================================
// 列表项（由 automations.json 展平而来，用于展示）
// ============================================================================

export interface AutomationListItem {
  /** 稳定的 6 位十六进制 ID，来自 automations.json；老配置回退为 event+index */
  id: string
  /** 该自动化监听的事件 */
  event: AutomationTrigger
  /** 该 matcher 在 automations.json 对应事件数组中的索引，用于写回 */
  matcherIndex: number
  /** 显示名称（用户设置或自动生成） */
  name: string
  /** 人类可读的摘要 */
  summary: string
  /** 是否启用 */
  enabled: boolean
  /** 正则匹配器（如果有） */
  matcher?: string
  /** Cron 表达式（仅 SchedulerTick） */
  cron?: string
  /** Cron 的 IANA 时区 */
  timezone?: string
  /** 权限模式 */
  permissionMode?: PermissionMode
  /** Prompt session 的标签 */
  labels?: string[]
  /** 动作执行前必须满足的条件 */
  conditions?: AutomationConditionUI[]
  /** 该自动化执行的动作列表 */
  actions: AutomationAction[]
  /**
   * 可选的 Telegram 论坛主题名。设置后，该 matcher 创建的 session
   * 会绑定到工作区配对超级群中的同名主题（首次使用时创建）。
   */
  telegramTopic?: string
  /** 上次执行时间戳（毫秒，自 epoch） */
  lastExecutedAt?: number
}

// ============================================================================
// 筛选
// ============================================================================

export type AutomationFilterKind = 'all' | 'app' | 'agent' | 'scheduled'

export interface AutomationListFilter {
  kind: AutomationFilterKind
}

/** 把路由中的任务类型映射为列表面板使用的 AutomationFilterKind */
export const AUTOMATION_TYPE_TO_FILTER_KIND: Record<string, AutomationFilterKind> = {
  scheduled: 'scheduled',
  event: 'app',
  agentic: 'agent',
}

// ============================================================================
// 执行历史
// ============================================================================

export type ExecutionStatus = 'success' | 'error' | 'blocked'

export interface WebhookDetails {
  method: string
  url: string
  statusCode: number
  durationMs: number
  attempts?: number
  error?: string
  responseBody?: string
}

export interface ExecutionEntry {
  id: string
  automationId: string
  event: AutomationTrigger
  status: ExecutionStatus
  /** 执行耗时，单位毫秒 */
  duration: number
  /** 时间戳，单位毫秒，自 epoch */
  timestamp: number
  /** 错误信息（当 status === 'error' 时） */
  error?: string
  /** 截断后的动作摘要 */
  actionSummary?: string
  /** 本次执行创建的 session ID，用于深链跳转 */
  sessionId?: string
  /** 结构化的 webhook 执行详情（在时间线中可展开） */
  webhookDetails?: WebhookDetails
}

// ============================================================================
// 测试面板
// ============================================================================

export type TestState = 'idle' | 'running' | 'success' | 'error'

export interface TestResult {
  state: TestState
  stderr?: string
  duration?: number
}

// ============================================================================
// 人类友好的显示名称
// ============================================================================

/** 内部事件名到用户可读标签的映射 */
export const EVENT_DISPLAY_NAMES: Record<AutomationTrigger, string> = {
  // App 事件
  LabelAdd:             'Label Added',
  LabelRemove:          'Label Removed',
  LabelConfigChange:    'Label Settings Changed',
  PermissionModeChange: 'Permission Changed',
  FlagChange:           'Flag Changed',
  TodoStateChange:      'Task Updated',
  SessionStatusChange:  'Status Changed',
  SchedulerTick:        'Scheduled',

  // Agent 事件
  PreToolUse:           'Before Tool Runs',
  PostToolUse:          'After Tool Runs',
  PostToolUseFailure:   'When Tool Fails',
  Notification:         'Notification',
  UserPromptSubmit:     'Message Sent',
  SessionStart:         'Session Started',
  SessionEnd:           'Session Ended',
  Stop:                 'Agent Stopped',
  SubagentStart:        'Sub-agent Started',
  SubagentStop:         'Sub-agent Stopped',
  PreCompact:           'Before Memory Cleanup',
  PermissionRequest:    'Permission Requested',
  Setup:                'Initial Setup',
}

export function getEventDisplayName(event: AutomationTrigger): string {
  return EVENT_DISPLAY_NAMES[event] ?? event
}

/** 权限模式值到用户可读标签的映射 */
export const PERMISSION_DISPLAY_NAMES: Record<PermissionMode, string> = {
  'safe':      'Explore',
  'ask':       'Ask',
  'allow-all': 'Execute',
}

export function getPermissionDisplayName(mode?: PermissionMode): string {
  if (!mode) return 'Explore'
  return PERMISSION_DISPLAY_NAMES[mode] ?? mode
}

// ============================================================================
// 事件分类（用于 AutomationAvatar 着色）
// ============================================================================

export type EventCategory =
  | 'scheduled'
  | 'label'
  | 'permission'
  | 'flag'
  | 'todo'
  | 'agent-pre'
  | 'agent-post'
  | 'agent-error'
  | 'session'
  | 'other'

// ============================================================================
// automations.json 解析器
// ============================================================================

/** automations.json 文件的原始结构 */
interface AutomationsConfigFile {
  version: number
  automations?: Record<string, AutomationsConfigMatcher[]>
}

type RawAction =
  | { type: 'prompt'; prompt: string; llmConnection?: string; model?: string; thinkingLevel?: ThinkingLevel }
  | { type: 'webhook'; url: string; method?: string; headers?: Record<string, string>; bodyFormat?: 'json' | 'form' | 'raw'; body?: unknown; captureResponse?: boolean; auth?: WebhookAction['auth'] }

interface AutomationsConfigMatcher {
  id?: string
  name?: string
  matcher?: string
  cron?: string
  timezone?: string
  permissionMode?: PermissionMode
  labels?: string[]
  conditions?: AutomationConditionUI[]
  enabled?: boolean
  actions?: RawAction[]
}

/** 根据动作和事件生成人类可读的名称 */
function deriveAutomationName(event: string, matcher: AutomationsConfigMatcher): string {
  if (matcher.name) return matcher.name
  const allActions = matcher.actions ?? []
  const firstAction = allActions[0]
  if (!firstAction) return getEventDisplayName(event as AutomationTrigger)

  if (firstAction.type === 'webhook') {
    const label = `Webhook ${firstAction.method ?? DEFAULT_WEBHOOK_METHOD} ${firstAction.url}`
    return label.length > 40 ? label.slice(0, 40) + '...' : label
  }

  // 提取 @skill 引用，或取前约 40 个字符
  const mentionMatch = firstAction.prompt.match(/@(\S+)/)
  if (mentionMatch) return `${mentionMatch[1]} prompt`
  return firstAction.prompt.length > 40
    ? firstAction.prompt.slice(0, 40) + '...'
    : firstAction.prompt
}

/** 根据 matcher/cron/event 生成摘要行 */
function deriveAutomationSummary(event: string, matcher: AutomationsConfigMatcher): string {
  if (matcher.cron) {
    const runs = computeNextRuns(matcher.cron, 1)
    if (runs.length > 0) {
      const next = runs[0]!
      const tz = matcher.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
      const tzCity = tz.split('/').pop()?.replace(/_/g, ' ') ?? tz
      const formatted = next.toLocaleString('en-US', {
        weekday: 'short',
        hour: 'numeric',
        minute: '2-digit',
        timeZone: tz,
      })
      return `Next run: ${formatted} (${tzCity})`
    }
    const tz = matcher.timezone ? ` (${matcher.timezone})` : ''
    return `Cron: ${matcher.cron}${tz}`
  }
  if (matcher.matcher) {
    return `Matches: ${matcher.matcher}`
  }
  return `On ${getEventDisplayName(event as AutomationTrigger)}`
}

/**
 * 把 automations.json 解析为扁平的 AutomationListItem[]。
 * 每个事件下的每个 matcher 条目都会变成列表中的一项。
 */
export function parseAutomationsConfig(json: unknown): AutomationListItem[] {
  if (!json || typeof json !== 'object') return []
  const config = json as AutomationsConfigFile
  const eventMap = config.automations
  if (!eventMap || typeof eventMap !== 'object') return []

  const allEvents = [...APP_EVENTS, ...AGENT_EVENTS] as string[]
  const items: AutomationListItem[] = []
  let index = 0

  for (const [eventName, matchers] of Object.entries(eventMap)) {
    if (!Array.isArray(matchers)) continue
    const event = (allEvents.includes(eventName) ? eventName : eventName) as AutomationTrigger

    for (let matcherIdx = 0; matcherIdx < matchers.length; matcherIdx++) {
      const matcher = matchers[matcherIdx]
      const rawActions = matcher.actions
      if (!rawActions || !Array.isArray(rawActions) || rawActions.length === 0) continue

      const actions: AutomationAction[] = rawActions
        .filter((a): a is AutomationAction => a.type === 'prompt' || a.type === 'webhook')
      if (actions.length === 0) continue

      const rawTopic = (matcher as { telegramTopic?: unknown }).telegramTopic
      const telegramTopic =
        typeof rawTopic === 'string' && rawTopic.trim().length > 0 ? rawTopic.trim() : undefined

      items.push({
        id: matcher.id ?? `${eventName}-${index}`,
        event,
        matcherIndex: matcherIdx,
        name: deriveAutomationName(eventName, matcher),
        summary: deriveAutomationSummary(eventName, matcher),
        enabled: matcher.enabled !== false,
        matcher: matcher.matcher,
        cron: matcher.cron,
        timezone: matcher.timezone,
        permissionMode: matcher.permissionMode,
        labels: matcher.labels,
        conditions: matcher.conditions,
        actions,
        telegramTopic,
      })
      index++
    }
  }

  return items
}

export function getEventCategory(event: AutomationTrigger): EventCategory {
  switch (event) {
    case 'SchedulerTick':
      return 'scheduled'
    case 'LabelAdd':
    case 'LabelRemove':
    case 'LabelConfigChange':
      return 'label'
    case 'PermissionModeChange':
    case 'PermissionRequest':
      return 'permission'
    case 'FlagChange':
      return 'flag'
    case 'TodoStateChange':
    case 'SessionStatusChange':
      return 'todo'
    case 'PreToolUse':
    case 'UserPromptSubmit':
    case 'Setup':
    case 'PreCompact':
    case 'SubagentStart':
      return 'agent-pre'
    case 'PostToolUse':
    case 'SessionEnd':
    case 'SubagentStop':
    case 'Stop':
      return 'agent-post'
    case 'PostToolUseFailure':
      return 'agent-error'
    case 'SessionStart':
    case 'Notification':
      return 'session'
    default:
      return 'other'
  }
}
