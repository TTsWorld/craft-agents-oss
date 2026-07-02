/**
 * GradientResizeHandle — 带渐变指示器的拖拽分隔条。
 *
 * 特性：
 * - 12px 触控区域（中心 ±6px），方便拖拽
 * - 1px 静态分隔线始终可见，连接两侧面板
 * - hover 时渐变覆盖层跟随光标（150ms 淡入淡出）
 * - 在 headerHeight 处绘制水平连接线与面板标题分隔线对齐
 *
 * 可直接替换 shadcn/ui 的 ResizableHandle。
 */
import * as React from "react"
import * as ResizablePrimitive from "react-resizable-panels"
import { cn } from "@/lib/utils"
import { useResizeGradient } from "@/hooks/useResizeGradient"

interface GradientResizeHandleProps {
  className?: string
  /** 水平连接线所在高度，与标题分隔线对齐 */
  headerHeight?: number
}

/** 渐变拖拽分隔条 */
export function GradientResizeHandle({ className, headerHeight = 50 }: GradientResizeHandleProps) {
  const { ref, handlers, gradientStyle } = useResizeGradient()

  return (
    <ResizablePrimitive.PanelResizeHandle
      className={cn(
        // 视觉宽度 1px，触控区域通过绝对定位向两侧扩展
        "relative flex w-px items-center justify-center",
        "border-0 shadow-none outline-none ring-0",
        "focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0",
        "after:hidden before:hidden",
        className
      )}
    >
      {/* 水平连接线 — 连接两侧面板的标题分隔线 */}
      <div
        className="absolute h-px bg-border"
        style={{ top: headerHeight, left: -6, right: 0 }}
      />

      {/* 触控区容器 — 向两侧各扩展 6px，共 12px 命中区 */}
      <div
        ref={ref}
        onMouseDown={handlers.onMouseDown}
        onMouseMove={handlers.onMouseMove}
        onMouseLeave={handlers.onMouseLeave}
        className="absolute inset-y-0 -left-1.5 -right-1.5 flex justify-center cursor-col-resize"
      >
        {/* 静态 1px 分隔线 — 始终可见的面板分隔 */}
        <div className="w-px h-full bg-border" />

        {/* 渐变覆盖层 — hover 时淡入，覆盖在分隔线上方 */}
        <div
          className="absolute inset-y-0 left-1/2 -translate-x-1/2 w-0.5"
          style={gradientStyle}
        />
      </div>
    </ResizablePrimitive.PanelResizeHandle>
  )
}
