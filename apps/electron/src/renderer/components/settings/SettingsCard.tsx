/**
 * SettingsCard
 *
 * 设置页的卡片容器，用于把相关设置项归为一组。
 * 子元素之间会自动插入分隔线。
 */

import * as React from 'react'
import { cn } from '@/lib/utils'

export interface SettingsCardProps {
  /** 卡片内容 */
  children: React.ReactNode
  /** 额外 className */
  className?: string
  /** 是否在子元素之间添加分隔线 */
  divided?: boolean
}

/**
 * SettingsCard - 用于分组相关设置的卡片容器
 *
 * @example
 * <SettingsCard>
 *   <SettingsToggle label="Option 1" ... />
 *   <SettingsToggle label="Option 2" ... />
 * </SettingsCard>
 */
export function SettingsCard({ children, className, divided = true }: SettingsCardProps) {
  // 把 children 转成数组并过滤掉 falsy 值，方便后续加分隔线
  const childArray = React.Children.toArray(children).filter(Boolean)

  return (
    <div
      className={cn(
        'rounded-xl bg-background shadow-minimal overflow-hidden',
        className
      )}
    >
      {divided && childArray.length > 1
        ? childArray.map((child, index) => (
            <React.Fragment key={index}>
              {index > 0 && <div className="h-px bg-border/50 mx-4" />}
              {child}
            </React.Fragment>
          ))
        : children}
    </div>
  )
}

/**
 * SettingsCardContent - 卡片内容的内边距包装器
 *
 * 当需要在 SettingsCard 里放自定义内容时使用。
 */
export function SettingsCardContent({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return <div className={cn('px-4 py-3.5', className)}>{children}</div>
}

/**
 * SettingsCardFooter - 卡片底部操作栏
 */
export function SettingsCardFooter({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'px-4 py-3 border-t border-border/50 bg-muted/30 flex items-center justify-end gap-2',
        className
      )}
    >
      {children}
    </div>
  )
}
