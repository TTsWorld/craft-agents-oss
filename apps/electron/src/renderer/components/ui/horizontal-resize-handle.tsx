/**
 * 水平拖拽调整条组件（HorizontalResizeHandle）。
 * 用于上下分割面板，可上下拖动改变面板高度。
 * 特性：
 * - 12px 触摸热区（中心 ±6px），方便抓取
 * - 始终可见的 1px 分隔线
 * - 悬停时渐变光效跟随光标（150ms 淡入淡出）
 * - 垂直分割光标 cursor-row-resize
 */
import * as React from "react"
import { cn } from "@/lib/utils"
import { useHorizontalResizeGradient } from "@/hooks/useHorizontalResizeGradient"

interface HorizontalResizeHandleProps {
  /** 拖拽过程中回调，deltaY 为正表示向下移动。 */
  onResize: (deltaY: number) => void
  /** 拖拽结束回调。 */
  onResizeEnd?: () => void
  className?: string
}

/** 水平调整条组件。 */
export function HorizontalResizeHandle({ onResize, onResizeEnd, className }: HorizontalResizeHandleProps) {
  const { ref, handlers, gradientStyle, isDragging } = useHorizontalResizeGradient()
  const lastYRef = React.useRef<number | null>(null)

  // 处理拖拽移动
  React.useEffect(() => {
    if (!isDragging) {
      lastYRef.current = null
      return
    }

    const handleMouseMove = (e: MouseEvent) => {
      if (lastYRef.current !== null) {
        const deltaY = e.clientY - lastYRef.current
        onResize(deltaY)
      }
      lastYRef.current = e.clientY
    }

    const handleMouseUp = () => {
      lastYRef.current = null
      onResizeEnd?.()
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isDragging, onResize, onResizeEnd])

  // 鼠标按下时记录初始 Y 坐标
  const handleMouseDown = (e: React.MouseEvent) => {
    lastYRef.current = e.clientY
    handlers.onMouseDown()
  }

  return (
    <div
      className={cn(
        // 视觉高度 1px，热区通过绝对定位向外扩展
        "relative flex h-px w-full items-center justify-center shrink-0",
        className
      )}
    >
      {/* 触摸热区容器：向上下各扩展 6px，总热区 12px */}
      <div
        ref={ref}
        onMouseDown={handleMouseDown}
        onMouseMove={handlers.onMouseMove}
        onMouseLeave={handlers.onMouseLeave}
        className="absolute inset-x-0 -top-1.5 -bottom-1.5 flex items-center cursor-row-resize"
      >
        {/* 静态 1px 分隔线，始终作为面板分隔显示 */}
        <div className="w-full h-px bg-border" />

        {/* 渐变叠加层：悬停时淡入，覆盖在分隔线上方 */}
        <div
          className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-0.5"
          style={gradientStyle}
        />
      </div>
    </div>
  )
}
