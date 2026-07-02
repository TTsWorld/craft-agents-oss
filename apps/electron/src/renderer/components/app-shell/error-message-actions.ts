/**
 * error-message-actions — UI 组件
 * 
 * 所属目录：app-shell
 */
import { navigate, routes } from '@/lib/navigate'
import { dispatchFocusInputEvent } from '@/components/app-shell/input/focus-input-events'
import type { Message } from '../../../shared/types'

/** ErrorMessageAction：消息上附加的错误操作类型 */
export type ErrorMessageAction = NonNullable<Message['errorActions']>[number]

/** HandleErrorMessageActionOptions：处理错误操作的可选回调 */
export interface HandleErrorMessageActionOptions {
  /** 当前会话 ID，重试时用于聚焦对应输入框 */
  sessionId?: string
  /** 打开 URL 的回调 */
  onOpenUrl?: (url: string) => void
  /** 打开设置页的回调，默认跳转到设置路由 */
  onOpenSettings?: () => void
  /** 聚焦输入框的回调，默认派发 focus-input 事件 */
  onRetryFocus?: (detail?: { sessionId?: string }) => void
  /** 自定义重试回调；如果提供则优先使用 */
  onRetry?: () => void
}

/**
 * handleErrorMessageAction - 统一执行消息错误操作。
 *
 * 重试操作有意走“会话级 focus 事件系统”，而不是直接查 DOM。
 * 原因：多面板模式下直接操作 DOM 很脆弱，而且也不再匹配 RichTextInput 的实现。
 */
export function handleErrorMessageAction(
  action: ErrorMessageAction,
  {
    sessionId,
    onOpenUrl,
    onOpenSettings = () => navigate(routes.view.settings()),
    onRetryFocus = dispatchFocusInputEvent,
    onRetry,
  }: HandleErrorMessageActionOptions = {},
): void {
  if (action.action === 'open_url') {
    if (action.url && onOpenUrl) {
      onOpenUrl(action.url)
    }
    return
  }

  if (action.action === 'settings') {
    onOpenSettings()
    return
  }

  if (action.action === 'retry') {
    if (onRetry) {
      onRetry()
    } else {
      onRetryFocus({ sessionId })
    }
  }
}
