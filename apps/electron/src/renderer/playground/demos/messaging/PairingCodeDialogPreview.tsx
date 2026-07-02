/**
 * PairingCodeDialogPreview
 * PairingCodeDialogPreview：配对码弹窗的 playground 预览。
 *
 * Renders the real PairingCodeDialog with `open` wired to local state so the
 * user can dismiss it (ESC / outside click / close button) just like in the
 * real app. The dialog auto-reopens whenever any display prop changes so that
 * switching variants in the playground sidebar brings it back without needing
 * a separate "reopen" button. Computes `expiresAt` from an
 * `expiresInSeconds` prop so the variant sidebar can show "Expired" (0) or
 * a specific countdown state.
 * 用本地状态控制弹窗开关；当 platform/code 等 prop 变化时自动重新打开，方便侧边栏切换变体。
 */

import * as React from 'react'
import { PairingCodeDialog } from '../../../components/messaging/PairingCodeDialog'

/** PairingCodeDialogPreviewProps：组件 props 类型定义 */
export interface PairingCodeDialogPreviewProps {
  platform: 'telegram' | 'whatsapp'
  code: string
  expiresInSeconds: number
  botUsername: string
  error: string
}

/** PairingCodeDialogPreview：函数 */
export function PairingCodeDialogPreview({
  platform,
  code,
  expiresInSeconds,
  botUsername,
  error,
}: PairingCodeDialogPreviewProps) {
  // 弹窗是否打开；用户可以通过 ESC、点击外部或关闭按钮关闭。
  const [open, setOpen] = React.useState(true)

  // Reopen on any prop change so switching variants in the sidebar brings
  // the dialog back up after the user has dismissed it.
  // playground 侧边栏切换变体时自动重新打开弹窗。
  React.useEffect(() => {
    setOpen(true)
  }, [platform, code, expiresInSeconds, botUsername, error])

  // Recompute expiresAt when the countdown prop changes so the timer restarts.
  // useMemo 缓存过期时间计算；expiresInSeconds < 0 表示没有过期时间。
  const expiresAt = React.useMemo(() => {
    if (expiresInSeconds < 0) return null
    return Date.now() + expiresInSeconds * 1000
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expiresInSeconds])

  return (
    <>
      {/* 渲染真实配对码弹窗，所有展示 props 来自 playground 变体。 */}
      <PairingCodeDialog
        open={open}
        onOpenChange={setOpen}
        platform={platform}
        code={code || null}
        expiresAt={expiresAt}
        botUsername={botUsername || undefined}
        error={error || undefined}
      />
      {/* 弹窗被关闭后显示提示和重新打开按钮。 */}
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
