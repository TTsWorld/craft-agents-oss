/**
 * PanelHeaderCenterButton — 面板头部居中的图标按钮
 *
 * 用于 Navigator/Detail 等面板顶部的操作按钮，带统一样式，
 * 传入 tooltip 时自动包裹 Tooltip。
 */
import * as React from 'react'
import { forwardRef } from 'react'
import { Tooltip, TooltipTrigger, TooltipContent } from '@craft-agent/ui'
import { cn } from '@/lib/utils'

interface PanelHeaderCenterButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** 图标 React 元素，调用方控制尺寸和样式 */
  icon: React.ReactNode
  /** 可选的 tooltip 文本 */
  tooltip?: string
}

/** 面板头部居中图标按钮 */
export const PanelHeaderCenterButton = forwardRef<HTMLButtonElement, PanelHeaderCenterButtonProps>(
  ({ icon, tooltip, className, ...props }, ref) => {
    const button = (
      <button
        ref={ref}
        type="button"
        aria-label={props['aria-label'] ?? tooltip}
        className={cn(
          "panel-header-btn inline-flex items-center justify-center",
          "p-1.5 shrink-0 rounded-[6px] titlebar-no-drag",
          "bg-background shadow-minimal",
          "opacity-70 hover:opacity-100",
          "transition-opacity focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
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
PanelHeaderCenterButton.displayName = 'PanelHeaderCenterButton'
