/**
 * Info_GroupedList
 *
 * 带彩色分组标题的列表，常用于展示 MCP 工具分组。
 * 支持加载中、错误、空数据三种状态。
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { cva } from 'class-variance-authority'
import { Spinner } from '@craft-agent/ui'
import { cn } from '@/lib/utils'

const groupHeaderVariants = cva(
  'px-4 py-2 border-b border-border/30 text-xs font-semibold uppercase tracking-wide',
  {
    variants: {
      variant: {
        success: 'bg-success/5 text-success',
        info: 'bg-info/5 text-info',
        warning: 'bg-warning/5 text-warning',
        muted: 'bg-foreground/5 text-muted-foreground',
      },
    },
    defaultVariants: {
      variant: 'muted',
    },
  }
)

export interface Info_GroupedListProps {
  children: React.ReactNode
  /** 是否显示加载中 spinner */
  loading?: boolean
  /** 错误提示文本 */
  error?: string
  /** 所有分组都为空时显示的提示文本 */
  empty?: string
  className?: string
}

export interface Info_GroupedListGroupProps {
  children: React.ReactNode
  /** 分组标题文本 */
  label: string
  /** 标题颜色变体 */
  variant: 'success' | 'info' | 'warning' | 'muted'
  /** 可选的条目数量，会显示在标题右侧 */
  count?: number
  className?: string
}

export interface Info_GroupedListItemProps {
  children: React.ReactNode
  className?: string
}

function Info_GroupedListRoot({
  children,
  loading,
  error,
  empty,
  className,
}: Info_GroupedListProps) {
  const { t } = useTranslation()
  if (loading) {
    return (
      <div className={cn('flex items-center justify-center py-8', className)}>
        <Spinner className="text-muted-foreground" />
      </div>
    )
  }

  if (error) {
    return (
      <div className={cn('px-4 py-4 text-sm text-muted-foreground', className)}>
        {error === 'Source requires authentication' ? (
          <span>{t('sourceInfo.authenticateToViewTools')}</span>
        ) : (
          <span>{error}</span>
        )}
      </div>
    )
  }

  // 检查是否存在至少一个非空分组
  const hasItems = React.Children.toArray(children).some((child) => {
    if (React.isValidElement(child) && child.type === Info_GroupedListGroup) {
      return React.Children.count(child.props.children) > 0
    }
    return false
  })

  if (!hasItems && empty) {
    return (
      <div className={cn('px-4 py-4 text-sm text-muted-foreground', className)}>
        {empty}
      </div>
    )
  }

  return <div className={className}>{children}</div>
}

function Info_GroupedListGroup({
  children,
  label,
  variant,
  count,
  className,
}: Info_GroupedListGroupProps) {
  if (React.Children.count(children) === 0) {
    return null
  }

  return (
    <div className={cn('border-t border-border/30 first:border-t-0', className)}>
      <div className={groupHeaderVariants({ variant })}>
        {label}
        {count !== undefined && ` (${count})`}
      </div>
      <div className="divide-y divide-border/30">{children}</div>
    </div>
  )
}

function Info_GroupedListItem({ children, className }: Info_GroupedListItemProps) {
  return <div className={cn('px-4 py-2', className)}>{children}</div>
}

export const Info_GroupedList = Object.assign(Info_GroupedListRoot, {
  Group: Info_GroupedListGroup,
  Item: Info_GroupedListItem,
})
