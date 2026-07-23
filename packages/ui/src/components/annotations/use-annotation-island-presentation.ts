import * as React from 'react'

export interface UseAnnotationIslandPresentationOptions {
  anchor: { x: number; y: number } | null
  sourceKey: string
  closeGraceMs?: number
}

export interface AnnotationIslandPresentationState {
  renderAnchor: { x: number; y: number } | null
  renderSourceKey: string
  isVisible: boolean
  openedAtRef: React.MutableRefObject<number>
  handleExitComplete: () => void
  resetPresentation: () => void
}

export type AnnotationIslandPresentationDecision =
  | { kind: 'open' }
  | { kind: 'close-now' }
  | { kind: 'defer-close'; afterMs: number }

export interface DecidePresentationInput {
  hasAnchor: boolean
  hasRenderAnchor: boolean
  now: number
  openedAt: number
  closeGraceMs: number
}

// 展示 effect 的纯决策逻辑。
// 导出以便在无 React 渲染器的情况下进行单元测试。
export function decideAnnotationIslandPresentation(
  input: DecidePresentationInput,
): AnnotationIslandPresentationDecision {
  if (input.hasAnchor) return { kind: 'open' }
  const elapsed = input.now - input.openedAt
  if (elapsed < input.closeGraceMs && input.hasRenderAnchor) {
    return { kind: 'defer-close', afterMs: input.closeGraceMs - elapsed }
  }
  return { kind: 'close-now' }
}

export function useAnnotationIslandPresentation({
  anchor,
  sourceKey,
  closeGraceMs = 220,
}: UseAnnotationIslandPresentationOptions): AnnotationIslandPresentationState {
  const [renderAnchor, setRenderAnchor] = React.useState<{ x: number; y: number } | null>(null)
  const [renderSourceKey, setRenderSourceKey] = React.useState('none')
  const [isVisible, setIsVisible] = React.useState(false)
  const openedAtRef = React.useRef(0)

  React.useEffect(() => {
    const decision = decideAnnotationIslandPresentation({
      hasAnchor: !!anchor,
      hasRenderAnchor: !!renderAnchor,
      now: Date.now(),
      openedAt: openedAtRef.current,
      closeGraceMs,
    })

    if (decision.kind === 'open' && anchor) {
      openedAtRef.current = Date.now()
      setRenderAnchor(anchor)
      setRenderSourceKey(sourceKey)
      setIsVisible(true)
      return
    }

    if (decision.kind === 'defer-close') {
      // 延迟关闭，避免进入动画过程中 anchor 短暂为 null 导致 island 瞬间关闭。
      // 如果 anchor 恢复，清理函数会取消该定时器。
      const timer = setTimeout(() => setIsVisible(false), decision.afterMs)
      return () => clearTimeout(timer)
    }

    setIsVisible(false)
  }, [anchor, sourceKey, closeGraceMs, renderAnchor])

  const handleExitComplete = React.useCallback(() => {
    if (anchor) return
    setRenderAnchor(null)
    setRenderSourceKey('none')
  }, [anchor])

  const resetPresentation = React.useCallback(() => {
    setRenderAnchor(null)
    setRenderSourceKey('none')
    setIsVisible(false)
    openedAtRef.current = 0
  }, [])

  return {
    renderAnchor,
    renderSourceKey,
    isVisible,
    openedAtRef,
    handleExitComplete,
    resetPresentation,
  }
}
