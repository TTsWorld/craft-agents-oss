/**
 * Info_Badge
 *
 * 带可选图标的状态徽章组件，用于展示「成功 / 警告 / 危险 / 默认 / 静音」等状态。
 * 使用 rounded-[5px] 圆角，并根据颜色自动应用对应的背景色与阴影。
 */

import * as React from 'react'
import { cn } from '@/lib/utils'

export type BadgeColor = 'success' | 'warning' | 'destructive' | 'default' | 'muted'

export interface Info_BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** 徽章颜色变体 */
  color?: BadgeColor
  /** 可选图标，渲染在文本左侧 */
  icon?: React.ReactNode
  /** 徽章文本内容 */
  children: React.ReactNode
}

/** 每种颜色对应的 Tailwind 样式与 CSS 变量 */
const colorConfig: Record<
  BadgeColor,
  { bg: string; text: string; shadow: string; shadowColor?: string }
> = {
  success: {
    bg: 'bg-[oklch(from_var(--success)_l_c_h_/_0.08)]',
    text: 'text-[var(--success-text)]',
    shadow: 'shadow-tinted',
    shadowColor: 'var(--success-rgb)',
  },
  warning: {
    bg: 'bg-[oklch(from_var(--info)_l_c_h_/_0.08)]',
    text: 'text-[var(--info-text)]',
    shadow: 'shadow-tinted',
    shadowColor: 'var(--info-rgb)',
  },
  destructive: {
    bg: 'bg-[oklch(from_var(--destructive)_l_c_h_/_0.08)]',
    text: 'text-[var(--destructive-text)]',
    shadow: 'shadow-tinted',
    shadowColor: 'var(--destructive-rgb)',
  },
  default: {
    bg: 'bg-foreground/10',
    text: 'text-foreground/70',
    shadow: 'shadow-tinted',
    shadowColor: 'var(--foreground-rgb)',
  },
  muted: {
    bg: 'bg-background',
    text: 'text-foreground/70',
    shadow: 'shadow-minimal',
  },
}

export function Info_Badge({
  color = 'default',
  icon,
  children,
  className,
  style,
  ...props
}: Info_BadgeProps) {
  const config = colorConfig[color]

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-[5px] pl-2.5 pr-3 py-1 text-xs font-medium',
        config.bg,
        config.text,
        config.shadow,
        className
      )}
      style={
        config.shadowColor
          ? ({ '--shadow-color': config.shadowColor, ...style } as React.CSSProperties)
          : style
      }
      {...props}
    >
      {icon && <span className="shrink-0">{icon}</span>}
      {children}
    </span>
  )
}
