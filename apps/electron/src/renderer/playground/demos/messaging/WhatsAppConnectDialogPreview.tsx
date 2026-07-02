/**
 * WhatsAppConnectDialogPreview
 * WhatsAppConnectDialogPreview：WhatsApp 连接弹窗的 playground 预览。
 *
 * The real WhatsAppConnectDialog's internal phase state machine is driven by
 * `onWhatsAppEvent` callbacks — not props — so we can't force the phase via
 * props directly. Instead, when the variant prop changes we fire a synthetic
 * event through the playground messaging handle, which is the same mechanism
 * the mock IPC uses to drive the real state transitions.
 * 真实组件内部的状态机由 onWhatsAppEvent 回调驱动，而不是 props。
 * 因此这里通过 playgroundMessagingHandle 触发自定义事件来模拟不同状态。
 *
 * A small key-on-phase trick remounts the dialog so events fire cleanly
 * without stale timers (the "connected" phase auto-closes after 1.2s).
 * 用 key={phase} 在阶段变化时强制重新挂载组件，避免旧定时器污染新状态。
 */

import * as React from 'react'
import { WhatsAppConnectDialog } from '../../../components/messaging/WhatsAppConnectDialog'
import { playgroundMessagingHandle } from '../../mock-utils'

// 弹窗可能处于的状态；字符串联合类型保证类型安全。
type Phase = 'idle' | 'starting' | 'show_qr' | 'connected' | 'error'

/** WhatsAppConnectDialogPreviewProps：组件 props 类型定义 */
export interface WhatsAppConnectDialogPreviewProps {
  phase: Phase
  errorMessage: string
}

// 示例 QR 字符串，仅用于 playground 演示。
const SAMPLE_QR =
  'playground://whatsapp/qr/2@abcDEF123456ghiJKL789mnoPQR,sampleKeyMaterialBase64encoded==,xxyyzz'

/** WhatsAppConnectDialogPreview：函数 */
export function WhatsAppConnectDialogPreview({
  phase,
  errorMessage,
}: WhatsAppConnectDialogPreviewProps) {
  // 弹窗开关状态；用户可以在 playground 里关闭弹窗。
  const [open, setOpen] = React.useState(true)

  // Reopen on any prop change so switching variants in the sidebar brings
  // the dialog back up after the user has dismissed it.
  // playground 侧边栏切换变体时，自动重新打开弹窗。
  React.useEffect(() => {
    setOpen(true)
  }, [phase, errorMessage])

  // Re-fire the synthetic event whenever the phase prop changes so the
  // dialog's internal state machine lands in the requested phase.
  // 当 phase prop 变化时，通过 mock handle 触发对应事件，让真实组件内部状态机切换。
  React.useEffect(() => {
    if (phase === 'idle' || phase === 'starting') return
    // Defer to next tick so the dialog's own listener is attached.
    // 延迟到下一个事件循环，确保目标组件的事件监听器已注册。
    const handle = setTimeout(() => {
      switch (phase) {
        case 'show_qr':
          playgroundMessagingHandle.fireWAEvent({ type: 'qr', qr: SAMPLE_QR })
          return
        case 'connected':
          playgroundMessagingHandle.fireWAEvent({
            type: 'connected',
            name: 'Gyula',
          })
          return
        case 'error':
          playgroundMessagingHandle.fireWAEvent({
            type: 'error',
            message: errorMessage || 'Pairing failed: unknown error',
          })
          return
      }
    }, 50)
    // useEffect 返回清理函数，在组件卸载或依赖变化时清除定时器，防止内存泄漏。
    return () => clearTimeout(handle)
  }, [phase, errorMessage])

  // Force remount when phase changes so internal timers don't leak between
  // variants (e.g. the "connected" auto-close would otherwise clobber a
  // subsequent "show_qr" selection after 1.2s).
  return (
    <>
      {/* React 的 key 变化会让组件卸载并重挂，这里 key=phase 保证阶段切换时清掉旧定时器。 */}
      <WhatsAppConnectDialog
        key={phase}
        open={open}
        onOpenChange={setOpen}
      />
      {/* 用户关闭弹窗后展示提示和重新打开按钮。 */}
      {!open && (
        <div className="p-6 text-sm text-foreground/60">
          Dialog dismissed.{' '}
          <button
            type="button"
            className="underline hover:text-foreground"
            onClick={() => setOpen(true)}
          >
            Reopen
          </button>
        </div>
      )}
    </>
  )
}
