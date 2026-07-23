/**
 * InlineExecution - EditPopover 的紧凑执行视图
 *
 * 在 popover 内以内联方式展示 mini agent 的执行进度，
 * 状态流转：executing → success | error。
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { CheckCircle2, XCircle, X } from 'lucide-react'
import { cn } from '@craft-agent/ui'
import { ActivityStatusIcon, SIZE_CONFIG, type ActivityItem, type ActivityStatus } from './TurnCard'
import { LoadingIndicator } from '../ui/LoadingIndicator'
import { Markdown } from '../markdown'

// ============================================================================
// 类型
// ============================================================================

export type InlineExecutionStatus = 'executing' | 'success' | 'error'

export interface InlineActivityItem {
  id: string
  name: string
  status: ActivityStatus
  description?: string
}

export interface InlineExecutionProps {
  /** 当前执行状态 */
  status: InlineExecutionStatus
  /** 待展示的活动（由完整 ActivityItem 简化而来） */
  activities: InlineActivityItem[]
  /** 成功时的结果消息 */
  result?: string
  /** 失败时的错误消息 */
  error?: string
  /** 取消执行的回调 */
  onCancel?: () => void
  /** 关闭的回调（成功/失败时） */
  onDismiss?: () => void
  /** 重试的回调（失败时） */
  onRetry?: () => void
  /** 可选的 className */
  className?: string
}

// ============================================================================
// 内联视图用的简单活动行
// ============================================================================

function InlineActivityRow({ activity }: { activity: InlineActivityItem }) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 py-0.5 text-muted-foreground",
        SIZE_CONFIG.fontSize
      )}
    >
      <ActivityStatusIcon status={activity.status} toolName={activity.name} />
      <span className="shrink-0">{activity.name}</span>
      {activity.description && (
        <>
          <span className="opacity-60 shrink-0">·</span>
          <span className="truncate min-w-0 flex-1">{activity.description}</span>
        </>
      )}
    </div>
  )
}

// ============================================================================
// 主组件
// ============================================================================

export function InlineExecution({
  status,
  activities,
  result,
  error,
  onCancel,
  onDismiss,
  onRetry,
  className,
}: InlineExecutionProps) {
  const { t } = useTranslation()
  // 执行中状态
  if (status === 'executing') {
    return (
      <div className={cn("space-y-3", className)}>
        {/* 带 spinner 的头部 */}
        <div className="flex items-center gap-2">
          <LoadingIndicator animated showElapsed />
          <span className={cn("text-foreground/80", SIZE_CONFIG.fontSize)}>
            {t('common.editing')}
          </span>
        </div>

        {/* 活动列表 - 仅展示最后 3 条 */}
        {activities.length > 0 && (
          <div className="space-y-0.5 pl-1">
            {activities.slice(-3).map((activity) => (
              <InlineActivityRow key={activity.id} activity={activity} />
            ))}
          </div>
        )}

        {/* 操作区 */}
        <div className="flex items-center justify-start pt-1 border-t border-border/30">
          <button
            type="button"
            onClick={onCancel}
            className={cn(
              "text-muted-foreground hover:text-foreground transition-colors",
              SIZE_CONFIG.fontSize
            )}
          >
            {t('common.cancel')}
          </button>
        </div>
      </div>
    )
  }

  // 成功状态
  if (status === 'success') {
    return (
      <div className={cn("space-y-3", className)}>
        {/* 带勾选图标的头部 */}
        <div className="flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 text-success" />
          <span className={cn("text-foreground font-medium", SIZE_CONFIG.fontSize)}>
            {t('common.done')}
          </span>
        </div>

        {/* 结果消息 - 以 markdown 渲染 */}
        {result && (
          <div className={cn("text-muted-foreground leading-relaxed prose-compact", SIZE_CONFIG.fontSize)}>
            <Markdown>{result}</Markdown>
          </div>
        )}

        {/* 操作区 */}
        <div className="flex items-center justify-end pt-1 border-t border-border/30">
          <button
            type="button"
            onClick={onDismiss}
            className={cn(
              "flex items-center gap-1 px-2 py-1 rounded-md bg-success/10 text-success hover:bg-success/20 transition-colors",
              SIZE_CONFIG.fontSize
            )}
          >
            <CheckCircle2 className="w-3 h-3" />
            {t('common.done')}
          </button>
        </div>
      </div>
    )
  }

  // 错误状态
  return (
    <div className={cn("space-y-3", className)}>
      {/* 带错误图标的头部 */}
      <div className="flex items-center gap-2">
        <XCircle className="w-4 h-4 text-destructive" />
        <span className={cn("text-foreground font-medium", SIZE_CONFIG.fontSize)}>
          {t('common.failed')}
        </span>
      </div>

      {/* 错误消息 - 以 markdown 渲染 */}
      {error && (
        <div className={cn("text-destructive/80 leading-relaxed prose-compact", SIZE_CONFIG.fontSize)}>
          <Markdown>{error}</Markdown>
        </div>
      )}

      {/* 操作区 */}
      <div className="flex items-center justify-end gap-2 pt-1 border-t border-border/30">
        <button
          type="button"
          onClick={onDismiss}
          className={cn(
            "flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors",
            SIZE_CONFIG.fontSize
          )}
        >
          <X className="w-3 h-3" />
          {t('common.dismiss')}
        </button>
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className={cn(
              "px-2 py-1 rounded-md bg-accent/10 text-accent hover:bg-accent/20 transition-colors",
              SIZE_CONFIG.fontSize
            )}
          >
            {t('common.retry')}
          </button>
        )}
      </div>
    </div>
  )
}

// ============================================================================
// 工具函数：将 SessionEvent 映射为 InlineActivityItem
// ============================================================================

/**
 * 将工具事件映射为 InlineActivityItem。
 * 在 EditPopover 中处理会话事件时使用。
 */
export function mapToolEventToActivity(
  toolName: string,
  toolUseId: string,
  status: ActivityStatus,
  description?: string
): InlineActivityItem {
  // 清理工具名（去掉 MCP 前缀以便展示）
  const displayName = toolName
    .replace(/^mcp__[^_]+__/, '')  // 去掉 mcp__server__ 前缀
    .replace(/_/g, ' ')            // 将下划线替换为空格
    .replace(/\b\w/g, c => c.toUpperCase())  // 转为标题大小写

  return {
    id: toolUseId,
    name: displayName,
    status,
    description,
  }
}
