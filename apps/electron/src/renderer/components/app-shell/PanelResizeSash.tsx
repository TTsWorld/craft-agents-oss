/**
 * PanelResizeSash - 分屏视图中相邻内容面板之间的细拖拽分隔条。
 *
 * 复用了侧边栏/导航器分隔条的渐变样式，保持视觉一致。
 * - 拖拽调整两个相邻面板的宽度
 * - 双击恢复为等分（基于它们合并后的 proportion）
 * - 拖拽时强制两侧都不小于 PANEL_MIN_WIDTH
 * - 从 DOM 中测量相邻面板的宽度，不需要外部传入 width prop
 */

import { useCallback, useRef } from 'react'
import { useSetAtom, useAtomValue } from 'jotai'
import { panelStackAtom, resizePanelsAtom } from '@/atoms/panel-stack'
import { useResizeGradient } from '@/hooks/useResizeGradient'
import {
  PANEL_MIN_WIDTH,
  PANEL_SASH_FLEX_MARGIN,
  PANEL_SASH_HALF_HIT_WIDTH,
  PANEL_SASH_LINE_WIDTH,
  PANEL_STACK_VERTICAL_OVERFLOW,
} from './panel-constants'

export { PANEL_MIN_WIDTH }

interface PanelResizeSashProps {
  /** 分隔条左侧面板在 panelStack 中的下标 */
  leftIndex: number
  /** 分隔条右侧面板在 panelStack 中的下标 */
  rightIndex: number
}

/** PanelResizeSash - 分屏面板拖拽分隔条 */
export function PanelResizeSash({
  leftIndex,
  rightIndex,
}: PanelResizeSashProps) {
  const resizePanels = useSetAtom(resizePanelsAtom)
  const panelStack = useAtomValue(panelStackAtom)
  const { ref, handlers, gradientStyle } = useResizeGradient()
  const startXRef = useRef(0)
  const startLeftWidthRef = useRef(0)
  const startRightWidthRef = useRef(0)
  const combinedProportionRef = useRef(0)

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    handlers.onMouseDown()

    const sashEl = ref.current
    if (!sashEl) return

    // 从 DOM 测量相邻面板的宽度：
    // sash 的 previousElementSibling 是左层面板 div，nextElementSibling 是右层面板 div。
    const leftPanel = sashEl.previousElementSibling as HTMLElement | null
    const rightPanel = sashEl.nextElementSibling as HTMLElement | null
    if (!leftPanel || !rightPanel) return

    startXRef.current = e.clientX
    startLeftWidthRef.current = leftPanel.getBoundingClientRect().width
    startRightWidthRef.current = rightPanel.getBoundingClientRect().width

    const leftProp = panelStack[leftIndex]?.proportion ?? 0.5
    const rightProp = panelStack[rightIndex]?.proportion ?? 0.5
    combinedProportionRef.current = leftProp + rightProp

    const handleMouseMove = (e: MouseEvent) => {
      const delta = e.clientX - startXRef.current
      const combinedWidth = startLeftWidthRef.current + startRightWidthRef.current

      // 计算新宽度并限制最小值
      let newLeftWidth = startLeftWidthRef.current + delta
      let newRightWidth = startRightWidthRef.current - delta

      if (newLeftWidth < PANEL_MIN_WIDTH) {
        newLeftWidth = PANEL_MIN_WIDTH
        newRightWidth = combinedWidth - PANEL_MIN_WIDTH
      }
      if (newRightWidth < PANEL_MIN_WIDTH) {
        newRightWidth = PANEL_MIN_WIDTH
        newLeftWidth = combinedWidth - PANEL_MIN_WIDTH
      }

      // 把像素比例转换回 proportion，同时保持合并后的 proportion 不变
      const combined = combinedProportionRef.current
      const total = newLeftWidth + newRightWidth
      const leftProportion = (newLeftWidth / total) * combined
      const rightProportion = combined - leftProportion

      resizePanels({ leftIndex, rightIndex, leftProportion, rightProportion })
    }

    const handleMouseUp = () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
    }

    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }, [leftIndex, rightIndex, panelStack, resizePanels, handlers, ref])

  const handleDoubleClick = useCallback(() => {
    // 双击：把相邻两个面板恢复为合并 proportion 的等分
    const left = panelStack[leftIndex]
    const right = panelStack[rightIndex]
    if (!left || !right) return
    const combined = left.proportion + right.proportion
    const half = combined / 2
    resizePanels({
      leftIndex,
      rightIndex,
      leftProportion: half,
      rightProportion: half,
    })
  }, [leftIndex, rightIndex, panelStack, resizePanels])

  return (
    <div
      ref={ref}
      className="relative w-0 h-full cursor-col-resize flex justify-center shrink-0"
      style={{ margin: `0 ${PANEL_SASH_FLEX_MARGIN}px` }}
      onMouseDown={handleMouseDown}
      onMouseMove={handlers.onMouseMove}
      onMouseLeave={handlers.onMouseLeave}
      onDoubleClick={handleDoubleClick}
    >
      {/* 触摸/点击热区：比可见线条更宽，方便拖拽 */}
      <div
        className="absolute inset-y-0 flex justify-center cursor-col-resize"
        style={{ left: -PANEL_SASH_HALF_HIT_WIDTH, right: -PANEL_SASH_HALF_HIT_WIDTH }}
      >
        <div
          className="absolute left-1/2 -translate-x-1/2"
          style={{
            ...gradientStyle,
            width: PANEL_SASH_LINE_WIDTH,
            top: PANEL_STACK_VERTICAL_OVERFLOW,
            bottom: PANEL_STACK_VERTICAL_OVERFLOW,
          }}
        />
      </div>
    </div>
  )
}
