/**
 * input-event-guards.ts
 *
 * 输入框相关自定义事件的“作用域”判断工具。
 * Electron 里同一个窗口可能同时打开多个 panel（多会话分栏），
 * 需要通过 sessionId / focusedPanel 判断事件应该由哪个输入框处理。
 */

/** 事件目标的作用域信息 */
export interface ScopedInputEventTarget {
  /** 当前输入框所属的会话 ID */
  sessionId?: string | null
  /** 当前输入框所在面板是否处于聚焦状态 */
  isFocusedPanel: boolean
  /** 事件明确指定的目标会话 ID */
  targetSessionId?: string
}

/**
 * 判断一个影响输入框的自定义事件是否应该由当前 FreeFormInput 实例处理。
 *
 * 规则：
 * - 如果事件带了 targetSessionId，只有目标会话匹配才处理；
 * - 否则只在当前面板聚焦时处理，避免多个 panel 同时响应。
 */
export function shouldHandleScopedInputEvent({
  sessionId,
  isFocusedPanel,
  targetSessionId,
}: ScopedInputEventTarget): boolean {
  if (targetSessionId) {
    return targetSessionId === sessionId
  }
  return isFocusedPanel
}
