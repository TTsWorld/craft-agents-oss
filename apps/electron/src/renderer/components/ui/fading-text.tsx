/**
 * FadingText — 溢出时才显示右侧渐隐效果的文本。
 *
 * 用 CSS mask-image 在文本溢出容器时给右边缘加渐变渐隐。
 * 仅在检测到溢出时才应用遮罩。
 */
import { useRef, useState, useLayoutEffect } from 'react'
import { cn } from '@/lib/utils'

interface FadingTextProps {
  children: React.ReactNode
  className?: string
  /** 渐隐宽度，单位像素（默认 24） */
  fadeWidth?: number
}

/** 渐隐文本 */
export function FadingText({ children, className, fadeWidth = 24 }: FadingTextProps) {
  const ref = useRef<HTMLSpanElement>(null)
  const [isOverflowing, setIsOverflowing] = useState(false)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const check = () => setIsOverflowing(el.scrollWidth > el.clientWidth)
    check()
    const observer = new ResizeObserver(check)
    observer.observe(el)
    return () => observer.disconnect()
  }, [children])

  return (
    <span
      ref={ref}
      className={cn("overflow-hidden whitespace-nowrap min-w-0", className)}
      style={isOverflowing ? {
        maskImage: `linear-gradient(to right, black calc(100% - ${fadeWidth}px), transparent)`
      } : undefined}
    >
      {children}
    </span>
  )
}
