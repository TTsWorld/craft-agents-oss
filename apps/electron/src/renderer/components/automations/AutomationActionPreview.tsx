/**
 * AutomationActionPreview
 *
 * 用于 AutomationCard 和 AutomationsListPanel 展开行的紧凑动作列表。
 * 显示 MessageSquare/Webhook 图标 + 截断后的文案。
 *
 * 如果需要带序号、@mention 高亮的完整展示，请改用 AutomationActionRow。
 */

import { cn } from '@/lib/utils'
import type { AutomationAction } from './types'
import { ActionTypeIcon } from './ActionTypeIcon'
import { DEFAULT_WEBHOOK_METHOD } from './constants'

export interface AutomationActionPreviewProps {
  actions: AutomationAction[]
  className?: string
}

export function AutomationActionPreview({ actions, className }: AutomationActionPreviewProps) {
  return (
    <div className={cn('space-y-1', className)}>
      {actions.map((action, i) => (
        <div key={i} className="flex items-start gap-2 text-xs">
          <ActionTypeIcon type={action.type} className="h-3 w-3 mt-0.5 shrink-0" />
          <span className="text-foreground/70 break-words line-clamp-2">
            {action.type === 'webhook'
              ? `${action.method ?? DEFAULT_WEBHOOK_METHOD} ${action.url}`
              : action.prompt}
          </span>
        </div>
      ))}
    </div>
  )
}
