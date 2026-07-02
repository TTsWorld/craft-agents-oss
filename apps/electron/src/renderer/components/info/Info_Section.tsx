/**
 * Info_Section
 *
 * 信息页中的「小节」容器：包含标题、可选描述，以及一个带卡片样式的内容区。
 * 与 SettingsSection 保持一致的视觉风格。
 */

import * as React from 'react'
import { cn } from '@/lib/utils'

export interface Info_SectionProps {
  /** 小节标题 */
  title: string
  /** 标题下方的可选描述 */
  description?: string
  /** 标题右侧的操作区（如按钮、链接） */
  actions?: React.ReactNode
  /** 小节内容 */
  children: React.ReactNode
  className?: string
}

export function Info_Section({
  title,
  description,
  actions,
  children,
  className,
}: Info_SectionProps) {
  return (
    <section className={cn('space-y-3 pt-2', className)}>
      <div className="flex items-start justify-between pl-1">
        <div className="space-y-0.5">
          <h3 className="text-base font-semibold">
            {title}
          </h3>
          {description && (
            <p className="text-sm text-muted-foreground">{description}</p>
          )}
        </div>
        {actions}
      </div>
      <div className="bg-background shadow-minimal rounded-[8px] overflow-hidden">
        {children}
      </div>
    </section>
  )
}
