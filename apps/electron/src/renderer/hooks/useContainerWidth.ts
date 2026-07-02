import { useState, useEffect, type RefObject } from 'react'

/**
 * 用 ResizeObserver 跟踪某个 DOM 元素的内联宽度（即内容宽度）。
 *
 * AppShell 用它推导 isAutoCompact：当外壳容器宽度小于移动端阈值时，
 * 侧边栏/导航器自动折叠，面板切换为单栏模式。
 *
 * 在首次测量前返回 0。
 */
export function useContainerWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0)

  useEffect(() => {
    const el = ref.current
    if (!el) return

    const ro = new ResizeObserver(([entry]) => {
      setWidth(entry.contentBoxSize[0].inlineSize)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])

  return width
}
