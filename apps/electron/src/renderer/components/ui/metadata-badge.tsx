/**
 * MetadataBadge —— 元数据徽章组件
 *
 * 用于展示 Label、State 等小块元数据。左侧可带图标，中间是主标签，
 * 可选显示分隔点和值文本；支持悬停/点击样式和下拉箭头。
 */

import * as React from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'

/** MetadataBadge 的 props 类型 */
export interface MetadataBadgeProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** 主标签文本 */
  label: string
  /** 可选的次级值文本 */
  value?: string
  /** 设置后，值文本会渲染成可点击链接并调用该回调。
   *  处理器会阻止冒泡，避免触发外层 popover/trigger。 */
  onValueClick?: (e: React.MouseEvent) => void
  /** 可选的左侧图标 */
  icon?: React.ReactNode
  /** 未设置值时显示的右侧提示图标 */
  valueHintIcon?: React.ReactNode
  /** 徽章背景/文字的取色来源 */
  badgeColor?: string
  /** 是否启用悬停/点击样式 */
  interactive?: boolean
  /** 激活/打开状态样式 */
  isActive?: boolean
  /** 是否在右侧显示下拉箭头 */
  showChevron?: boolean
  /** 徽章阴影样式 */
  shadow?: 'none' | 'minimal'
}

/** 元数据徽章 */
export const MetadataBadge = React.forwardRef<HTMLButtonElement, MetadataBadgeProps>(
  function MetadataBadge(
    {
      label,
      value,
      onValueClick,
      icon,
      valueHintIcon,
      badgeColor = 'var(--foreground)',
      interactive = false,
      isActive = false,
      showChevron = false,
      shadow = 'minimal',
      className,
      type = 'button',
      style,
      ...buttonProps
    },
    ref
  ) {
    return (
      <button
        ref={ref}
        type={type}
        {...buttonProps}
        className={cn(
          'h-[30px] pl-3 pr-4 text-xs font-medium rounded-[8px] flex items-center shrink-0',
          'outline-none select-none transition-colors',
          shadow === 'minimal' && 'shadow-minimal',
          'bg-[color-mix(in_srgb,var(--background)_97%,var(--badge-color))]',
          'text-[color-mix(in_srgb,var(--foreground)_80%,var(--badge-color))]',
          interactive && 'cursor-pointer hover:bg-[color-mix(in_srgb,var(--background)_92%,var(--badge-color))]',
          interactive && isActive && 'bg-[color-mix(in_srgb,var(--background)_92%,var(--badge-color))]',
          !interactive && 'cursor-default',
          className
        )}
        style={{ ...style, '--badge-color': badgeColor } as React.CSSProperties}
      >
        {icon}

        <span className={cn('whitespace-nowrap', icon ? 'ml-2' : '')}>{label}</span>

        {value ? (
          <>
            <span className="opacity-30 mx-1">·</span>
            <span
              className={cn(
                'whitespace-nowrap max-w-[140px] truncate',
                onValueClick
                  ? 'opacity-80 cursor-pointer hover:underline underline-offset-2'
                  : 'opacity-60'
              )}
              title={onValueClick ? value : undefined}
              onClick={onValueClick ? (e) => { e.stopPropagation(); onValueClick(e) } : undefined}
            >
              {value}
            </span>
          </>
        ) : (
          valueHintIcon && (
            <>
              <span className="opacity-30 mx-1">·</span>
              {valueHintIcon}
            </>
          )
        )}

        {showChevron && (
          <ChevronDown className="h-3 w-3 opacity-40 ml-1 shrink-0" />
        )}
      </button>
    )
  }
)
