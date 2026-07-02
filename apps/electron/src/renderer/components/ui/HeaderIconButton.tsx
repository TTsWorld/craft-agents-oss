/**
 * HeaderIconButton — 面板头部统一图标按钮。
 *
 * 用于 Navigator、Detail 等面板顶部的操作按钮，提供一致样式，
 * 传入 tooltip 时自动包裹 Tooltip。
 */

import * as React from 'react'
import { forwardRef } from 'react'
import { Tooltip, TooltipTrigger, TooltipContent } from '@craft-agent/ui'
import { cn } from '@/lib/utils'

interface HeaderIconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** 图标 React 元素，调用方控制尺寸和样式 */
  icon: React.ReactNode
  /** 可选的 tooltip 文本 */
  tooltip?: string
}

/** 面板头部图标按钮 */
export const HeaderIconButton = forwardRef<HTMLButtonElement, HeaderIconButtonProps>(
  ({ icon, tooltip, className, ...props }, ref) => {
    const button = (
      <button
        ref={ref}
        type="button"
        className={cn(
          "header-icon-btn inline-flex items-center justify-center",
          "h-7 w-7 shrink-0 rounded-[4px] titlebar-no-drag",
          "text-muted-foreground hover:text-foreground hover:bg-foreground/3",
          "data-[state=open]:text-foreground data-[state=open]:bg-foreground/3",
          "transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          "disabled:pointer-events-none disabled:opacity-50",
          className
        )}
        {...props}
      >
        {icon}
      </button>
    )

    if (tooltip) {
      return (
        <Tooltip>
          <TooltipTrigger asChild>{button}</TooltipTrigger>
          <TooltipContent>{tooltip}</TooltipContent>
        </Tooltip>
      )
    }

    return button
  }
)
HeaderIconButton.displayName = 'HeaderIconButton'
