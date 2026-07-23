import type { AnnotationV1 } from '@craft-agent/core'
import { getAnnotationFollowUpState, type AnnotationFollowUpState } from './follow-up-state'

export type AnnotationChipInteraction = {
  state: AnnotationFollowUpState
  clickable: boolean
  tooltipOnly: boolean
  openMode: 'view'
}

/**
 * 统一的批注徽章交互行为：
 * - 已发送 follow-up 的徽章仅展示 tooltip（点击不打开 island）
 * - pending/未发送的徽章以查看模式打开批注详情
 */
export function getAnnotationChipInteraction(annotation?: AnnotationV1 | null): AnnotationChipInteraction {
  const state = annotation ? getAnnotationFollowUpState(annotation) : 'none'
  const isSent = state === 'sent'

  return {
    state,
    clickable: !isSent,
    tooltipOnly: isSent,
    openMode: 'view',
  }
}

export function isAnnotationChipClickable(annotation?: AnnotationV1 | null): boolean {
  return getAnnotationChipInteraction(annotation).clickable
}

export function getAnnotationChipOpenMode(): 'view' {
  return 'view'
}

/**
 * 来自批注索引徽章的 mouseup 事件不应触发文本选区的 follow-up 流程。
 * 这样可保证徽章点击与文本选区行为在内联和全屏渲染器中保持一致。
 */
export function shouldIgnoreSelectionMouseUpTarget(target: EventTarget | null): boolean {
  const targetElement = target instanceof Element ? target : null
  return Boolean(targetElement?.closest('[data-ca-annotation-index]'))
}
