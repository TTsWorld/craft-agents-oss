/**
 * PreviewHeader - 预览窗口与浮层的统一头部组件
 *
 * 适用于两种场景：
 * - Electron 窗口：左侧为红绿灯按钮（由系统处理），徽标居中
 * - 查看器浮层：徽标居中，右侧为关闭按钮
 *
 * 通过 `onClose` 属性可在右侧显示关闭按钮。
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { X, type LucideIcon } from 'lucide-react'
import { cn } from '../../lib/utils'

/**
 * 使用语义化颜色的徽标变体
 */
export const PREVIEW_BADGE_VARIANTS = {
  edit: 'text-foreground/70',
  write: 'text-foreground/70',
  read: 'text-foreground/70',
  bash: 'text-foreground/70',
  grep: 'text-foreground/70',
  glob: 'text-foreground/70',
  blue: 'text-foreground/70',
  amber: 'text-foreground/70',
  orange: 'text-foreground/70',
  green: 'text-foreground/70',
  purple: 'text-foreground/70',
  gray: 'text-foreground/70',
  default: 'text-foreground/70',
} as const

export type PreviewBadgeVariant = keyof typeof PREVIEW_BADGE_VARIANTS

export interface PreviewHeaderBadgeProps {
  /** 要显示的图标组件 */
  icon?: LucideIcon
  /** 徽标文本 */
  label: string
  /** 徽标变体（默认：'default'） */
  variant?: PreviewBadgeVariant
  /** 点击处理函数（使其成为可点击的链接式按钮） */
  onClick?: () => void
  /** 用于 tooltip 的标题 */
  title?: string
  /** 附加 className */
  className?: string
  /** 允许徽标收缩（适用于长路径） - 默认：false */
  shrinkable?: boolean
}

/**
 * PreviewHeaderBadge - 预览头部的徽标组件
 *
 * 样式规格：
 * - 高度：26px
 * - 内边距：水平 10px
 * - 圆角：6px
 * - 字体：无衬线，13px，中等字重
 * - 截断：CSS 截断、收缩、保持单行
 * - 可点击：悬停时下划线、指针光标
 */
export function PreviewHeaderBadge({
  icon: Icon,
  label,
  variant = 'default',
  onClick,
  title,
  className,
  shrinkable = false,
}: PreviewHeaderBadgeProps) {
  const variantClasses = PREVIEW_BADGE_VARIANTS[variant]
  const baseClasses = cn(
    'flex items-center gap-1.5 h-[26px] px-2.5 rounded-[6px] font-sans text-[13px] font-medium bg-background shadow-minimal',
    variantClasses,
    className
  )

  if (onClick) {
    return (
      <button
        onClick={onClick}
        className={cn(baseClasses, 'min-w-0 cursor-pointer group')}
        title={title || label}
      >
        {Icon && <Icon className="w-3.5 h-3.5 shrink-0" />}
        <span className="truncate group-hover:underline">{label}</span>
      </button>
    )
  }

  return (
    <div className={cn(baseClasses, shrinkable ? 'min-w-0' : 'shrink-0')} title={title || label}>
      {Icon && <Icon className="w-3.5 h-3.5 shrink-0" />}
      <span className="truncate">{label}</span>
    </div>
  )
}

export interface PreviewHeaderProps {
  /** 居中渲染的徽标元素 */
  children?: React.ReactNode
  /** 关闭处理函数 - 提供时在右侧显示 X 按钮 */
  onClose?: () => void
  /** 渲染在右侧、紧邻关闭按钮之前的操作区 */
  rightActions?: React.ReactNode
  /** 头部高度（默认：窗口 50px，浮层 44px） */
  height?: number
  /** 头部的附加 className */
  className?: string
  /** 内联样式 */
  style?: React.CSSProperties
}

/**
 * PreviewHeader - 预览窗口与浮层的头部/工具栏
 *
 * 布局：
 * - 左侧：70px 占位（用于 Electron 中 macOS 的红绿灯按钮）
 * - 中间：徽标行
 * - 右侧：关闭按钮（若提供 onClose）或 70px 占位
 */
export function PreviewHeader({
  children,
  onClose,
  rightActions,
  height = 50,
  className,
  style,
}: PreviewHeaderProps) {
  const { t } = useTranslation()
  return (
    <div
      className={cn(
        'shrink-0 flex items-center justify-between px-3',
        className
      )}
      style={{ height, ...style }}
    >
      {/* 左侧 - 为 macOS 红绿灯按钮留出空间，flex-1 用于与右侧平衡 */}
      <div className="flex-1 min-w-[70px]" />

      {/* 中间 - 徽标行。no-drag 使徽标在窗口拖拽区域内可点击。 */}
      <div className="flex items-center gap-2 min-w-0" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        {children}
      </div>

      {/* 右侧 - 操作区 + 关闭按钮。no-drag 使操作区在窗口拖拽区域内可点击。 */}
      <div className="flex-1 min-w-[70px] flex items-center gap-2 justify-end" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        {rightActions}
        {onClose && (
          <button
            onClick={onClose}
            className={cn(
              'p-1.5 rounded-[6px] bg-background shadow-minimal cursor-pointer',
              'opacity-70 hover:opacity-100 transition-opacity',
              'focus:outline-none focus-visible:ring-1 focus-visible:ring-ring'
            )}
            title={t('common.closeEsc')}
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>
    </div>
  )
}
