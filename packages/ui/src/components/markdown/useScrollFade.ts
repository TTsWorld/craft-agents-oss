import * as React from 'react'

const DEFAULT_FADE_SIZE = 32

/**
 * 用于带 CSS 遮罩淡入淡出指示器的水平滚动容器的 Hook。
 * 跟踪滚动位置并生成在内容溢出时淡入淡出边缘的 maskImage 渐变——
 * 与 Mermaid 图示中使用的模式相同。
 */
export function useScrollFade(fadeSize = DEFAULT_FADE_SIZE) {
  const scrollRef = React.useRef<HTMLDivElement>(null)
  const [canScrollLeft, setCanScrollLeft] = React.useState(false)
  const [canScrollRight, setCanScrollRight] = React.useState(false)

  React.useEffect(() => {
    const el = scrollRef.current
    if (!el) return

    const update = () => {
      const { scrollLeft, scrollWidth, clientWidth } = el
      setCanScrollLeft(scrollLeft > 1)
      setCanScrollRight(scrollLeft + clientWidth < scrollWidth - 1)
    }

    update()
    el.addEventListener('scroll', update, { passive: true })
    const ro = new ResizeObserver(update)
    ro.observe(el)

    return () => {
      el.removeEventListener('scroll', update)
      ro.disconnect()
    }
  }, [])

  const maskImage = React.useMemo(() => {
    if (canScrollLeft && canScrollRight) {
      return `linear-gradient(to right, transparent, black ${fadeSize}px, black calc(100% - ${fadeSize}px), transparent)`
    }
    if (canScrollRight) {
      return `linear-gradient(to right, black calc(100% - ${fadeSize}px), transparent)`
    }
    if (canScrollLeft) {
      return `linear-gradient(to right, transparent, black ${fadeSize}px)`
    }
    return undefined
  }, [canScrollLeft, canScrollRight, fadeSize])

  return { scrollRef, maskImage, canScrollLeft, canScrollRight }
}
