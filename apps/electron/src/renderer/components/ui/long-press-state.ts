/**
 * long-press-state —— 长按手势状态机的纯工具函数
 *
 * 这些逻辑从 EntityRow 中拆出来，方便单元测试（不需要挂载 React）。
 * 实际定时器/pointermove 循环由调用方驱动，本模块只决定“当前这一刻该做什么”。
 *
 * 默认值（LONG_PRESS_MS=500ms、MOVE_TOLERANCE_PX=10px）针对触摸设备调校：
 * 500ms 接近 iOS/Material 的长按手感，10px 给拇指按压时的轻微晃动留足余量。
 */

export const LONG_PRESS_MS = 500
/** 移动容差（像素） */
export const MOVE_TOLERANCE_PX = 10

/** 指针坐标 */
export interface PointerCoords {
  x: number
  y: number
}

/** 长按决策结果 */
export interface LongPressDecision {
  /** 为 true 表示当前刻度应触发长按（手势成功） */
  fire: boolean
  /** 为 true 表示应取消手势（例如用户拖动超过容差） */
  cancel: boolean
}

/**
 * 根据指针起始位置、当前位置和已过去的时间，决定下一步动作。
 *
 * 优先级规则：
 *  1. 移动超过容差优先：手指离开起点超过 tolerancePx 时，无论定时器状态如何都取消手势
 *     —— 用户在滚动/拖拽，而不是长按。
 *  2. 然后检查定时器：已过去时间 >= thresholdMs 且在容差内，触发长按。
 *  3. 否则继续等待：既不触发也不取消。
 *
 * 容差比较是包含边界（<= tolerancePx），因此刚好落在边界上的手指仍算静止。
 * 用平方距离避免每次 pointermove 都计算 Math.sqrt。
 */
export function shouldFireLongPress(
  start: PointerCoords,
  current: PointerCoords,
  elapsedMs: number,
  thresholdMs: number = LONG_PRESS_MS,
  tolerancePx: number = MOVE_TOLERANCE_PX,
): LongPressDecision {
  const dx = current.x - start.x
  const dy = current.y - start.y
  const distanceSq = dx * dx + dy * dy
  const toleranceSq = tolerancePx * tolerancePx

  if (distanceSq > toleranceSq) {
    return { fire: false, cancel: true }
  }
  if (elapsedMs >= thresholdMs) {
    return { fire: true, cancel: false }
  }
  return { fire: false, cancel: false }
}
