export type AnnotationHost = 'turncard' | 'fullscreen'

export interface AnnotationCanAnnotateOptions {
  hasAddAnnotationHandler: boolean
  hasMessageId: boolean
  isStreaming: boolean
}

export function canAnnotateMessage({
  hasAddAnnotationHandler,
  hasMessageId,
  isStreaming,
}: AnnotationCanAnnotateOptions): boolean {
  return hasAddAnnotationHandler && hasMessageId && !isStreaming
}

/**
 * Portal 策略集中管理，以便显式区分不同宿主的差异。
 * Fullscreen 保持覆盖层内渲染，以避免与模态宿主产生的层叠/裁剪问题。
 */
export function shouldRenderAnnotationIslandInPortal(host: AnnotationHost): boolean {
  return host !== 'fullscreen'
}
