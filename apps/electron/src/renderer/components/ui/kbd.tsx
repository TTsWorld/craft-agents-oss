/**
 * 键盘按键（Kbd）与按键组合（KbdGroup）组件。
 * 用于展示快捷键，例如：Ctrl + C、Shift + Tab 等。
 */
import { cn } from "@/lib/utils"

/**
 * 单个键盘按键组件。
 * @param props - 原生 <kbd> 元素的属性，可传入 className 覆盖默认样式。
 */
function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        // 默认样式：静音背景、小号字体、无交互，适合展示快捷键提示
        "bg-muted text-muted-foreground pointer-events-none inline-flex h-5 w-fit min-w-5 items-center justify-center gap-1 rounded-sm px-1 font-sans text-xs font-medium select-none",
        "[&_svg:not([class*='size-'])]:size-3",
        // 在 tooltip 内部时自动调整配色，避免快捷键看不清
        "[[data-slot=tooltip-content]_&]:bg-background/20 [[data-slot=tooltip-content]_&]:text-background dark:[[data-slot=tooltip-content]_&]:bg-background/10",
        className
      )}
      {...props}
    />
  )
}

/**
 * 多个 Kbd 的组合容器，默认横向排列并保持间距。
 * @param props - 原生 <div> 元素的属性，可传入 className 覆盖默认样式。
 */
function KbdGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <kbd
      data-slot="kbd-group"
      className={cn("inline-flex items-center gap-1", className)}
      {...props}
    />
  )
}

export { Kbd, KbdGroup }
