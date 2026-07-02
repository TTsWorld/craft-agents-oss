import * as React from "react"

const RESIZE_GRADIENT_EDGE_BUFFER_PX = 64

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/**
 * 生成垂直方向拖动指示器的渐变样式。
 *
 * 行为：
 * - 渐变在最顶部/最底部边缘始终过渡为透明。
 * - 渐变中心跟随鼠标 Y 坐标，但会被限制在距离边缘至少
 *   RESIZE_GRADIENT_EDGE_BUFFER_PX 的范围内（高度足够时）。
 */
export function getResizeGradientStyle(
  mouseY: number | null,
  handleHeight: number | null,
): React.CSSProperties {
  if (mouseY === null || !handleHeight || handleHeight <= 0) {
    return {
      transition: 'opacity 150ms ease-out',
      opacity: 0,
      background: 'none',
    }
  }

  const height = handleHeight
  const edgeBuffer = Math.min(RESIZE_GRADIENT_EDGE_BUFFER_PX, Math.max(0, Math.floor(height / 2)))
  const centerY = clamp(mouseY, edgeBuffer, height - edgeBuffer)

  const nearCenterDelta = Math.max(20, Math.round(edgeBuffer * 0.22))
  const farCenterDelta = Math.max(56, Math.round(edgeBuffer * 0.75))

  const stopTopNear = clamp(centerY - nearCenterDelta, 0, height)
  const stopTopFar = clamp(centerY - farCenterDelta, 0, height)
  const stopBottomNear = clamp(centerY + nearCenterDelta, 0, height)
  const stopBottomFar = clamp(centerY + farCenterDelta, 0, height)

  return {
    transition: 'opacity 150ms ease-out',
    opacity: 1,
    background: `linear-gradient(
      to bottom,
      transparent 0px,
      color-mix(in oklch, var(--foreground) 10%, transparent) ${stopTopFar}px,
      color-mix(in oklch, var(--foreground) 18%, transparent) ${stopTopNear}px,
      color-mix(in oklch, var(--foreground) 36%, transparent) ${centerY}px,
      color-mix(in oklch, var(--foreground) 18%, transparent) ${stopBottomNear}px,
      color-mix(in oklch, var(--foreground) 10%, transparent) ${stopBottomFar}px,
      transparent ${height}px
    )`,
  }
}

/**
 * useResizeGradient - 垂直拖动条的鼠标跟随渐变 hook
 *
 * 返回：
 * - ref: 绑定到可响应鼠标事件的触摸区域元素
 * - mouseY: 当前 Y 坐标（未悬停时为 null）
 * - handlers: 触摸区域需要的 onMouseMove、onMouseLeave、onMouseDown
 * - gradientStyle: 视觉指示器的 CSS 样式对象
 */
export function useResizeGradient() {
  const [mouseY, setMouseY] = React.useState<number | null>(null)
  const [isDragging, setIsDragging] = React.useState(false)
  const ref = React.useRef<HTMLDivElement>(null)

  const onMouseMove = React.useCallback((e: React.MouseEvent) => {
    if (ref.current) {
      const rect = ref.current.getBoundingClientRect()
      setMouseY(e.clientY - rect.top)
    }
  }, [])

  const onMouseLeave = React.useCallback(() => {
    if (!isDragging) {
      setMouseY(null)
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
        setMouseY(e.clientY - rect.top)
      }
    }

    const handleMouseUp = () => {
      setIsDragging(false)
      setMouseY(null)
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
    mouseY,
    isDragging,
    handlers: { onMouseMove, onMouseLeave, onMouseDown },
    gradientStyle: getResizeGradientStyle(mouseY, ref.current?.clientHeight ?? null),
  }
}
