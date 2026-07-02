/**
 * 样式化的右键菜单组件集合（StyledContextMenu）。
 * 在基础 context-menu 之上封装统一的视觉风格，与 StyledDropdownMenu 保持一致。
 */
import * as React from "react"
import * as ContextMenuPrimitive from "@radix-ui/react-context-menu"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent,
  ContextMenuPortal,
} from "./context-menu"
import { cn } from "@/lib/utils"

// 原样重新导出无需二次封装的组件
export { ContextMenu, ContextMenuTrigger }

// 样式化内容区
interface StyledContextMenuContentProps
  extends React.ComponentPropsWithoutRef<typeof ContextMenuContent> {
  /** 最小宽度（默认 min-w-40）。 */
  minWidth?: string
}

/** 样式化右键菜单内容容器。 */
export const StyledContextMenuContent = React.forwardRef<
  React.ComponentRef<typeof ContextMenuContent>,
  StyledContextMenuContentProps
>(({ className, minWidth = "min-w-40", ...props }, ref) => (
  <ContextMenuContent
    ref={ref}
    className={cn(
      "w-fit font-sans whitespace-nowrap text-xs flex flex-col gap-0.5",
      minWidth,
      className
    )}
    {...props}
  />
))
StyledContextMenuContent.displayName = "StyledContextMenuContent"

// 样式化菜单项
interface StyledContextMenuItemProps
  extends React.ComponentPropsWithoutRef<typeof ContextMenuItem> {
  /** destructive 变体使用红色文本。 */
  variant?: "default" | "destructive"
}

/** 样式化右键菜单项。 */
export const StyledContextMenuItem = React.forwardRef<
  React.ComponentRef<typeof ContextMenuItem>,
  StyledContextMenuItemProps
>(({ className, variant = "default", ...props }, ref) => (
  <ContextMenuItem
    ref={ref}
    className={cn(
      "gap-3 pr-4 rounded-[4px] hover:bg-foreground/[0.03] focus:bg-foreground/[0.03]",
      "[&_svg]:size-auto [&>svg]:h-3.5 [&>svg]:w-3.5 [&>svg]:shrink-0",
      variant === "destructive" && "text-destructive focus:text-destructive hover:text-destructive [&_svg]:!text-destructive",
      className
    )}
    {...props}
  />
))
StyledContextMenuItem.displayName = "StyledContextMenuItem"

// 样式化分隔线
/** 样式化右键菜单分隔线。 */
export const StyledContextMenuSeparator = React.forwardRef<
  React.ComponentRef<typeof ContextMenuSeparator>,
  React.ComponentPropsWithoutRef<typeof ContextMenuSeparator>
>(({ className, ...props }, ref) => (
  <ContextMenuSeparator
    ref={ref}
    className={cn("bg-foreground/10", className)}
    {...props}
  />
))
StyledContextMenuSeparator.displayName = "StyledContextMenuSeparator"

// 子菜单根节点直接重命名导出
export { ContextMenuSub as StyledContextMenuSub }

// 样式化子菜单触发项
/** 样式化右键子菜单触发项。 */
export const StyledContextMenuSubTrigger = React.forwardRef<
  React.ComponentRef<typeof ContextMenuSubTrigger>,
  React.ComponentPropsWithoutRef<typeof ContextMenuSubTrigger>
>(({ className, ...props }, ref) => (
  <ContextMenuSubTrigger
    ref={ref}
    className={cn(
      "gap-3 pr-4 rounded-[4px] hover:bg-foreground/10 focus:bg-foreground/10 data-[state=open]:bg-foreground/10",
      "[&>svg]:h-3.5 [&>svg]:w-3.5 [&>svg]:shrink-0",
      className
    )}
    {...props}
  />
))
StyledContextMenuSubTrigger.displayName = "StyledContextMenuSubTrigger"

// 样式化子菜单内容
interface StyledContextMenuSubContentProps
  extends React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.SubContent> {
  /** 最小宽度（默认 min-w-36）。 */
  minWidth?: string
}

/** 样式化右键子菜单内容。 */
export const StyledContextMenuSubContent = React.forwardRef<
  React.ComponentRef<typeof ContextMenuPrimitive.SubContent>,
  StyledContextMenuSubContentProps
>(({ className, minWidth = "min-w-36", sideOffset = -4, ...props }, ref) => (
  <ContextMenuPortal>
    <ContextMenuPrimitive.SubContent
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        "popover-styled w-fit font-sans whitespace-nowrap text-xs flex flex-col gap-0.5 z-dropdown overflow-hidden p-1",
        "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
        minWidth,
        className
      )}
      {...props}
    />
  </ContextMenuPortal>
))
StyledContextMenuSubContent.displayName = "StyledContextMenuSubContent"
