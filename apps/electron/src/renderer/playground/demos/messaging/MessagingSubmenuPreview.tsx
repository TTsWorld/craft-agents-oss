/**
 * MessagingSubmenuPreview
 * MessagingSubmenuPreview：会话菜单里“连接消息平台”子菜单的 playground 预览。
 *
 * Renders a focused demo of just the "Connect Messaging" submenu shared with
 * the real SessionMenu. Clicking either branch runs the same code path:
 *   - When the platform is not connected, it opens the WhatsApp connect
 *     dialog (WhatsApp) or toasts (Telegram — playground has no router).
 *   - When connected, it dispatches a pairing dialog via messagingDialogAtom.
 *
 * We mount <MessagingDialogHost /> so the dispatched dialogs actually show
 * up in the preview.
 * 这里挂载了 <MessagingDialogHost />，因此由子菜单派发的弹窗能真正显示出来。
 */

import * as React from 'react'
// react-i18next 的 useTranslation 用于国际化；t('key') 会根据当前语言返回文案。
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  StyledDropdownMenuContent,
} from '../../../components/ui/styled-dropdown'
import { MessagingDialogHost } from '../../../components/messaging/MessagingDialogHost'
import { MessagingSessionMenuItem } from '../../../components/messaging/MessagingSessionMenuItem'
import { playgroundMessagingHandle } from '../../mock-utils'

/** MessagingSubmenuPreviewProps：组件 props 类型定义 */
export interface MessagingSubmenuPreviewProps {
  telegramConnected: boolean
  whatsappConnected: boolean
}

// 演示用的会话 ID，传递给菜单项让它知道当前要为哪个 session 绑定消息平台。
const PLAYGROUND_SESSION_ID = 'playground-session-xyz'

/** MessagingSubmenuPreview：函数 */
export function MessagingSubmenuPreview({
  telegramConnected,
  whatsappConnected,
}: MessagingSubmenuPreviewProps) {
  const { t } = useTranslation()

  // Keep the mock messaging state in sync with the variant props so the
  // connect flow's config check reflects what the preview claims.
  // 把 playground 的连接状态同步到 mock handle，保证菜单内部逻辑看到的连接状态一致。
  React.useEffect(() => {
    playgroundMessagingHandle.setTelegramConnected(
      telegramConnected,
      telegramConnected ? 'Playground Bot' : undefined,
    )
  }, [telegramConnected])

  React.useEffect(() => {
    playgroundMessagingHandle.setWhatsAppConnected(
      whatsappConnected,
      whatsappConnected ? 'Gyula' : undefined,
    )
  }, [whatsappConnected])

  return (
    <div className="flex flex-col items-start gap-4 p-6">
      <div className="text-xs text-muted-foreground">
        Click the button to open the session menu. Hover &ldquo;Connect Messaging&rdquo; for the submenu.
      </div>
      {/* DropdownMenu 是 Radix UI 风格的下拉菜单；asChild 让 Trigger 只渲染子元素而不额外包一层 div。 */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button className="rounded-md border border-border bg-background px-3 py-1.5 text-sm hover:bg-accent">
            Session options
          </button>
        </DropdownMenuTrigger>
        <StyledDropdownMenuContent align="start">
          <MessagingSessionMenuItem
            sessionId={PLAYGROUND_SESSION_ID}
            onTelegramNotConfigured={() => toast.info(t('toast.telegramNotConfiguredOpenSettings'))}
          />
        </StyledDropdownMenuContent>
      </DropdownMenu>
      {/* 弹窗宿主：负责渲染由菜单项内部状态机触发的各类消息弹窗。 */}
      <MessagingDialogHost />
    </div>
  )
}
