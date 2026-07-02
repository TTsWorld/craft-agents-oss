/**
 * SettingsRow
 *
 * 通用设置行：左侧是标签和描述，右侧放任意内容。
 * 当 Toggle / Select 等模式不满足布局需求时使用。
 */

import * as React from 'react'
import { cn } from '@/lib/utils'
import { settingsUI } from './SettingsUIConstants'

export interface SettingsRowProps {
  /** 行标签（支持字符串或 JSX） */
  label: React.ReactNode
  /** 标签下方的描述说明 */
  description?: string
  /** 右侧内容 */
  children?: React.ReactNode
  /** 整行点击事件（如果有，会用 button 渲染） */
  onClick?: () => void
  /** 右侧操作按钮（例如 "Change" 按钮） */
  action?: React.ReactNode
  /** 额外 className */
  className?: string
  /** 是否在卡片内部 */
  inCard?: boolean
}

/**
 * SettingsRow - 自定义布局的通用设置行
 *
 * @example
 * <SettingsRow
 *   label="Working Directory"
 *   description="~/Documents"
 *   action={<Button variant="ghost" size="sm">Change</Button>}
 * />
 */
export function SettingsRow({
  label,
  description,
  children,
  onClick,
  action,
  className,
  inCard = true,
}: SettingsRowProps) {
  // 如果传了 onClick，就用 button 标签以支持键盘和可访问性
  const Component = onClick ? 'button' : 'div'

  return (
    <Component
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      data-layout="settings-row"
      className={cn(
        'w-full flex items-center justify-between text-left',
        inCard ? 'px-4 py-3.5' : 'py-3',
        onClick && 'hover:bg-muted/70 transition-colors cursor-pointer',
        className
      )}
    >
      <div className="flex-1 min-w-0">
        <div className={settingsUI.label}>{label}</div>
        {description && (
          <div className={cn(settingsUI.description, settingsUI.labelDescriptionGap, 'truncate')}>
            {description}
          </div>
        )}
      </div>
      {(children || action) && (
        <div data-layout="settings-control" className="flex items-center gap-3 ml-4 shrink-0">
          {children}
          {action}
        </div>
      )}
    </Component>
  )
}

/**
 * SettingsRowLabel - 独立标签组件
 *
 * 当不需要 SettingsRow 的左右布局，只展示标签和描述时使用。
 *
 * @example
 * <SettingsRowLabel label="Theme" />
 * <SettingsSegmentedControl ... />
 */
export function SettingsRowLabel({
  label,
  description,
  className,
}: {
  label: string
  description?: string
  className?: string
}) {
  return (
    <div className={cn(settingsUI.labelGroup, className)}>
      <div className={settingsUI.label}>{label}</div>
      {description && (
        <div className={cn(settingsUI.description, settingsUI.labelDescriptionGap)}>{description}</div>
      )}
    </div>
  )
}
