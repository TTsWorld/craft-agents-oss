/**
 * TopBarButton — 顶部栏统一按钮。
 *
 * 固定 28×28px，居中内容，圆角 + hover 效果。
 * 用于 Craft logo、前进/后退、侧边栏切换等。
 */
import * as React from "react"
import { cn } from "@/lib/utils"

interface TopBarButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** 按钮内部显示的图标或内容 */
  children: React.ReactNode
  /** 是否处于激活/按下状态（例如下拉菜单打开时） */
  isActive?: boolean
  /** 额外类名 */
  className?: string
}

/** 顶部栏按钮 */
export const TopBarButton = React.forwardRef<HTMLButtonElement, TopBarButtonProps>(
  ({ children, isActive, className, disabled, ...props }, ref) => {
    return (
      <button
        ref={ref}
        type="button"
        disabled={disabled}
        className={cn(
          "header-icon-btn h-7 w-7 flex items-center justify-center rounded-[6px] titlebar-no-drag",
          "hover:bg-foreground/5 focus:outline-none focus-visible:ring-0",
          "disabled:opacity-30 disabled:pointer-events-none",
          "transition-colors duration-100",
          isActive && "bg-foreground/5",
          className
        )}
        {...props}
      >
        {children}
      </button>
    )
  }
)

TopBarButton.displayName = "TopBarButton"
