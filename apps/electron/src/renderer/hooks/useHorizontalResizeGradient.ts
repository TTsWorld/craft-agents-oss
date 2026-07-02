import * as React from "react"

/**
 * 生成水平方向拖动指示器的渐变样式。
 * 渐变中心跟随鼠标在拖动条上的 X 坐标。
 */
export function getHorizontalResizeGradientStyle(mouseX: number | null): React.CSSProperties {
  return {
    transition: 'opacity 150ms ease-out',
    opacity: mouseX !== null ? 1 : 0,
    // 水平径向渐变，中心点跟随鼠标 X 坐标
    background: `radial-gradient(
      circle 66vw at ${mouseX ?? 0}px 50%,
      color-mix(in oklch, var(--foreground) 25%, transparent) 0%,
      color-mix(in oklch, var(--foreground) 12%, transparent) 30%,
      transparent 70%
    )`
  }
}

/**
 * useHorizontalResizeGradient - 水平拖动条的鼠标跟随渐变 hook
 *
 * 与 useResizeGradient 类似，但跟踪 X 坐标，用于水平（行）调整尺寸。
 *
 * 返回：
 * - ref: 绑定到可响应鼠标事件的触摸区域元素
 * - mouseX: 当前 X 坐标（未悬停时为 null）
 * - isDragging: 是否正在拖动
 * - handlers: 触摸区域需要的 onMouseMove、onMouseLeave、onMouseDown
 * - gradientStyle: 视觉指示器的 CSS 样式对象
 */
export function useHorizontalResizeGradient() {
  const [mouseX, setMouseX] = React.useState<number | null>(null)
  const [isDragging, setIsDragging] = React.useState(false)
  const ref = React.useRef<HTMLDivElement>(null)

  const onMouseMove = React.useCallback((e: React.MouseEvent) => {
    if (ref.current) {
      const rect = ref.current.getBoundingClientRect()
      setMouseX(e.clientX - rect.left)
    }
  }, [])

  const onMouseLeave = React.useCallback(() => {
    if (!isDragging) {
      setMouseX(null)
    }
  }, [isDragging])

  const onMouseDown = React.useCallback(() => {
    setIsDragging(true)
  }, [])

  // 拖动期间持续跟踪鼠标位置，并在 mouseup 时清理
  React.useEffect(() => {
    if (!isDragging) return

    const handleMouseMove = (e: MouseEvent) => {
      if (ref.current) {
        const rect = ref.current.getBoundingClientRect()
        setMouseX(e.clientX - rect.left)
      }
    }

    const handleMouseUp = () => {
      setIsDragging(false)
      setMouseX(null)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isDragging])

  return {
    ref,
    mouseX,
    isDragging,
    handlers: { onMouseMove, onMouseLeave, onMouseDown },
    gradientStyle: getHorizontalResizeGradientStyle(mouseX),
  }
}
