/**
 * structured-height.ts
 *
 * 计算“结构化输入”（权限申请、凭证输入等卡片）的最大高度。
 * 目标：在大部分屏幕下不要过高，同时在小屏幕上也不要太矮。
 */

/** 结构化输入最大高度（像素） */
const STRUCTURED_INPUT_MAX_HEIGHT = 480

/** 结构化输入最小高度（像素） */
const STRUCTURED_INPUT_MIN_HEIGHT = 160

/** 结构化输入高度占视口高度的比例 */
const STRUCTURED_INPUT_VIEWPORT_RATIO = 0.7

/**
 * 根据视口高度计算结构化输入允许的最大高度。
 * 结果限制在 [MIN_HEIGHT, MAX_HEIGHT] 之间，并取视口高度的 70% 向下取整。
 */
export function getStructuredInputMaxHeight(viewportHeight: number): number {
  if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) {
    return STRUCTURED_INPUT_MAX_HEIGHT
  }

  return Math.max(
    STRUCTURED_INPUT_MIN_HEIGHT,
    Math.min(STRUCTURED_INPUT_MAX_HEIGHT, Math.floor(viewportHeight * STRUCTURED_INPUT_VIEWPORT_RATIO))
  )
}
