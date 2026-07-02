/**
 * focus-input-events.ts
 *
 * 管理“聚焦输入框”的跨组件事件。
 * 因为输入框可能在会话切换后才挂载，单纯派发 CustomEvent 可能错过；
 * 这里用 pendingFocusSessionId 做队列，新输入框挂载后可以消费这个待处理请求。
 */

/** craft:focus-input 事件携带的参数 */
export interface FocusInputEventDetail {
  sessionId?: string
}

/** 待聚焦的会话 ID，用于解决会话切换竞态 */
let pendingFocusSessionId: string | null = null

/**
 * 把聚焦请求入队。
 * 新挂载的输入框可以通过 consumePendingFocusForSession 检查并消费这个请求
 *（例如从 SessionList 按 Enter 切换到某个会话后聚焦其输入框）。
 */
export function queuePendingFocusForSession(sessionId?: string | null): void {
  if (!sessionId) return
  pendingFocusSessionId = sessionId
}

/**
 * 派发全局 focus-input 事件，并保存待处理目标。
 * 调用方（如弹出菜单关闭后）用此事件通知输入框重新聚焦。
 */
export function dispatchFocusInputEvent(detail: FocusInputEventDetail = {}): void {
  queuePendingFocusForSession(detail.sessionId)
  window.dispatchEvent(new CustomEvent<FocusInputEventDetail>('craft:focus-input', { detail }))
}

/**
 * 消费指定会话的待处理聚焦请求。
 * 返回 true 表示成功消费，调用方应执行 focus()。
 */
export function consumePendingFocusForSession(sessionId?: string | null): boolean {
  if (!sessionId || pendingFocusSessionId !== sessionId) return false
  pendingFocusSessionId = null
  return true
}

/** 清除指定会话的待处理聚焦请求 */
export function clearPendingFocusForSession(sessionId?: string | null): void {
  if (!sessionId) return
  if (pendingFocusSessionId === sessionId) {
    pendingFocusSessionId = null
  }
}

/** 仅用于测试：重置待处理状态 */
export function __resetPendingFocusForTests(): void {
  pendingFocusSessionId = null
}
