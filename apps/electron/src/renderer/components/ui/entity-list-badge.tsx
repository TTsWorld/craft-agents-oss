/**
 * EntityListBadge — 实体列表行内的通用胶囊徽标。
 *
 * 两种变体：
 * - "text"（默认）：固定高度 18px 的文本胶囊，带内边距。
 * - "icon"：18×18 的图标居中盒子，无文本内边距。
 *
 * 颜色由调用方通过 `colorClass` 或内联 `style` 控制。
 */

import * as React from 'react'
import { Tooltip, TooltipTrigger, TooltipContent } from '@craft-agent/ui'
import { cn } from '@/lib/utils'

/** EntityListBadge 的 props。 */
export interface EntityListBadgeProps {
  /** 徽标内容（文本或图标） */
  children: React.ReactNode
  /** "text"（默认）= 文本胶囊，"icon" = 18×18 图标盒子 */
  variant?: 'text' | 'icon'
  /** 颜色类名，例如 "bg-accent/10 text-accent" */
  colorClass?: string
  /** 内联样式，用于运行时计算颜色（如 label 的 color-mix） */
  style?: React.CSSProperties
  /** 可选的 tooltip 文本（hover 时显示） */
  tooltip?: string
  /** 额外 className */
  className?: string
}

/** 实体列表徽标 */
export function EntityListBadge({ children, variant = 'text', colorClass, style, tooltip, className }: EntityListBadgeProps) {
  const badge = (
    <span
      className={cn(
        "shrink-0 rounded",
        variant === 'icon'
          ? "h-[18px] w-[18px] flex items-center justify-center"
          : "h-[18px] px-1.5 text-[10px] font-medium flex items-center whitespace-nowrap",
        colorClass,
        className,
      )}
      style={style}
    >
      {children}
    </span>
  )

  if (tooltip) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{badge}</TooltipTrigger>
        <TooltipContent side="top" className="max-w-xs">
          <span className="text-xs">{tooltip}</span>
        </TooltipContent>
      </Tooltip>
    )
  }

  return badge
}
