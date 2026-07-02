/**
 * Info_Table
 *
 * 简洁的「键-值」定义列表，用于展示连接信息、元数据等。
 * 本身不带卡片外框，可无缝嵌入页面其他布局中。
 */

import * as React from 'react'
import { cn } from '@/lib/utils'

export interface Info_TableProps {
  children: React.ReactNode
  /** 底部可选内容，例如错误提示 */
  footer?: React.ReactNode
  /** 左侧标签列宽度，单位像素（默认 120） */
  labelWidth?: number
  className?: string
}

export interface Info_TableRowProps {
  /** 左侧标签文本 */
  label: string
  /** 右侧值（简单内容可直接用） */
  value?: React.ReactNode
  /** 右侧复杂内容，优先级高于 value */
  children?: React.ReactNode
  className?: string
}

function Info_TableRoot({
  children,
  footer,
  labelWidth = 120,
  className,
}: Info_TableProps) {
  return (
    <div className={cn('py-2', className)}>
      <dl
        className="divide-y divide-border/30"
        style={{ '--label-width': `${labelWidth}px` } as React.CSSProperties}
      >
        {children}
      </dl>
      {footer}
    </div>
  )
}

function Info_TableRow({ label, value, children, className }: Info_TableRowProps) {
  const content = children ?? value

  return (
    <div className={cn('flex py-2.5 px-4 text-sm', className)}>
      <dt
        className="text-muted-foreground shrink-0"
        style={{ width: 'var(--label-width)' }}
      >
        {label}
      </dt>
      <dd className="flex-1 min-w-0">{content}</dd>
    </div>
  )
}

export const Info_Table = Object.assign(Info_TableRoot, {
  Row: Info_TableRow,
})
