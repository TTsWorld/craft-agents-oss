/**
 * AutomationActionRow
 *
 * 单个自动化动作（prompt 或 webhook）的行内展示组件。
 * 用在 AutomationInfoPage 的“Then”区域。
 *
 * Prompt 动作会在文案下方显示可选的逐动作覆盖参数（llmConnection、
 * model、thinkingLevel），以低强调度的徽章形式呈现。
 */

import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { THINKING_LEVELS } from '@craft-agent/shared/agent/thinking-levels'
import type { AutomationAction, PromptAction } from './types'
import { ActionTypeIcon } from './ActionTypeIcon'
import { DEFAULT_WEBHOOK_METHOD } from './constants'

// 组件 Props：接收一个动作、序号和可选的样式类名
export interface AutomationActionRowProps {
  action: AutomationAction
  index: number
  className?: string
}

/**
 * 高亮 prompt 字符串中的 @mention。
 * 例如 @skill-name 会以强调色显示，方便识别调用的 skill。
 */
function PromptText({ text, t }: { text: string; t: (key: string) => string }) {
  if (!text) return <span className="text-sm text-muted-foreground italic">{t('automations.emptyPrompt')}</span>
  const parts = text.split(/(@\w[\w-]*)/g)
  return (
    <span className="text-sm break-words">
      {parts.map((part, i) =>
        part.startsWith('@') ? (
          <span key={i} className="text-accent font-medium">{part}</span>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </span>
  )
}

// Webhook 动作的文案：显示 HTTP 方法、URL 和可选的 body 格式
function WebhookText({ action }: { action: Extract<AutomationAction, { type: 'webhook' }> }) {
  const method = action.method ?? DEFAULT_WEBHOOK_METHOD
  return (
    <span className="text-sm break-words">
      <span className="font-mono font-medium text-accent">{method}</span>{' '}
      <span className="text-foreground/70">{action.url}</span>
      {action.bodyFormat && (
        <span className="text-foreground/40 ml-1">({action.bodyFormat})</span>
      )}
    </span>
  )
}

/**
 * 渲染 prompt 动作的逐动作覆盖小徽章（连接 / 模型 / 思考级别）。
 * 每个徽章只在对应字段被设置时才会出现。
 *
 * 连接名直接显示 slug（不做显示名解析）—— info 页是只读的，
 * 不值得为了徽章去拉取工作区的 LlmConnection 列表。如果 slug 失效，
 * executePromptAutomation 在运行时会打印警告。
 */
function PromptActionBadges({ action, t }: { action: PromptAction; t: (key: string) => string }) {
  const { llmConnection, model, thinkingLevel } = action
  if (!llmConnection && !model && !thinkingLevel) return null

  const thinkingDef = thinkingLevel ? THINKING_LEVELS.find((l) => l.id === thinkingLevel) : undefined
  const thinkingLabel = thinkingDef ? t(thinkingDef.nameKey) : thinkingLevel

  return (
    <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
      {llmConnection && (
        <Badge
          variant="secondary"
          className="font-mono text-[10px] px-1.5 py-0 font-normal"
          title={`${t('automations.labelConnection')}: ${llmConnection}`}
        >
          {llmConnection}
        </Badge>
      )}
      {model && (
        <Badge
          variant="secondary"
          className="font-mono text-[10px] px-1.5 py-0 font-normal max-w-[14rem] truncate"
          title={`${t('automations.labelModel')}: ${model}`}
        >
          {model}
        </Badge>
      )}
      {thinkingLevel && (
        <Badge
          variant="secondary"
          className="text-[10px] px-1.5 py-0 font-normal"
          title={`${t('automations.labelThinking')}: ${thinkingLabel}`}
        >
          {thinkingLabel}
        </Badge>
      )}
    </div>
  )
}

// 主组件：渲染一行动作，左侧是序号和图标，右侧是具体内容
export function AutomationActionRow({ action, index, className }: AutomationActionRowProps) {
  const { t } = useTranslation()
  const isWebhook = action.type === 'webhook'

  return (
    <div className={cn('flex items-start gap-3 px-4 py-3', className)}>
      {/* 左侧：序号 + 图标；h-5 与 text-sm 内容的首行高度对齐 */}
      <div className="flex items-center gap-2 shrink-0 h-5 mt-[3px]">
        <span className="text-xs text-muted-foreground tabular-nums w-4 text-right">
          {index + 1}.
        </span>
        <ActionTypeIcon type={action.type} className="h-3.5 w-3.5" />
      </div>

      {/* 右侧：内容区 */}
      <div className="flex-1 min-w-0">
        {isWebhook ? (
          <WebhookText action={action} />
        ) : (
          <>
            <PromptText text={action.prompt} t={t} />
            <PromptActionBadges action={action} t={t} />
          </>
        )}
      </div>
    </div>
  )
}
